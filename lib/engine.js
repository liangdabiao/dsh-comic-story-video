// Python 引擎编排：引擎随包在 engine/（scripts/lib/templates/assets 原样快照），
// 这一层只负责「找 Python、调脚本、后台跑制作、读日志」。
// Windows 坑位记录：
//   - python 可能是 Microsoft Store 的假别名（执行了也不产输出），逐个候选探测；
//   - 子进程输出是 GBK，必须 PYTHONIOENCODING=utf-8 + 明确 encoding 读取；
//   - detached 杀进程要连树杀（taskkill /T），否则 ffmpeg/引擎子进程残留占文件。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync, closeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectError, pidAlive, produceState, produceStateFile, readJsonFile, readStory, resolveDir, writeJson } from './project.js'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENGINE = join(PLUGIN_ROOT, 'engine')
const SCRIPTS = join(ENGINE, 'scripts')
const ANCHOR = join(ENGINE, 'assets', 'reference', '01-style-anchor.png')

const PY_DEPS = [
  { mod: 'whiteboard_animator', name: 'whiteboard-animator（逐笔引擎，含 CRAFT 模型）' },
  { mod: 'PIL', name: 'Pillow（叙事层/线稿净化）' },
  { mod: 'numpy', name: 'numpy' },
  { mod: 'edge_tts', name: 'edge-tts（免费配音兜底）' },
  { mod: 'fontTools', name: 'fonttools（字形预检）' }
]

const childEnv = () => ({
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1'
})

// ---------------------------------------------------------------- Python 解析

let pyCache = null

function tryPython(bin) {
  const r = spawnSync(bin, ['-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
    encoding: 'utf-8', timeout: 15000, windowsHide: true
  })
  if (r.error || r.status !== 0) return null
  const m = String(r.stdout || '').trim().match(/^(\d+)\.(\d+)$/)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major < 3 || (major === 3 && minor < 9)) return null
  return { bin, version: `${major}.${minor}` }
}

export function resolvePython() {
  if (pyCache) return pyCache
  const candidates = [process.env.COMIC_PYTHON, 'python', 'python3', 'py'].filter(Boolean)
  for (const c of candidates) {
    const found = tryPython(c)
    if (found) { pyCache = found; return found }
  }
  return null
}

export function resetPython() { pyCache = null }

// ---------------------------------------------------------------- 依赖体检

function importProbe(bin, mods) {
  const code = mods.map((m) => `import ${m.mod}`).join(';')
  const r = spawnSync(bin, ['-c', code], { encoding: 'utf-8', timeout: 60000, windowsHide: true })
  if (r.status === 0) return { ok: true }
  const err = String(r.stderr || '')
  const missing = mods.filter((m) => new RegExp(`No module named ['"]${m.mod.replace('_', '_')}|${m.mod}`).test(err))
  return { ok: false, stderr: err.slice(-400), missing }
}

export async function doctor({ fix = false } = {}) {
  const report = { python: null, deps: [], ffmpeg: null, apiz: null, anchor: existsSync(ANCHOR), ok: false, notes: [] }
  const py = resolvePython()
  if (!py) {
    report.notes.push('没找到可用的 Python（≥3.9）。装一个或用 COMIC_PYTHON 环境变量指向它。')
    return report
  }
  report.python = py
  const deps = importProbe(py.bin, PY_DEPS)
  report.deps = PY_DEPS.map((d) => ({ ...d, ok: true }))
  if (!deps.ok) {
    if (fix) {
      const targets = PY_DEPS.filter((d) => deps.missing.includes(d.mod))
      if (targets.length) {
        report.notes.push(`正在安装缺失依赖：${targets.map((t) => t.name).join('、')} …`)
        const pkgs = ['whiteboard-animator==0.1.1', 'Pillow>=10.0', 'numpy>=1.24', 'edge-tts>=7.3.0', 'fonttools>=4.40']
        const r = spawnSync(py.bin, ['-m', 'pip', 'install', ...pkgs], { encoding: 'utf-8', timeout: 600000, windowsHide: true })
        const after = importProbe(py.bin, PY_DEPS)
        report.deps = PY_DEPS.map((d) => ({ ...d, ok: after.ok || !deps.missing.includes(d.mod) }))
        if (r.status !== 0) report.notes.push(`pip install 失败：${String(r.stderr || r.stdout || '').slice(-300)}`)
        deps.ok = after.ok
      }
    } else {
      report.deps = PY_DEPS.map((d) => ({ ...d, ok: !deps.missing.includes(d.mod) }))
      report.notes.push('缺依赖。加 fix: true 让插件自动 pip install（whiteboard-animator 会顺带下载 ~83MB 的 CRAFT 模型，第一次较慢）。')
    }
  }

  report.ffmpeg = probeBin('ffmpeg', ['-version'])
  report.apiz = probeBin('apiz', ['--version'])
  report.ok = Boolean(report.python && deps.ok && report.ffmpeg?.ok)
  if (report.ffmpeg?.ok === false) report.notes.push('缺 ffmpeg（要含 libx264 的发行版）。渲染/合成全靠它，装完重试。')
  if (report.apiz?.ok) report.notes.push('apiz CLI 可用：出图（flare 图生图）和配音（MiniMax）都走它；余额用 apiz account balance 看。')
  else report.notes.push('apiz CLI 不可用：出图与配音退回手动/edge-tts，建议安装并登录 apiz。')
  return report
}

function probeBin(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf-8', timeout: 20000, windowsHide: true })
  if (r.error && r.error.code === 'ENOENT') return { ok: false, bin }
  const out = `${r.stdout || ''}\n${r.stderr || ''}`
  const m = out.match(/ffmpeg version (\S+)/) || out.match(/apiz (\S+)/)
  return { ok: r.status === 0 || Boolean(m), bin, version: m ? m[1] : null }
}

// ---------------------------------------------------------------- 脚本调用

// 跑引擎脚本，返回 {code, stdout, stderr}。timeoutMs 到点强杀。
export function runScript(script, args = [], { cwd, timeoutMs = 10 * 60_000 } = {}) {
  const py = resolvePython()
  if (!py) throw new ProjectError('没找到可用的 Python（≥3.9）：先跑 comic_doctor 体检')
  const file = join(SCRIPTS, script)
  if (!existsSync(file)) throw new ProjectError(`引擎缺脚本：${script}`)
  const r = spawnSync(py.bin, [file, ...args], {
    cwd: cwd || PLUGIN_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    env: childEnv()
  })
  if (r.error && r.error.killed) {
    return { code: -1, stdout: r.stdout || '', stderr: (r.stderr || '') + '\n超时被杀' }
  }
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

// ---------------------------------------------------------------- 后台制作

// 进度状态与存活判定在 project.js（详情/面板/阶段判断共用）；这里只管启动与停止。
export { produceState, produceStateFile, pidAlive }

export function startProduce(dir, { quality = 'high', skip = [] } = {}) {
  if (!existsSync(join(dir, 'story.json'))) {
    throw new ProjectError(`这个目录没有 story.json，没东西可做：${dir}`)
  }
  const current = readJsonFile(produceStateFile(dir))
  if (current && current.status === 'running' && pidAlive(current.pid)) {
    throw new ProjectError(`制作已经在跑（PID ${current.pid}，${current.startedAt}），别重复启动；用 status 看进度`)
  }
  const py = resolvePython()
  if (!py) throw new ProjectError('没找到可用的 Python（≥3.9）：先跑 comic_doctor 体检')
  const outDir = join(dir, 'out')
  mkdirSync(outDir, { recursive: true })
  const logFile = join(outDir, 'produce.log')
  const fd = openSync(logFile, 'a')
  closeSync(fd)
  const args = [join(SCRIPTS, 'comic_run.py'), dir, '--quality', quality]
  if (skip.length) args.push('--skip', skip.join(','))
  const child = spawn(py.bin, args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', openSync(logFile, 'a'), openSync(logFile, 'a')],
    env: childEnv(),
    windowsHide: true
  })
  child.unref()
  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    status: 'running',
    quality,
    skip,
    log: 'out/produce.log'
  }
  writeFileSync(produceStateFile(dir), JSON.stringify(state, null, 2))
  return state
}

export function stopProduce(dir) {
  const state = produceState(dir)
  if (!state || state.status !== 'running') return { stopped: false, reason: '没有在跑的制作' }
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { encoding: 'utf-8', windowsHide: true })
      if (r.status !== 0) throw new Error(String(r.stderr || 'taskkill 失败').slice(-200))
    } else {
      process.kill(-state.pid, 'SIGTERM')
    }
  } catch (err) {
    return { stopped: false, reason: String(err.message || err) }
  }
  state.status = 'stopped'
  state.stoppedAt = new Date().toISOString()
  writeFileSync(produceStateFile(dir), JSON.stringify(state, null, 2))
  return { stopped: true }
}

export function readProduceLog(dir, maxBytes = 8000) {
  const file = join(dir, 'out', 'produce.log')
  if (!existsSync(file)) return ''
  try {
    const st = statSync(file)
    const fd = openSync(file, 'r')
    const start = Math.max(0, st.size - maxBytes)
    const buf = Buffer.alloc(st.size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

// ---------------------------------------------------------------- 验收

// verify_media.py 校验产物 + ffmpeg 抽两帧检查帧（第 3 秒、总长 75% 处）。
// 结果写 .verify.json 给面板与流水线阶段判断用。
export function verifyProject(dir, { expect } = {}) {
  const cfg = readStory(dir)
  if (!cfg) throw new ProjectError(`这个目录没有 story.json：${dir}`)
  const output = cfg.output || 'final.mp4'
  const file = join(dir, 'out', output)
  if (!existsSync(file)) throw new ProjectError(`还没有成片：${file}（先 comic_produce）`)

  const args = ['--file', file, '--json']
  if (expect > 0) args.push('--expect', String(Math.round(expect * 10) / 10))
  const r = runScript('verify_media.py', args, { cwd: dir, timeoutMs: 120000 })
  let probe = null
  try { probe = JSON.parse(r.stdout) } catch { /* 老版本没有 --json 就自己量 */ }
  const ok = r.code === 0

  const frames = []
  const checkDir = join(dir, 'check')
  mkdirSync(checkDir, { recursive: true })
  const ff = probeBin('ffmpeg', ['-version'])
  if (ff.ok) {
    let total = expect > 0 ? Number(expect) : (probe && probe.duration) || 0
    if (!total) {
      const d = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf-8', windowsHide: true })
      total = Number(String(d.stdout || '').trim()) || 0
    }
    const spots = [[3, '03.png'], [Math.max(3, total * 0.75), 'mid.png']]
    for (const [at, name] of spots) {
      if (!at) continue
      const out = join(checkDir, name)
      const x = spawnSync('ffmpeg', ['-y', '-ss', String(at), '-i', file, '-vframes', '1', out], { encoding: 'utf-8', windowsHide: true })
      if (x.status === 0 && existsSync(out)) frames.push(`check/${name}`)
    }
  }

  const result = {
    at: new Date().toISOString(),
    ok,
    file: `out/${output}`,
    expect: expect || null,
    duration: (probe && probe.duration) || null,
    hasAudio: (probe && probe.hasAudio) ?? null,
    frames,
    stdout: r.stdout.slice(-2000),
    stderr: r.stderr.slice(-1000)
  }
  writeJson(join(dir, '.verify.json'), result)
  return result
}

export { PLUGIN_ROOT, ENGINE, SCRIPTS, ANCHOR }

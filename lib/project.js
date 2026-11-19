// 项目模型：一个漫画故事片 = 一个目录，story.json 是唯一配置（skill 的约定，不改）。
// 这里只做读取、扫描、汇总——不写 story.json 内容（那是 LLM 按 skill 创作的部分）。
// 工具产物状态（预检报告 / 验收报告 / 制作进度）存进项目目录里的点文件，面板直接展示。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class ProjectError extends Error {}

export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

export function resolveDir(path) {
  const p = String(path || '').trim()
  if (!p) throw new ProjectError('缺少项目路径')
  if (!/^[A-Za-z]:[\\/]|^\//.test(p)) throw new ProjectError('项目路径必须是绝对路径')
  return p
}

export function readStory(dir) {
  const file = join(dir, 'story.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { _error: `story.json 不是合法 JSON：${err.message}` }
  }
}

export function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

export function isProject(dir) {
  return existsSync(join(dir, 'story.json'))
}

// 扫描根目录（最多两层）找含 story.json 的目录
export function listProjects(root) {
  const found = []
  const visit = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (isProject(full)) {
        found.push(full)
      } else if (depth < 2) {
        visit(full, depth + 1)
      }
    }
  }
  visit(root, 1)
  return found.map(projectSummary).filter(Boolean)
}

function artSrc(sc) {
  const src = String(sc.src || `${sc.id || ''}.png`).replace(/\\/g, '/')
  return src.startsWith('raw/') ? src.slice(4) : src
}

// 一个格子在该阶段需要的东西齐了没有——面板步进器和分镜卡都用这份判断
function sceneRow(dir, cfg, sc) {
  const type = sc.type || 'art'
  const row = {
    id: sc.id || '?',
    type,
    narration: sc.narration || '',
    chars: (sc.narration || '').length,
    bubbles: (sc.bubbles || []).map((b) => ({ text: b.text || '', tail: b.tail || null })),
    prompt: sc.prompt || '',
    src: type === 'art' ? `raw/${artSrc(sc)}` : null,
    hasImage: false,
    imageBytes: 0,
    audio: null
  }
  if (type === 'art') {
    const img = join(dir, 'raw', artSrc(sc))
    if (existsSync(img)) {
      row.hasImage = true
      row.imageBytes = statSync(img).size
    }
  } else {
    const chart = join(dir, 'charts', `${sc.chart || sc.id}.png`)
    row.hasImage = existsSync(chart)
    row.src = row.hasImage ? `charts/${sc.chart || sc.id}.png` : null
  }
  for (const ext of ('mp3 wav').split(' ')) {
    const a = join(dir, 'audio', `${row.id}.${ext}`)
    if (existsSync(a)) { row.audio = `audio/${row.id}.${ext}`; break }
  }
  return row
}

// 四步流水线的当前阶段（面板步进器）：故事 → 出图 → 制作 → 验收
function computeStage(dir, cfg, scenes) {
  if (!cfg || cfg._error || !(scenes || []).length) return 0
  const withNarr = scenes.filter((s) => (s.narration || '').trim()).length
  if (withNarr < scenes.length) return 0
  const check = readJsonFile(join(dir, '.check.json'))
  const arts = scenes.filter((s) => (s.type || 'art') === 'art')
  if (arts.length && !arts.every((s) => existsSync(join(dir, 'raw', artSrc(s))))) return 1
  if (arts.length && !(check && check.stage === 'image' && check.ok)) return 1
  const final = join(dir, 'out', cfg.output || 'final.mp4')
  if (!existsSync(final)) return 2
  const verify = readJsonFile(join(dir, '.verify.json'))
  if (!(verify && verify.ok)) return 3
  return 4
}

export function projectSummary(dir) {
  const cfg = readStory(dir)
  if (!cfg) return null
  const scenes = Array.isArray(cfg.scenes) ? cfg.scenes : []
  const arts = scenes.filter((s) => (s.type || 'art') === 'art')
  const doneArts = arts.filter((s) => existsSync(join(dir, 'raw', artSrc(s))))
  const output = cfg.output || 'final.mp4'
  const finalFile = join(dir, 'out', output)
  const updatedAt = (() => {
    try { return statSync(join(dir, 'story.json')).mtime.toISOString() } catch { return null }
  })()
  return {
    path: normalizePath(dir),
    title: cfg.title || '',
    storyLine: cfg.story_line || '',
    question: cfg.question || '',
    answer: cfg.answer || '',
    scenes: scenes.length,
    arts: arts.length,
    doneArts: doneArts.length,
    audio: scenes.filter((s) => existsSync(join(dir, 'audio', `${s.id}.mp3`))).length,
    hasFinal: existsSync(finalFile),
    hasContact: existsSync(join(dir, '_contact.png')),
    stage: computeStage(dir, cfg, scenes),
    updatedAt
  }
}

// 详情：分镜行 + 产物清单 + 预检/验收报告 + 制作状态
export function projectDetail(dir) {
  const cfg = readStory(dir)
  if (!cfg) throw new ProjectError(`这个目录没有 story.json：${dir}`)
  const scenes = Array.isArray(cfg.scenes) ? cfg.scenes : []
  const characters = cfg.characters || {}
  const outDir = join(dir, 'out')
  const output = cfg.output || 'final.mp4'
  const listOut = (sub) => {
    try {
      return readdirSync(sub).filter((f) => !f.startsWith('.')).map((f) => {
        const st = statSync(join(sub, f))
        return { name: f, bytes: st.size, updatedAt: st.mtime.toISOString() }
      })
    } catch { return [] }
  }
  return {
    summary: projectSummary(dir),
    meta: {
      canvas: cfg.canvas || [1080, 1200],
      tts: cfg.tts || {},
      output,
      gap: cfg.gap,
      subtitle: cfg.subtitle || '',
      characters: Object.entries(characters).map(([name, desc]) => ({ name, desc: String(desc) }))
    },
    scenes: scenes.map((sc) => sceneRow(dir, cfg, sc)),
    artifacts: {
      final: existsSync(join(outDir, output)) ? `out/${output}` : null,
      flat: existsSync(join(outDir, 'story_flat.mp4')) ? 'out/story_flat.mp4' : null,
      contact: existsSync(join(dir, '_contact.png')) ? '_contact.png' : null,
      subs: existsSync(join(dir, 'subs.ass')) ? 'subs.ass' : null,
      lineart: existsSync(join(outDir, 'lineart.mp4')) ? 'out/lineart.mp4' : null,
      outFiles: listOut(outDir),
      checkFrames: listOut(join(dir, 'check'))
    },
    check: readJsonFile(join(dir, '.check.json')),
    verify: readJsonFile(join(dir, '.verify.json')),
    produce: readJsonFile(join(dir, '.produce.json'))
  }
}

// 制作进度状态：读 .produce.json，并在「running 但进程已死」时按产物定成败落盘。
// 放在 project.js 是因为详情/面板/阶段判断都要它，engine.js 反过来复用这里（避免环依赖）。
export function produceStateFile(dir) { return join(dir, '.produce.json') }

export function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(Number(pid), 0); return true } catch (err) {
    return err.code === 'EPERM'
  }
}

export function produceState(dir) {
  const state = readJsonFile(produceStateFile(dir))
  if (!state) return null
  if (state.status === 'running' && !pidAlive(state.pid)) {
    // 进程没了：看产物定成败——final.mp4 出来了就是成了，否则按日志尾判
    const cfg = readStory(dir) || {}
    const finalOk = existsSync(join(dir, 'out', cfg.output || 'final.mp4'))
    state.status = finalOk ? 'done' : 'failed'
    if (!finalOk) state.error = '进程退出了但没出 final.mp4，看日志尾定位'
    writeFileSync(produceStateFile(dir), JSON.stringify(state, null, 2))
  }
  return state
}

export { artSrc }

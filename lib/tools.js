// 注册给模型的六个工具。Host 进程执行；Python 引擎随包在 engine/，这里只做编排。
// 分界线：写故事（story.json 的三行头/念白/气泡/出图 prompt）是 LLM 基于随包 skill 的创作，
// 工具只负责预检（拦机械事故）、执行生成与产物校验——和 skill「程序只拦跑不起来的事故」一致。
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANCHOR, doctor, produceState, readProduceLog, runScript, startProduce, stopProduce, verifyProject
} from './engine.js'
import { collectProjects, listProjects, projectDetail, ProjectError, readStory, resolveDir, writeJson } from './project.js'
import { rememberProject, readSettings } from './store.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE = join(ROOT, 'engine', 'templates', 'comic', 'story.example.json')

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const bool = (description) => ({ type: 'boolean', description })
const arr = (description) => ({ type: 'array', description, items: { type: 'string' } })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      data: { type: 'string' }
    }
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary)
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

function failSummary(err) {
  return err instanceof ProjectError ? err.message : String((err && err.message) || err)
}

function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new ProjectError(`缺少 ${key}`)
  return value.trim()
}

function failWithOutput(r, label) {
  const out = `${r.stdout}\n${r.stderr}`.trim()
  return result(false, `${label}（退出码 ${r.code}）`, out.slice(-6000))
}

// ---------------------------------------------------------------- 工具 1：项目

const projectTool = {
  name: 'comic_project',
  description: '漫画故事片场项目入口：建项目（拷 story.json 模板）、读项目全部状态（分镜/图/音/成片/预检验收报告）、查后台制作进度与日志、按根目录列项目。所有 path 都要绝对路径。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('init 建项目（拷 story.json 模板）；read 读项目全部状态；status 查制作进度+日志尾；list 列项目', { enum: ['init', 'read', 'status', 'list'] }),
      path: str('项目目录绝对路径（init 时可尚不存在）'),
      root: str('list 时扫描的父目录绝对路径'),
      title: str('片名（仅 init 时记录到输出里，story.json 的 title 由你按 skill 写）')
    }
  },
  timeoutMs: 60_000,
  output: OUTPUT,
  async execute(args) {
    const action = requireString(args, 'action')
    try {
      if (action === 'init') {
        const dir = resolveDir(requireString(args, 'path'))
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const storyFile = join(dir, 'story.json')
        const fresh = !existsSync(storyFile)
        if (fresh) cpSync(TEMPLATE, storyFile)
        mkdirSync(join(dir, 'raw'), { recursive: true })
        rememberProject(dir)
        const cfg = readStory(dir)
        return result(true, fresh
          ? `项目建好：${dir}（已放入 story.json 模板和 raw/）`
          : `项目已存在：${dir}（story.json 保留原样，没有覆盖）`, [
          '下一步：',
          '1. 按 skill 写 story.json：先填 story_line / question / answer 三行头，填不出来就别写格子；念白 440–540 字按 4.0 字/秒反算；先读 references/example.md 的八格范例。',
          '2. 写完跑 comic_check（stage: script）——它只查「跑不跑得起来」，好坏要你自己连读自查。',
          `当前 title 字段：${(cfg && cfg.title) || '（未填）'}`
        ].join('\n'))
      }

      if (action === 'read') {
        const dir = resolveDir(requireString(args, 'path'))
        const detail = projectDetail(dir)
        const s = detail.summary
        const lines = [
          `「${s.title || '（未填 title）'}」 阶段：${['写故事', '出图', '制作', '验收', '完成'][s.stage]}`,
          `story_line：${s.storyLine || '（未填）'}`,
          `分镜 ${s.scenes} 格（线稿 ${s.doneArts}/${s.arts} 已出图，配音 ${s.audio}/${s.scenes}）`,
          s.hasFinal ? `成片：${detail.artifacts.final}` : '成片：还没出',
          detail.produce ? `制作：${detail.produce.status}（${detail.produce.startedAt}）` : '制作：没跑过'
        ]
        return result(true, lines.join('\n'), JSON.stringify(detail, null, 2))
      }

      if (action === 'status') {
        const dir = resolveDir(requireString(args, 'path'))
        const state = produceState(dir)
        if (!state) return result(true, '这个项目没跑过制作（comic_produce action=start 启动）')
        const cfg = readStory(dir) || {}
        const finalOk = existsSync(join(dir, 'out', cfg.output || 'final.mp4'))
        const head = `制作 ${state.status}（${state.startedAt} 启动，quality=${state.quality}）`
        const tail = readProduceLog(dir)
        return result(true, finalOk && state.status !== 'running' ? `${head} —— 成片已产出` : head, tail || '（日志还是空的）')
      }

      // list：给了 root 就按目录扫，没给就把台账 + 默认目录里的片子都列出来
      const root = args.root && String(args.root).trim() ? resolveDir(args.root) : ''
      const list = root ? listProjects(root) : collectProjects()
      if (!list.length) {
        return result(true, root
          ? `${root} 下没找到项目（找含 story.json 的目录，最多下探两层）`
          : '还没有作品。用 action=init 建一个，或让用户在面板「新建漫画片」里填个主题。')
      }
      const where = root || readSettings().outputRoot || '作品台账'
      return result(true, `找到 ${list.length} 个项目（${where}）`, list.map((p) =>
        `「${p.title || '未填'}」 ${p.path}  分镜${p.scenes} 图${p.doneArts}/${p.arts} ${(p.final || p.hasFinal) ? '有成片' : '无成片'}`).join('\n'))
    } catch (err) {
      return result(false, failSummary(err))
    }
  }
}

// ---------------------------------------------------------------- 工具 2：预检

const checkTool = {
  name: 'comic_check',
  description: '漫画片预检（只查「跑不跑得起来」，不判文案好坏）：script 查文件与字段（story.json 可读/每格有念白/art 格有 src 和 prompt/气泡不出画/角色占位已定义）；image 查图在不在、是否空白或整片涂黑（废片门禁）；render 查渲染参数事实（不阻断）。❌ 修完再往下走。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'stage'],
    properties: {
      path: str('项目目录绝对路径'),
      stage: str('script 出图前 / image 渲染前 / render 合成前（不阻断）/ all 三段全跑', { enum: ['script', 'image', 'render', 'all'] })
    }
  },
  timeoutMs: 5 * 60_000,
  output: OUTPUT,
  async execute(args) {
    try {
      const dir = resolveDir(requireString(args, 'path'))
      const stage = requireString(args, 'stage')
      const stages = stage === 'all' ? ['script', 'image', 'render'] : [stage]
      const outputs = []
      const pass = {}
      let ok = true
      for (const s of stages) {
        const r = runScript('pipeline.py', [dir, '--stage', s], { cwd: dir, timeoutMs: 4 * 60_000 })
        pass[s] = r.code === 0
        outputs.push(`══ ${s}：${pass[s] ? '通过' : '没过'} ══\n${(r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim()}`)
        if (!pass[s] && s !== 'render') ok = false
      }
      // .check.json 记最后一道阻断段的结论；render 不阻断，不覆盖前面的结论
      const blocking = stages.filter((s) => s !== 'render')
      if (blocking.length) {
        writeJson(join(dir, '.check.json'), {
          at: new Date().toISOString(),
          stage: blocking[blocking.length - 1],
          ok: blocking.every((s) => pass[s]),
          report: outputs.join('\n\n').slice(0, 20000)
        })
      }
      return result(ok, ok ? '预检通过，可以往下走' : '预检没过——❌ 的都是会让流程中途崩或产出废片的事故，修完再继续', outputs.join('\n\n'))
    } catch (err) {
      return result(false, failSummary(err))
    }
  }
}

// ---------------------------------------------------------------- 工具 3：出图清单

const promptsTool = {
  name: 'comic_prompts',
  description: '出图清单：打印还没出图的分镜的完整出图 prompt（已出图且 prompt 指纹没变的自动跳过，防重复花钱），并给出风格锚点图路径与 apiz flare 图生图的完整命令模板。出图是全链路最花钱的一步，先 comic_check（stage: script）过绿再出。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: str('项目目录绝对路径'),
      showDone: bool('已出图的格子也重新打印（默认只打没出过的）'),
      noGate: bool('跳过文案门禁硬出（不建议——文案没定稿就出图是最贵的返工）')
    }
  },
  timeoutMs: 2 * 60_000,
  output: OUTPUT,
  async execute(args) {
    try {
      const dir = resolveDir(requireString(args, 'path'))
      const cmdArgs = [dir, '--list']
      if (args.showDone) cmdArgs.push('--show-done')
      if (args.noGate) cmdArgs.push('--no-gate')
      const r = runScript('comic_gen.py', cmdArgs, { cwd: dir, timeoutMs: 90_000 })
      if (r.code !== 0) {
        return failWithOutput(r, '出图清单没拿出来（多半是文案门禁没过）')
      }
      const guide = [
        '出图纪律：',
        `- 必须图生图，参考图（风格锚点）：${ANCHOR}`,
        '- 相似度/input_fidelity 调 low（调高会照抄参考图的姿势）',
        '- apiz flare 命令模板：',
        '  apiz upload <锚点图>        # 先拿 CDN URL',
        '  apiz generate "<完整prompt>" --model apiz/gpt-image-2.5-flare --aspect-ratio 1:1 \\',
        '    --params \'{"reference_image_urls":["<锚点URL>"],"quality":"low","size":"1K"}\' --wait --json',
        '- 结果在返回 JSON 的 result.images[0].url，下载后按 story.json 的 src 存进项目 raw/',
        '- prompt 里的 {角色名} 已自动展开，一张别手抄节选'
      ].join('\n')
      return result(true, `出图清单出来了（引擎会记指纹台账，出过的自动跳过）`, `${r.stdout.trim()}\n\n${guide}`)
    } catch (err) {
      return result(false, failSummary(err))
    }
  }
}

// ---------------------------------------------------------------- 工具 4：制作

const produceTool = {
  name: 'comic_produce',
  description: '后台制作一条漫画片：配音（apiz speak，edge-tts 兜底）→ 气泡层/信息图 → 净化落版 → 逐笔渲染（最慢，几分钟）→ 合成竖屏烧字幕。start 后立刻返回，用 comic_project action=status 轮询；stop 连树杀进程。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'path'],
    properties: {
      action: str('start 启动 / stop 停止 / log 看日志尾', { enum: ['start', 'stop', 'log'] }),
      path: str('项目目录绝对路径'),
      quality: str('渲染质量，默认 high（low 快但糊）', { enum: ['low', 'medium', 'high'] }),
      skip: arr('要跳过的步骤（tts,layers,boards,render,finish 逗号分隔）')
    }
  },
  timeoutMs: 120_000,
  output: OUTPUT,
  async execute(args) {
    try {
      const dir = resolveDir(requireString(args, 'path'))
      const action = requireString(args, 'action')
      if (action === 'start') {
        const state = startProduce(dir, {
          quality: ['low', 'medium', 'high'].includes(args.quality) ? args.quality : 'high',
          skip: Array.isArray(args.skip) ? args.skip.map(String) : []
        })
        return result(true, `制作已启动（PID ${state.pid}，${state.startedAt}）。逐笔渲染那步要几分钟，用 comic_project action=status 轮询；结束后 comic_verify 验收。`, '顺序：tts → layers → boards → render → finish。音频实测时长决定整片节奏。')
      }
      if (action === 'stop') {
        const r = stopProduce(dir)
        return result(r.stopped, r.stopped ? '已停止（连树杀）' : `没停成：${r.reason}`)
      }
      const tail = readProduceLog(dir, 12000)
      return tail ? result(true, '日志尾如下', tail) : result(true, '还没有日志（没跑过制作）')
    } catch (err) {
      return result(false, failSummary(err))
    }
  }
}

// ---------------------------------------------------------------- 工具 5：验收

const verifyTool = {
  name: 'comic_verify',
  description: '产物校验（probe-first → 可解码 → 时长对得上 → 有音轨）并抽两帧检查帧（第 3 秒、总长 75% 处）到 check/。抽帧结果要你肉眼看：画面在动吗、底色对不对、字幕有没有出画；再把音轨单独听：能说出「谁想要什么、发生了哪几件事、最后怎么收」才算过。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: str('项目目录绝对路径'),
      expect: num('预期时长（秒），用来卡「时长对得上」；不填只查可解码+音轨')
    }
  },
  timeoutMs: 3 * 60_000,
  output: OUTPUT,
  async execute(args) {
    try {
      const dir = resolveDir(requireString(args, 'path'))
      const r = verifyProject(dir, { expect: Number(args.expect) > 0 ? Number(args.expect) : 0 })
      const lines = [
        r.ok ? '校验通过' : '校验没过——任何一项失败都别静默继续',
        r.duration ? `时长 ${r.duration}s${r.expect ? `（预期 ${r.expect}s）` : ''}` : '',
        r.hasAudio === false ? '⚠️ 没有音轨' : '',
        r.frames.length ? `检查帧：${r.frames.join('、')}（项目 check/ 下，用读图工具看）` : '检查帧没抽出来'
      ].filter(Boolean)
      return result(r.ok, lines.join('；'), (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim().slice(-3000))
    } catch (err) {
      return result(false, failSummary(err))
    }
  }
}

// ---------------------------------------------------------------- 工具 6：环境体检

const doctorTool = {
  name: 'comic_doctor',
  description: '环境体检：Python（≥3.9）与五个依赖（whiteboard-animator 逐笔引擎/Pillow/numpy/edge-tts/fonttools）、ffmpeg、apiz CLI、风格锚点图。fix: true 自动 pip install 缺失依赖（首次会下载 ~83MB 的 CRAFT 模型）。第一次用、或制作/渲染报错时先跑这个。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {
      fix: bool('自动安装缺失的 Python 依赖（默认只查不装）')
    }
  },
  timeoutMs: 12 * 60_000,
  output: OUTPUT,
  async execute(args) {
    try {
      const r = await doctor({ fix: Boolean(args.fix) })
      const lines = [
        r.python ? `Python ${r.python.version}（${r.python.bin}）✓` : 'Python ≥3.9 ✗',
        ...r.deps.map((d) => `${d.name} ${d.ok ? '✓' : '✗'}`),
        r.ffmpeg?.ok ? `ffmpeg ${r.ffmpeg.version || ''} ✓` : 'ffmpeg ✗',
        r.apiz?.ok ? `apiz CLI ${r.apiz.version || ''} ✓` : 'apiz CLI ✗（出图与配音走它；edge-tts 免费兜底腔调平）',
        r.anchor ? '风格锚点图 ✓' : '风格锚点图缺失 ✗',
        ...r.notes.map((n) => `· ${n}`)
      ]
      return result(r.ok, r.ok ? '环境齐了，可以开工' : '环境没齐——上面的 ✗ 照 notes 补，或 fix: true 让我装', lines.join('\n'))
    } catch (err) {
      return result(false, failSummary(err))
    }
  }
}

export const TOOLS = [projectTool, checkTool, promptsTool, produceTool, verifyTool, doctorTool]

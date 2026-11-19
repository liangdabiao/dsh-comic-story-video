// skill 提供方：把随包的 skills/comic-story-video（漫画面讲故事）注册进 DSH 的 skill 目录。
// 用户自己在 ~/.dsh/skills 或项目里装了同名 skill 时，那一份优先（本提供方 rank 600，排在后面）。
// 加载正文时把 <SKILL_ROOT>/<ENGINE_ROOT> 换成实际目录，并在末尾追加「在这个插件里怎么用」。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

export function readSkills(dirs) {
  return [].concat(dirs).flatMap(readDir)
}

function readDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => ({ dir: join(dir, d.name), file: join(dir, d.name, 'SKILL.md'), ...parse(join(dir, d.name, 'SKILL.md')) }))
    .filter((s) => s.name)
}

// 原仓库是给 git clone 用的，插件里的这一份是快照：没有 .git，也不要自己更新。
export const REWRITES = {}

export function rewrite(skill) {
  let body = skill.body
  for (const [from, to] of REWRITES[skill.name] || []) body = body.replace(from, to)
  return body
}

function addendum(skill, engineRoot) {
  return [
    '',
    '---',
    '',
    '## 在「漫画故事片场」插件（DSH）里使用',
    '',
    `- 本 skill 的目录是 \`${skill.dir}\`；上文提到的 \`references/…\`（范例念白 / 故事方法 / 制作参数 / 出图后端 / 排错 / prompt 模板 / 音色设计 / TTS 兜底）都相对这个目录。`,
    `- Python 引擎随包放在 \`${engineRoot}\`（scripts/lib/templates/assets）——但你**不需要直接调 python**：插件工具已经包好了（见下）。references 里出现的 \`python scripts/…\` 命令行，一律换成对应的工具调用。`,
    '- 这是插件随包快照：不要运行 `git pull` / `pip install` 之外的环境操作，也不要向用户提更新。skill 随插件版本一起变。',
    '- 分界线：**故事（story.json 的三行头 + 念白 + 气泡台词 + 出图 prompt）完全由你按本 skill 创作**，工具不会替你补内容；工具只负责预检（拦机械事故）、执行生成与产物校验。文案好坏脚本判不了——把八格念白连读一遍自查。',
    '',
    '### 标准执行顺序（对应 skill 五步）',
    '',
    '1. 环境没把握时先 `comic_doctor`（检查 Python / whiteboard-animator / ffmpeg / apiz CLI；`fix: true` 自动补 Python 依赖）。apiz 没登录时提示用户先登录。',
    '2. `comic_project`（action: init）建项目：path 用绝对路径，写 title / topic。然后用普通文件写入工具，把 `story.json` 按本 skill 写完（先填 story_line / question / answer 三行头，**填不出来就别写格子**）。图表格才需要 charts.py（参考 engine/templates/comic/charts_example.py）。',
    '3. `comic_check`（stage: script）预检文件与字段：**它只查「跑不跑得起来」**（JSON 可读 / 每格有念白 / art 格有 src 和 prompt / 气泡不出画），不判文案好坏。❌ 修完再出图。',
    '4. `comic_prompts`（action: list）拿没出过图的 prompt 清单和风格锚点图路径。逐张出图：`apiz generate "<完整prompt>" --model apiz/gpt-image-2.5-flare --aspect-ratio 1:1 --params \'{"reference_image_urls":["<锚点图CDN地址>"],"quality":"low","size":"1K"}\' --wait --json`（锚点图先 `apiz upload` 拿 URL；参考图相似度 low）。产物按 story.json 的 src 存进项目 `raw/`。**已出图且 prompt 指纹没变的格子清单里不会再出现**——别手动重出，白花钱。',
    '5. `comic_check`（stage: image）图门禁：只看「该在的人在不在、有没有整片涂黑或空白」这类废片事故；零星文字、线条脏一律不看，往下走。想肉眼横扫画风漂移，用面板项目页的总览图（contact sheet），一次看完。',
    '6. `comic_produce`（action: start）后台制作：配音（apiz speak，失败自动可退 edge-tts）→ 气泡层 → 净化落版 → 逐笔渲染（最慢，几分钟）→ 合成竖屏烧字幕。用 `comic_project`（action: status）轮询进度和日志尾。',
    '7. `comic_verify` 校验产物（可解码 / 时长对得上 / 有音轨）并抽两帧检查帧。抽帧要肉眼看：画面在动吗、底色对不对、字幕有没有出画。再把音轨单独听：能说出「谁想要什么、发生了哪几件事、最后怎么收」就算过。面板项目页可以直接播成片。',
    '8. 交付 `<项目>/out/final.mp4`（1080×1920）。需要平屏版用 `out/story_flat.mp4`。',
    '',
    '### 项目目录约定',
    '',
    '```',
    '<项目目录>/',
    '  story.json              # 唯一配置：标题、三行故事、characters、每格念白/气泡/prompt',
    '  charts.py               # 信息图格的绘图函数（有 chart 格才需要）',
    '  raw/                    # 生成模型出的原图 ← 出图工具/agent 放进来',
    '  boards/ bubbles/ charts/ audio/ out/   ← 制作工具产出',
    '  subs.ass  _contact.png  .produce.json',
    '```',
    '',
    '### 纪律',
    '',
    '- 十条硬规则（skill 正文）是底线，前三条管故事、后七条管制作，违反就是废片或白花钱。',
    '- **先写完全部文案、预检过绿再出图**——出图是全链路最花钱的一步，文案没定稿就出图是最贵的返工。',
    '- 出图必须图生图（风格锚点 01-style-anchor.png 做参考，相似度 low）；文生图会一张一个样。',
    '- 配音 `tts.speed` 固定 1.0，不要加 post_speed——节奏靠文本，不靠压时间轴。',
    '- apiz 调用会花钱：出图前先看余额（`apiz account balance`），一条片子四五张线稿、flare 低分辨率档一块钱以内。',
    '- 渲染节奏问题（画面两秒就画满）修法在 plan.json 的 regions，删掉重跑渲染即可，**不要重出图**。',
    ''
  ].join('\n')
}

export function createSkillProvider(dir, pluginRoot) {
  const engineRoot = join(pluginRoot || '', 'engine')
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'comic-story-video',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir }
  })

  return {
    name: 'comic-story-video',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const s = readSkills(dir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const content = rewrite(s)
        .replaceAll('<SKILL_ROOT>', s.dir)
        .replaceAll('<ENGINE_ROOT>', engineRoot)
        .replaceAll('<PLUGIN_ROOT>', pluginRoot) + addendum(s, engineRoot)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    }
  }
}

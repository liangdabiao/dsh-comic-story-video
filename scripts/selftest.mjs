// 数据层冒烟：不建项目产物、不花积分，验证 skill 快照 / 引擎随包完整 / 工具注册形状 / client 模块。
// 运行：node scripts/selftest.mjs
import { existsSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'csv-smoke-'))

let failed = 0
const step = (name, fn) => Promise.resolve()
  .then(fn)
  .then((out) => { console.log(`- ${name} … ok${out ? `（${out}）` : ''}`) })
  .catch((err) => { failed += 1; console.log(`- ${name} … 失败：${err.message}`) })

// ---------------------------------------------------------------- 包完整性

await step('引擎随包（scripts/lib/templates/assets）', () => {
  const need = [
    'engine/scripts/pipeline.py', 'engine/scripts/comic_gen.py', 'engine/scripts/comic_run.py',
    'engine/scripts/comic_tts.py', 'engine/scripts/comic_layers.py', 'engine/scripts/comic_boards.py',
    'engine/scripts/comic_finish.py', 'engine/scripts/render_explainer.py', 'engine/scripts/verify_media.py',
    'engine/scripts/contact_sheet.py', 'engine/scripts/ink_probe.py', 'engine/scripts/self_test.py',
    'engine/lib/comic_layer.py', 'engine/lib/lineart_clean.py', 'engine/lib/story_util.py', 'engine/lib/theme.py', 'engine/lib/lib_agnes.py',
    'engine/templates/comic/story.example.json',
    'engine/assets/reference/01-style-anchor.png',
    'engine/assets/fonts/MaShanZheng-Regular.ttf'
  ]
  const missing = need.filter((f) => !existsSync(join(ROOT, f)))
  if (missing.length) throw new Error(`缺：${missing.join('、')}`)
  return `${need.length} 件齐全`
})

await step('skill 快照（SKILL.md + 8 份 references）', () => {
  const dir = join(ROOT, 'skills', 'comic-story-video')
  const refs = readdirSync(join(dir, 'references'))
  if (refs.length < 8) throw new Error(`references 只有 ${refs.length} 份`)
  const md = existsSync(join(dir, 'SKILL.md'))
  if (!md) throw new Error('缺 SKILL.md')
  return `${refs.length} 份 references`
})

// ---------------------------------------------------------------- skill provider

const { createSkillProvider } = await import('../lib/skills.js')

await step('skill provider：list/get 走通，addendum 带工具流', async () => {
  const provider = createSkillProvider([join(ROOT, 'skills')], ROOT)
  const list = await provider.list()
  if (!list.length) throw new Error('list 为空')
  const s = await provider.get({ name: list[0].name, locator: list[0].locator })
  if (!s || !s.content) throw new Error('get 没拿到正文')
  if (!s.content.includes('comic_prompts')) throw new Error('addendum 没带工具流')
  if (s.content.includes('<SKILL_ROOT>') || s.content.includes('<ENGINE_ROOT>')) throw new Error('占位符没替换干净')
  return s.content.length + ' 字'
})

// ---------------------------------------------------------------- 工具注册形状

const { TOOLS } = await import('../lib/tools.js')

await step('六个工具：name/description/parameters/output({schema,render})', () => {
  const names = TOOLS.map((t) => t.name).join(',')
  const expect = ['comic_project', 'comic_check', 'comic_prompts', 'comic_produce', 'comic_verify', 'comic_doctor']
  for (const n of expect) if (!TOOLS.some((t) => t.name === n)) throw new Error(`缺 ${n}（注册的是 ${names}）`)
  for (const t of TOOLS) {
    if (!t.parameters || typeof t.execute !== 'function') throw new Error(`${t.name} 缺 parameters/execute`)
    if (!t.output || !t.output.schema || typeof t.output.render !== 'function') throw new Error(`${t.name} output 必须 {schema, render}——否则宿主拒载`)
  }
  return names
})

// ---------------------------------------------------------------- index.js 形状

await step('index.js：export name/inject/apply', async () => {
  const mod = await import('../index.js')
  if (mod.name !== 'comic-story-video') throw new Error(`name=${mod.name}`)
  for (const key of ['webServer', 'skills', 'tools']) if (!mod.inject.includes(key)) throw new Error(`inject 缺 ${key}`)
  if (typeof mod.apply !== 'function') throw new Error('缺 apply')
})

// ---------------------------------------------------------------- 真引擎（本机有 Python 就跑，零积分）

await step('真引擎：comic_check（script 段）对模板项目给出结构化结论', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_project')
  const check = TOOLS.find((t) => t.name === 'comic_check')
  const dir = join(tmpdir(), 'csv-smoke-proj')
  const r1 = await tool.execute({ action: 'init', path: dir })
  if (!r1.ok) throw new Error(r1.summary)
  // 模板里 scenes 只有 3 格且是示意内容，预检多半会拦——这里只验证「跑得完、结论结构化」
  const r2 = await check.execute({ path: dir, stage: 'script' })
  if (typeof r2.ok !== 'boolean' || !r2.data) throw new Error('结论不结构化')
  return r2.ok ? '模板直接过' : '按预期拦截（模板是示意文案）'
})

await step('环境体检（doctor）', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_doctor')
  const r = await tool.execute({})
  const python = r.data.includes('Python')
  if (!python) throw new Error('体检输出缺 Python 段')
  return r.ok ? '全绿' : '未全绿（看体检输出补依赖）'
})

if (failed) {
  console.error(`\n${failed} 步失败`)
  process.exit(1)
}
console.log('\n冒烟通过')

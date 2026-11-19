// 数据层单测（离线，零积分；制作启动类用例只在环境安全时跑）。
// 运行：node test/lib.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// store.js 在 import 时读 DSH_HOME，必须先定到临时目录
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'csv-test-'))

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const { artSrc, listProjects, projectDetail, projectSummary, ProjectError, readStory, resolveDir } = await import('../lib/project.js')
const { rememberProject, readSettings, writeSettings } = await import('../lib/store.js')
const { readProduceLog, produceState, pidAlive, stopProduce, verifyProject } = await import('../lib/engine.js')
const { TOOLS } = await import('../lib/tools.js')

let passed = 0
const test = (name, fn) => {
  const p = fn && typeof fn.then === 'function' ? fn.then(() => { passed += 1; console.log(`✓ ${name}`) }) : Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`✓ ${name}`) })
  return p.catch((err) => { console.error(`✗ ${name}`); console.error(err); process.exit(1) })
}

const T = mkdtempSync(join(tmpdir(), 'csv-fixtures-'))

// 样例 story.json：三格（两 art 一 chart），角色占位、气泡带 tail
const STORY = {
  story_line: '一个上门推销的年轻人，想让一屋子已经打算投降的人点头',
  question: '一个人怎么让一整国闭嘴？',
  answer: '他把每个人的话翻译成他们心里的怕',
  title: '舌战群儒',
  canvas: [1080, 1200],
  characters: { zhugeliang: '软布巾年轻文士' },
  tts: { engine: 'apiz', speed: 1.0 },
  output: 'final.mp4',
  scenes: [
    { id: 's1', type: 'art', src: 'g1.png', narration: '一个人，一把扇子，站在人家客厅正中间。', prompt: '画面左侧站着{zhugeliang}', bubbles: [{ text: '哪来的？', tail: [265, 372] }] },
    { id: 's2', type: 'chart', chart: 'chart_s2', narration: '先看账。曹操二十多万，孙权三万。' },
    { id: 's3', type: 'art', src: 'g3.png', narration: '第一个上的是张昭。', prompt: '画面中间偏左站着{zhugeliang}' }
  ]
}

function makeProject(name) {
  const dir = join(T, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'story.json'), JSON.stringify(STORY, null, 2), 'utf8')
  return dir
}

// ---------------------------------------------------------------- resolveDir / readStory

await test('resolveDir：相对路径与空值都拒绝', () => {
  assert.throws(() => resolveDir(''), ProjectError)
  assert.throws(() => resolveDir('out/my-story'), ProjectError)
  assert.equal(resolveDir('D:\\a\\b'), 'D:\\a\\b')
})

await test('readStory：坏 JSON 不炸，带 _error 回来', () => {
  const dir = makeProject('bad-json')
  writeFileSync(join(dir, 'story.json'), '{oops', 'utf8')
  const cfg = readStory(dir)
  assert.match(cfg._error, /不是合法 JSON/)
})

await test('artSrc：raw/ 前缀与反斜杠都归一', () => {
  assert.equal(artSrc({ src: 'raw/g1.png' }), 'g1.png')
  assert.equal(artSrc({ src: 'a\\b.png', id: 'x' }), 'a/b.png')
  assert.equal(artSrc({ id: 's9' }), 's9.png')
})

// ---------------------------------------------------------------- 阶段推进（流水线 UX 的核心）

await test('projectSummary 阶段 0：没填念白', () => {
  const dir = makeProject('stage0')
  writeFileSync(join(dir, 'story.json'), JSON.stringify({ ...STORY, scenes: [{ id: 's1', type: 'art', narration: '', prompt: 'x', src: 'g1.png' }] }), 'utf8')
  assert.equal(projectSummary(dir).stage, 0)
})

await test('projectSummary 阶段 1：念白齐、图没出齐', () => {
  const dir = makeProject('stage1')
  mkdirSync(join(dir, 'raw'))
  writeFileSync(join(dir, 'raw', 'g1.png'), 'png', 'utf8')
  assert.equal(projectSummary(dir).stage, 1)
  assert.equal(projectSummary(dir).doneArts, 1)
})

await test('projectSummary 阶段 1→2：图齐但没过图门禁 / 过了进制作', () => {
  const dir = makeProject('stage1b')
  mkdirSync(join(dir, 'raw'))
  writeFileSync(join(dir, 'raw', 'g1.png'), 'png')
  writeFileSync(join(dir, 'raw', 'g3.png'), 'png')
  // 图齐但 image 门禁没跑：还停在出图
  assert.equal(projectSummary(dir).stage, 1)
  writeFileSync(join(dir, '.check.json'), JSON.stringify({ stage: 'image', ok: true }), 'utf8')
  assert.equal(projectSummary(dir).stage, 2)
})

await test('projectSummary 阶段 2→3→4：成片出来进验收，验收过才算完成', () => {
  const dir = makeProject('stage2')
  mkdirSync(join(dir, 'raw'), { recursive: true })
  writeFileSync(join(dir, 'raw', 'g1.png'), 'p')
  writeFileSync(join(dir, 'raw', 'g3.png'), 'p')
  writeFileSync(join(dir, '.check.json'), JSON.stringify({ stage: 'image', ok: true }), 'utf8')
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'out', 'final.mp4'), 'mp4')
  assert.equal(projectSummary(dir).stage, 3)
  writeFileSync(join(dir, '.verify.json'), JSON.stringify({ ok: true }), 'utf8')
  assert.equal(projectSummary(dir).stage, 4)
})

await test('projectDetail：分镜行带图/音/气泡，产物清单齐', () => {
  const dir = makeProject('detail')
  mkdirSync(join(dir, 'raw'), { recursive: true })
  writeFileSync(join(dir, 'raw', 'g1.png'), 'p')
  mkdirSync(join(dir, 'audio'))
  writeFileSync(join(dir, 'audio', 's1.mp3'), 'mp3')
  const d = projectDetail(dir)
  assert.equal(d.scenes.length, 3)
  assert.equal(d.scenes[0].hasImage, true)
  assert.equal(d.scenes[0].audio, 'audio/s1.mp3')
  assert.equal(d.scenes[0].bubbles[0].text, '哪来的？')
  assert.equal(d.scenes[1].type, 'chart')
  assert.equal(d.scenes[1].src, null)
  assert.equal(d.meta.characters[0].name, 'zhugeliang')
  assert.equal(d.artifacts.final, null)
  assert.equal(d.summary.stage, 1)
})

await test('listProjects：两层内找 story.json，跳过点目录', () => {
  const root = join(T, 'scan')
  const p1 = makeProject('scan/甲')
  const p2 = makeProject('scan/子/乙')
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, '.hidden', 'story.json'), '{}')
  const list = listProjects(root)
  const paths = list.map((p) => p.path)
  assert.ok(paths.some((p) => p.endsWith('甲')), p1)
  assert.ok(paths.some((p) => p.endsWith('乙')), p2)
  assert.equal(list.length, 2)
})

await test('projectDetail：没有 story.json 报 ProjectError', () => {
  const dir = join(T, 'empty')
  mkdirSync(dir)
  assert.throws(() => projectDetail(dir), ProjectError)
})

// ---------------------------------------------------------------- store

await test('store：roots 增删 + rememberProject 去重', () => {
  writeSettings({ roots: [] })
  const dir = makeProject('remembered')
  rememberProject(dir)
  rememberProject(dir) // 再记一次不重复
  const s = readSettings()
  assert.equal(s.roots.filter((r) => r.replace(/[\\/]+$/, '').endsWith('remembered')).length, 1)
  assert.equal(s.lastRoot.replace(/[\\/]+$/, '').endsWith('remembered'), true)
})

// ---------------------------------------------------------------- engine（不依赖 Python 的部分）

await test('produceState：没跑过返回 null', () => {
  assert.equal(produceState(makeProject('no-produce')), null)
})

await test('pidAlive：假 pid 与 0 号都不算活', () => {
  assert.equal(pidAlive(999999999), false)
  assert.equal(pidAlive(undefined), false)
})

await test('stopProduce：没在跑就直说', () => {
  const r = stopProduce(makeProject('no-stop'))
  assert.equal(r.stopped, false)
  assert.match(r.reason, /没有在跑的制作/)
})

await test('readProduceLog：缺文件返回空串', () => {
  assert.equal(readProduceLog(makeProject('no-log')), '')
})

await test('verifyProject：没成片直接给结论，不静默', () => {
  const dir = makeProject('no-final')
  assert.throws(() => verifyProject(dir), /还没有成片/)
})

await test('verifyProject：没有 story.json 也给结论', () => {
  const dir = join(T, 'no-story')
  mkdirSync(dir)
  assert.throws(() => verifyProject(dir), /没有 story\.json/)
})

// ---------------------------------------------------------------- tools

await test('六个工具都带 {schema, render} 输出（宿主拒载的坑）', () => {
  assert.equal(TOOLS.length, 6)
  for (const t of TOOLS) {
    assert.ok(t.output && t.output.schema && typeof t.output.render === 'function', t.name)
    assert.ok(t.description.length > 20, t.name)
  }
})

await test('comic_project init：拷模板建 raw/，不覆盖已有 story.json', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_project')
  const dir = join(T, 'tool-init')
  const r1 = await tool.execute({ action: 'init', path: dir })
  assert.equal(r1.ok, true)
  assert.ok(existsSync(join(dir, 'story.json')))
  assert.ok(existsSync(join(dir, 'raw')))
  const before = readStory(dir).story_line
  writeFileSync(join(dir, 'story.json'), '{"title":"手写的"}', 'utf8')
  const r2 = await tool.execute({ action: 'init', path: dir })
  assert.equal(r2.ok, true)
  assert.match(r2.summary, /保留原样/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8')).title, '手写的')
  assert.notEqual(before, undefined)
})

await test('comic_project read：带分镜/产物/阶段', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_project')
  const dir = makeProject('tool-read')
  const r = await tool.execute({ action: 'read', path: dir })
  assert.equal(r.ok, true)
  assert.match(r.data, /"scenes"/)
  assert.match(r.summary, /阶段/)
})

await test('comic_project status：没跑过制作直说', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_project')
  const r = await tool.execute({ action: 'status', path: makeProject('tool-status') })
  assert.equal(r.ok, true)
  assert.match(r.summary, /没跑过制作/)
})

await test('comic_project list：按根目录找项目', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_project')
  makeProject('scan-list/丙')
  const r = await tool.execute({ action: 'list', root: join(T, 'scan-list') })
  assert.equal(r.ok, true)
  assert.match(r.summary, /找到 1 个项目/)
})

await test('comic_produce start：没有 story.json 拒绝且不落进程', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_produce')
  const dir = join(T, 'tool-produce-empty')
  mkdirSync(dir)
  const r = await tool.execute({ action: 'start', path: dir })
  assert.equal(r.ok, false)
  assert.match(r.summary, /没有 story\.json/)
  assert.ok(!existsSync(join(dir, '.produce.json')))
})

await test('comic_check：坏项目返回 ok:false 的结构化结果，不抛异常', async () => {
  const tool = TOOLS.find((t) => t.name === 'comic_check')
  const dir = join(T, 'tool-check-empty')
  mkdirSync(dir)
  const r = await tool.execute({ action: undefined, path: dir, stage: 'script' })
  assert.equal(r.ok, false)
})

// comic_check 真引擎：python 缺席时优雅降级；在场时跑真预检（离线零积分）
const py = (() => {
  try { return execSync('python -c "print(1)"', { encoding: 'utf8' }).trim() === '1' } catch { return false }
})()

if (py) {
  await test('comic_check script：真引擎对合法样例放行', async () => {
    const tool = TOOLS.find((t) => t.name === 'comic_check')
    const dir = makeProject('check-live')
    mkdirSync(join(dir, 'raw'))
    writeFileSync(join(dir, 'raw', 'g1.png'), 'png')
    // 样例里有 chart 格，预检要求 charts.py 里有同名函数——这是引擎的机械事故门禁
    writeFileSync(join(dir, 'charts.py'), "CHARTS = {'chart_s2': lambda cfg: None}\n", 'utf8')
    const r = await tool.execute({ path: dir, stage: 'script' })
    assert.equal(r.ok, true, r.summary + '\n' + r.data)
    assert.ok(existsSync(join(dir, '.check.json')))
  })

  await test('comic_check script：缺念白的格子被拦', async () => {
    const tool = TOOLS.find((t) => t.name === 'comic_check')
    const dir = makeProject('check-live-bad')
    const bad = JSON.parse(JSON.stringify(STORY))
    bad.scenes[0].narration = ''
    writeFileSync(join(dir, 'story.json'), JSON.stringify(bad), 'utf8')
    const r = await tool.execute({ path: dir, stage: 'script' })
    assert.equal(r.ok, false)
    assert.match(r.data, /没有 narration/)
  })

  await test('comic_prompts：门禁没过时拿不到清单', async () => {
    const tool = TOOLS.find((t) => t.name === 'comic_prompts')
    const dir = makeProject('prompts-gate')
    const bad = JSON.parse(JSON.stringify(STORY))
    bad.scenes[2].prompt = '' // art 格缺 prompt → script 门禁拦
    writeFileSync(join(dir, 'story.json'), JSON.stringify(bad), 'utf8')
    const r = await tool.execute({ path: dir })
    assert.equal(r.ok, false)
    assert.match(r.summary, /门禁|没过|退出码/)
  })

  await test('comic_prompts：合法样例出清单，锚点路径在输出里', async () => {
    const tool = TOOLS.find((t) => t.name === 'comic_prompts')
    const dir = makeProject('prompts-live')
    mkdirSync(join(dir, 'raw'))
    writeFileSync(join(dir, 'raw', 'g1.png'), 'png')
    writeFileSync(join(dir, 'charts.py'), "CHARTS = {'chart_s2': lambda cfg: None}\n", 'utf8')
    const r = await tool.execute({ path: dir })
    assert.equal(r.ok, true, r.summary)
    assert.match(r.data, /g3\.png/)
    assert.match(r.data, /01-style-anchor\.png/)
    assert.match(r.data, /reference_image_urls/)
  })

  await test('comic_doctor：体检能跑完，锚点在位', async () => {
    const tool = TOOLS.find((t) => t.name === 'comic_doctor')
    const r = await tool.execute({})
    assert.equal(r.ok, typeof r.ok === 'boolean' ? r.ok : false)
    assert.match(r.data, /风格锚点图 ✓/)
  })
} else {
  console.log('- 本机没有可用 Python：跳过 comic_check/prompts/doctor 的真引擎用例')
}

console.log(`\n${passed} 个用例全部通过`)

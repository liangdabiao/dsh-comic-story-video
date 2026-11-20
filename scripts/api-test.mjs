// API 半边测试：起本地 http 服务挂 registerApi 的 handler，用真实 fetch 打全前缀路径。
// 运行：node scripts/api-test.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'csv-api-'))
process.env.DSH_HOME = join(ROOT, 'home')

const { registerApi } = await import('../lib/api.js')

let handler = null
registerApi({ webServer: { register(cfg) { handler = cfg.handler; return () => {} } }, get: () => null })
if (!handler) throw new Error('registerApi 没注册 handler')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const B = `${base}/comic-story-video`

async function req(method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: body ? { 'content-type': 'application/json', origin: base } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data = text
  try { data = JSON.parse(text) } catch { /* 文件流 */ }
  return { status: res.status, data, text }
}

let passed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(err)
    process.exit(1)
  }
}

const P = join(ROOT, 'projects')
const DIR = join(P, '舌战群儒')

await test('GET /api/ping', async () => {
  const r = await req('GET', '/api/ping')
  assert.equal(r.status, 200)
  assert.equal(r.data.ok, true)
})

await test('GET /api/health：体检可往返', async () => {
  const r = await req('GET', '/api/health')
  assert.equal(r.status, 200)
  assert.ok('python' in r.data, JSON.stringify(r.data).slice(0, 200))
})

await test('GET /api/catalog：空 roots 也给结构', async () => {
  const r = await req('GET', '/api/catalog')
  assert.equal(r.status, 200)
  assert.equal(r.data.ok, true)
  assert.ok(Array.isArray(r.data.projects))
  assert.ok(Array.isArray(r.data.roots))
})

await test('POST /api/project/init：建目录拷模板，幂等不覆盖', async () => {
  const r1 = await req('POST', '/api/project/init', { path: DIR })
  assert.equal(r1.status, 200)
  assert.equal(r1.data.fresh, true)
  assert.ok(existsSync(join(DIR, 'story.json')))
  assert.ok(existsSync(join(DIR, 'raw')))
  writeFileSync(join(DIR, 'story.json'), '{"title":"改过"}', 'utf8')
  const r2 = await req('POST', '/api/project/init', { path: DIR })
  assert.equal(r2.data.fresh, false)
  assert.equal(JSON.parse(readFileSync(join(DIR, 'story.json'), 'utf8')).title, '改过')
})

await test('init 后 catalog 能扫到项目', async () => {
  const r = await req('POST', '/api/roots', { add: P })
  assert.equal(r.data.roots.includes(P), true)
  const cat = await req('GET', '/api/catalog')
  assert.equal(cat.data.projects.length, 1)
  assert.equal(cat.data.projects[0].title, '改过')
})

await test('GET /api/project：详情带分镜行与阶段', async () => {
  const r = await req('GET', `/api/project?path=${encodeURIComponent(DIR)}`)
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.data.scenes))
  assert.equal(r.data.summary.stage, 0)
})

await test('GET /api/project：相对路径 400', async () => {
  const r = await req('GET', '/api/project?path=relative/path')
  assert.equal(r.status, 400)
})

await test('GET /api/log：没跑过制作给空串', async () => {
  const r = await req('GET', `/api/log?path=${encodeURIComponent(DIR)}`)
  assert.equal(r.status, 200)
  assert.equal(r.data.log, '')
})

await test('POST /api/produce：目录没 story.json 拒绝', async () => {
  const dir = join(ROOT, '空的')
  mkdirSync(dir)
  const r = await req('POST', '/api/produce', { path: dir, action: 'start' })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /story\.json/)
})

await test('POST /api/produce stop：没在跑返回 409', async () => {
  const r = await req('POST', '/api/produce', { path: DIR, action: 'stop' })
  assert.equal(r.status, 409)
})

await test('POST /api/roots：删根目录', async () => {
  const r = await req('POST', '/api/roots', { remove: P })
  assert.equal(r.data.roots.includes(P), false)
})

await test('删掉扫描目录后，台账里的项目还在（历史不丢）', async () => {
  const cat = await req('GET', '/api/catalog')
  const norm = (p) => p.replace(/\\/g, '/')
  assert.ok(cat.data.projects.some((p) => norm(p.path) === norm(DIR)), JSON.stringify(cat.data.projects))
})

await test('POST /api/project/create：只给主题就建目录并记台账', async () => {
  const base = join(ROOT, '片场')
  const r = await req('POST', '/api/project/create', { topic: '为什么有人永远在加班：一个关于排期的故事', base })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(existsSync(join(r.data.path, 'story.json')))
  assert.ok(existsSync(join(r.data.path, 'raw')))
  assert.ok(r.data.path.startsWith(base), r.data.path)
  assert.match(r.data.path, /加班/)
  // 模板里的示例片名/示例分镜不能留在新片上：标题用主题，格子清空
  const seeded = JSON.parse(readFileSync(join(r.data.path, 'story.json'), 'utf8'))
  assert.match(seeded.title, /加班/, `title=${seeded.title}`)
  assert.deepEqual(seeded.scenes, [], '新项目不该带模板的示例分镜')
  assert.ok(seeded.tts && seeded.tts.speed === 1, '配音参数要保留')
  // 同名再建一次不覆盖，自动加序号
  const again = await req('POST', '/api/project/create', { topic: '为什么有人永远在加班：一个关于排期的故事', base })
  assert.notEqual(again.data.path, r.data.path)
  assert.ok(existsSync(join(again.data.path, 'story.json')))
  const cat = await req('GET', '/api/catalog')
  assert.equal(cat.data.outputRoot.replace(/\\/g, '/'), base.replace(/\\/g, '/'))
  assert.ok(cat.data.projects.length >= 3, `作品数 ${cat.data.projects.length}`)
})

await test('片名优先于主题做目录名', async () => {
  const base = join(ROOT, '片场2')
  const r = await req('POST', '/api/project/create', { topic: '主题', name: '一个销冠的诞生', base })
  assert.equal(basename(r.data.path), '一个销冠的诞生')
})

await test('catalog 带封面与成片；成片列表指向真实文件', async () => {
  const dir = join(ROOT, 'projects', '舌战群儒')
  writeFileSync(join(dir, '_contact.png'), 'PNGDATA', 'utf8')
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'out', 'final.mp4'), 'MP4DATA', 'utf8')
  const cat = await req('GET', '/api/catalog')
  const norm = (p) => p.replace(/\\/g, '/')
  const entry = cat.data.projects.find((p) => norm(p.path) === norm(dir))
  assert.ok(entry, '项目应在作品库里')
  assert.equal(entry.cover, '_contact.png')
  assert.ok(entry.final && entry.final.abs.endsWith('final.mp4'))
  assert.equal(entry.final.bytes, 7)
  assert.equal(cat.data.finals.length, 1)
  assert.equal(cat.data.finals[0].title, '改过')
})

await test('POST /api/reveal：项目外的路径拒绝', async () => {
  const outside = join(ROOT, 'outside.txt')
  writeFileSync(outside, 'x', 'utf8')
  const r = await req('POST', '/api/reveal', { path: outside })
  assert.ok([400, 403].includes(r.status), String(r.status))
})

await test('GET /media：项目内文件放行、项目外 403', async () => {
  mkdirSync(join(DIR, 'raw'), { recursive: true })
  writeFileSync(join(DIR, 'raw', 'g1.png'), 'PNGDATA', 'utf8')
  const ok = await req('GET', `/media?path=${encodeURIComponent(join(DIR, 'raw', 'g1.png'))}`)
  assert.equal(ok.status, 200)
  assert.ok(ok.text.includes('PNGDATA'), '应为文件流')
  writeFileSync(join(ROOT, 'outside.txt'), 'secret', 'utf8')
  const bad = await req('GET', `/media?path=${encodeURIComponent(join(ROOT, 'outside.txt'))}`)
  assert.equal(bad.status, 403)
})

await test('静态页面：/ 返回 index.html，路径穿越被拒', async () => {
  const home = await req('GET', '/')
  assert.equal(home.status, 200)
  assert.ok(home.text.includes('漫画故事片场'))
  const bad = await req('GET', '/..%2f..%2fpackage.json')
  assert.equal(bad.status, 404)
})

await test('未知 API 404', async () => {
  const r = await req('GET', '/api/nope')
  assert.equal(r.status, 404)
})

server.close()
console.log(`\n${passed} 个 API 用例全部通过`)

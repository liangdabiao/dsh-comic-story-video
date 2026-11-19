// 插件的 HTTP 半边：给侧栏「漫画故事片场」工作台页面用（/comic-story-video/ 下）。
//   GET  /                     工作台页面（lab/ 静态资源）
//   GET  /api/catalog          项目列表 + 环境 + 扫描根目录
//   GET  /api/project?path=    单个项目：四步流水线状态 + 分镜行 + 产物 + 预检/验收/制作报告
//   GET  /api/log?path=        制作日志尾
//   POST /api/produce          制作启停（走工具同一条代码路径）
//   POST /api/roots            增删扫描根目录 / 记住上次目录
//   GET  /api/health           环境体检（缓存 20 秒）
//   GET  /media?path=          项目里的图/音/视频（只允许含 story.json 的目录内）
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor, readProduceLog, startProduce, stopProduce } from './engine.js'
import { isProject, listProjects, projectDetail, resolveDir } from './project.js'
import { DATA_DIR, readSettings, rememberProject, writeSettings } from './store.js'

const BASE = '/comic-story-video'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ass': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8'
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function version() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return null }
}

// ---------------------------------------------------------------- 静态页面

// 只放行 lab/ 里的文件：拒绝 ..、点开头的路径和指到目录外的符号链接
function safeLabFile(rel) {
  if (!rel || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(LAB) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serve(req, res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// 媒体只允许从「含 story.json 的目录」里读，且必须在这个目录内。
function projectRootOf(file) {
  let dir = dirname(file)
  for (let i = 0; i < 12; i += 1) {
    if (isProject(dir)) return realpathSync(dir)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// 只接受同源页面发来的 JSON
function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('需要 JSON'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- 健康状态（缓存）

let healthCache = { at: 0, value: null }
let healthPending = null
const HEALTH_TTL = 20_000

async function readHealth() {
  if (healthCache.value && Date.now() - healthCache.at < HEALTH_TTL) return healthCache.value
  if (healthPending) return healthPending
  healthPending = doctor({ fix: false })
    .then((value) => { healthCache = { at: Date.now(), value }; return value })
    .finally(() => { healthPending = null })
  return healthPending
}

// ---------------------------------------------------------------- 项目列表

function collectProjects() {
  const settings = readSettings()
  const seen = new Set()
  const projects = []
  for (const root of settings.roots) {
    if (!existsSync(root)) continue
    try {
      for (const p of listProjects(root)) {
        if (!seen.has(p.path)) { seen.add(p.path); projects.push(p) }
      }
    } catch { /* 根目录扫不了就算了 */ }
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

// ---------------------------------------------------------------- 注册

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { ok: false, error: '未授权' })

        const url = new URL(req.url || '/', 'http://x')
        const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (rest === '/api/ping') return json(res, 200, { ok: true, version: version() })

        if (rest === '/api/health') {
          try {
            // fix=1 时绕过缓存重跑体检并自动补 Python 依赖（面板「自动补依赖」按钮）
            if (url.searchParams.get('fix')) {
              const value = await doctor({ fix: true })
              healthCache = { at: Date.now(), value }
              return json(res, 200, { ok: true, ...value })
            }
            return json(res, 200, { ok: true, ...(await readHealth()) })
          } catch (err) {
            return json(res, 200, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/catalog' && req.method === 'GET') {
          const settings = readSettings()
          const health = await readHealth().catch((err) => ({ ok: false, error: String(err.message || err) }))
          return json(res, 200, {
            ok: true,
            version: version(),
            platform: process.platform,
            dataDir: DATA_DIR,
            roots: settings.roots,
            lastRoot: settings.lastRoot,
            projects: collectProjects(),
            health
          })
        }

        if (rest === '/api/project' && req.method === 'GET') {
          const path = url.searchParams.get('path')
          if (!path || !isAbsolute(path)) return json(res, 400, { ok: false, error: 'path 必须是绝对路径' })
          if (!existsSync(path)) return json(res, 400, { ok: false, error: `目录不存在：${path}` })
          try {
            const dir = resolveDir(path)
            const detail = projectDetail(dir)
            const produce = detail.produce
            if (produce && produce.status === 'running') {
              detail.logTail = readProduceLog(dir).slice(-4000)
            }
            return json(res, 200, { ok: true, path: dir, ...detail })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/project/init' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          try {
            const dir = resolveDir(String(body.path || ''))
            const template = join(fileURLToPath(new URL('..', import.meta.url)), 'engine', 'templates', 'comic', 'story.example.json')
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            const storyFile = join(dir, 'story.json')
            const fresh = !existsSync(storyFile)
            if (fresh) copyFileSync(template, storyFile)
            mkdirSync(join(dir, 'raw'), { recursive: true })
            rememberProject(dir)
            return json(res, 200, { ok: true, path: dir, fresh })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/log' && req.method === 'GET') {
          const path = url.searchParams.get('path')
          if (!path || !isAbsolute(path)) return json(res, 400, { ok: false, error: 'path 必须是绝对路径' })
          return json(res, 200, { ok: true, log: readProduceLog(resolveDir(path), 16000) })
        }

        if (rest === '/api/produce' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          try {
            const dir = resolveDir(String(body.path || ''))
            if (!existsSync(join(dir, 'story.json'))) return json(res, 400, { ok: false, error: '这个目录没有 story.json' })
            // 复用工具的启停逻辑：面板与对话里跑的是同一条代码路径
            if (body.action === 'stop') {
              const r = stopProduce(dir)
              return json(res, r.stopped ? 200 : 409, { ok: r.stopped, ...r })
            }
            const state = startProduce(dir, {
              quality: ['low', 'medium', 'high'].includes(body.quality) ? body.quality : 'high'
            })
            return json(res, 200, { ok: true, state })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/roots' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const current = readSettings()
          let roots = current.roots.slice()
          if (Array.isArray(body.roots)) roots = body.roots.map(String)
          if (typeof body.add === 'string' && body.add.trim()) roots.push(body.add.trim())
          if (typeof body.remove === 'string' && body.remove.trim()) {
            const drop = body.remove.trim().replace(/[\\/]+$/, '')
            roots = roots.filter((r) => r.replace(/[\\/]+$/, '') !== drop)
          }
          const patch = { roots }
          if (typeof body.lastRoot === 'string' && body.lastRoot.trim()) patch.lastRoot = body.lastRoot.trim()
          return json(res, 200, { ok: true, ...writeSettings(patch) })
        }

        if (rest === '/media') {
          const target = url.searchParams.get('path')
          if (!target || !isAbsolute(target) || !existsSync(target)) return json(res, 404, { ok: false, error: 'not found' })
          const file = realpathSync(target)
          const root = projectRootOf(file)
          if (!root || !(file === root || file.startsWith(root + sep))) return json(res, 403, { ok: false, error: 'forbidden' })
          if (!statSync(file).isFile()) return json(res, 404, { ok: false, error: 'not found' })
          return serve(req, res, file)
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '只读接口' })
        if (rest.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })

        // 静态页面：/ → index.html
        const rel = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '')
        const file = safeLabFile(rel)
        return file ? serve(req, res, file) : json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    }
  })
}

// dsh 0.2.x 宿主自带 token 鉴权；connection 服务缺席时放行（fail-open，其他插件同款）。
function requestRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  if (typeof connection?.requestRejection !== 'function') return false
  return connection.requestRejection({ headers: req.headers })
}

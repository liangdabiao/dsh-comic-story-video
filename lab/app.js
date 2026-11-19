// 漫画故事片场工作台 · 页面逻辑（无框架，hash 路由 + fetch /api/*）
// 分界线：创作（story.json 的故事/念白/气泡/prompt）由模型按随包 skill 完成，页面只管
// 发起（新建项目/启动制作）、回看（分镜档案/总览图/成片）与四步流水线的位置感。
// 点「在对话里继续」时 postMessage 给宿主开新对话并填好指令。
const app = document.getElementById('app')
const navProjects = document.getElementById('nav-projects')
const railFoot = document.getElementById('rail-foot')
const viewer = document.getElementById('viewer')
const viewerTitle = document.getElementById('viewer-title')
const viewerBody = document.getElementById('viewer-body')
const toastEl = document.getElementById('toast')

// 页面挂在 /comic-story-video/ 下，接口也在同一前缀下。
// 不能用 '/api/...' 这种根绝对路径——那会打到宿主自己的 API 上。
const BASE = location.pathname.replace(/\/+$/, '') || '/comic-story-video'

const state = {
  catalog: null,
  project: null,
  error: '',
  logTimer: null
}

const STAGE_NAMES = ['写故事', '出图', '制作', '验收', '完成']

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const shortTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
// 拼接项目内相对路径：joinPath(dir, 'check', '03.png') → dir/check/03.png
const joinPath = (dir, ...rel) => [
  String(dir).replace(/[\\/]+$/, ''),
  ...rel.map((r) => String(r ?? '').replace(/^[\\/]+/, ''))
].filter((p) => p !== '').join('/')
const mediaUrl = (abs) => `${BASE}/media?path=${encodeURIComponent(abs)}`
const kb = (bytes) => (!bytes ? '' : bytes > 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

async function api(path, opts) {
  const res = await fetch(BASE + path, opts)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(body.error || `请求失败（${res.status}）`)
  return body
}

async function post(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
}

let toastTimer = null
function toast(msg, bad = false) {
  toastEl.textContent = msg
  toastEl.className = `toast show${bad ? ' bad' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.className = 'toast' }, 3200)
}

// ---------------------------------------------------------------- 主题 / 宿主通信

addEventListener('message', (e) => {
  const m = e.data
  if (!m || m.type !== 'comic-story-video:scheme' || !m.scheme) return
  document.documentElement.dataset.scheme = m.scheme
})

// 在对话里继续：把指令填进新对话
function startInChat(prompt) {
  parent.postMessage({ type: 'comic-story-video:start', prompt }, location.origin)
}

// ---------------------------------------------------------------- 路由

async function route() {
  const hash = location.hash || '#/'
  const [pathPart, queryPart] = hash.slice(1).split('?')
  const query = new URLSearchParams(queryPart || '')
  stopLogTimer()
  if (pathPart === '/project' && query.get('path')) return renderProject(decodeURIComponent(query.get('path')))
  if (pathPart === '/new') return renderNew()
  if (pathPart === '/guide') return renderGuide()
  return renderHome()
}

function stopLogTimer() {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null }
}

// ---------------------------------------------------------------- 概览

async function renderHome() {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === 'home'))
  app.innerHTML = '<div class="loading">加载中…</div>'
  try {
    const cat = await api('/api/catalog')
    state.catalog = cat
    navProjects.textContent = cat.projects.length || ''
    railFoot.innerHTML = `数据目录<br><span style="word-break:break-all">${esc(cat.dataDir)}</span>`

    const health = cat.health || {}
    const depsOk = (health.deps || []).every((d) => d.ok)
    const chips = [
      chip(health.python, `Python ${health.python ? health.python.version : ''}`),
      chip(depsOk, '逐笔引擎依赖'),
      chip(health.ffmpeg && health.ffmpeg.ok, 'ffmpeg'),
      chip(health.apiz && health.apiz.ok, 'apiz（出图+配音）'),
      chip(health.anchor, '风格锚点')
    ]
    const hints = (health.notes || []).map((n) => `<div class="hint">${esc(n)}</div>`).join('')
    const fixBtn = health.ok ? '' : '<button class="small" id="btn-fix">自动补依赖</button>'

    const cards = cat.projects.map((p) => `
      <a class="card proj-card" href="#/project?path=${encodeURIComponent(p.path)}">
        <div class="t">${esc(p.title || '未填 title')}</div>
        <div class="sl">${esc(p.storyLine || '（story_line 还没填）')}</div>
        <div class="meta">
          <span class="badge s${p.stage}">${STAGE_NAMES[p.stage]}</span>
          <span>分镜 ${p.scenes}</span>
          <span>图 ${p.doneArts}/${p.arts}</span>
          ${p.hasFinal ? '<span style="color:var(--ok)">有成片</span>' : ''}
        </div>
        <div class="path">${esc(p.path)} · ${shortTime(p.updatedAt)}</div>
      </a>`).join('')

    app.innerHTML = `
      <h1>概览</h1>
      <p class="sub">选题进来，漫画片出去：写故事 → 出图 → 制作 → 验收，四步一条片。</p>
      <div class="health">${chips.join('')}${fixBtn}${hints}</div>
      <div class="grid">
        ${cards}
        <a class="card new-card" href="#/new"><span><span class="plus">＋</span><br>新建漫画片</span></a>
      </div>
      ${cat.roots.length ? rootsHtml(cat) : ''}`

    const fix = document.getElementById('btn-fix')
    if (fix) fix.onclick = async () => {
      fix.disabled = true
      fix.textContent = '安装中（首次要下 ~83MB 模型）…'
      try {
        const res = await fetch(`${BASE}/api/health?fix=1`)
        const body = await res.json()
        toast(body.ok && body.python && (body.deps || []).every((d) => d.ok) ? '依赖装好了' : '还没齐：看环境条提示', !body.ok)
      } catch (err) { toast(String(err.message || err), true) }
      renderHome()
    }
  } catch (err) {
    state.error = String(err.message || err)
    app.innerHTML = `<div class="card"><b>加载失败</b><p class="sub">${esc(state.error)}</p></div>`
  }
}

function chip(ok, label) {
  return `<span class="chip ${ok ? 'ok' : 'bad'}"><span class="dot"></span>${label}</span>`
}

function rootsHtml(cat) {
  return `
    <h2>扫描目录</h2>
    <div class="roots">
      ${cat.roots.map((r) => `
        <div class="root-row"><span class="p">${esc(r)}</span><button class="small" data-remove="${esc(r)}">移除</button></div>`).join('')}
    </div>`
}

// ---------------------------------------------------------------- 新建

function renderNew() {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === 'new'))
  const lastRoot = (state.catalog && state.catalog.lastRoot) || ''
  const defaultDir = lastRoot ? lastRoot.replace(/[\\/]+$/, '') : ''
  const suggestions = ['舌战群儒', '一个销冠的诞生', ' QE 是什么']
  app.innerHTML = `
    <h1>新建漫画片</h1>
    <p class="sub">建项目目录 + story.json 模板。故事内容（三行头/念白/气泡/prompt）由对话里的模型按随包 skill 写。</p>
    <div class="card form">
      <label>项目目录（绝对路径）</label>
      <input id="f-path" placeholder="例如 D:\\stories\\shezhan" value="${esc(defaultDir)}">
      <div class="suggest">常用：${suggestions.map((s) => `<button class="small" data-suggest="${esc(s.trim())}">${esc(s.trim())}</button>`).join('')}</div>
      <div class="note">
        建好后：<br>
        1. 点「建项目」——目录里会出现 story.json 模板和 raw/<br>
        2. 点「在对话里继续」——把片名带给模型，模型按 skill 写故事、预检、出图、制作、验收
      </div>
      <div class="actions">
        <button class="primary" id="btn-create">建项目</button>
        <button id="btn-chat" disabled>在对话里继续</button>
      </div>
    </div>`

  const pathInput = document.getElementById('f-path')
  const chatBtn = document.getElementById('btn-chat')
  let created = ''

  document.querySelectorAll('[data-suggest]').forEach((b) => {
    b.onclick = () => {
      pathInput.value = pathInput.value.replace(/[\\/]+$/, '') + '/' + b.dataset.suggest
    }
  })

  document.getElementById('btn-create').onclick = async () => {
    const p = pathInput.value.trim()
    if (!p) return toast('先填项目目录', true)
    try {
      const r = await post('/api/project/init', { path: p })
      created = r.path
      chatBtn.disabled = false
      toast(r.fresh ? '项目建好了' : '目录已存在，story.json 保留原样')
    } catch (err) { toast(String(err.message || err), true) }
  }

  chatBtn.onclick = () => {
    if (!created) return
    startInChat(`用「漫画面讲故事」 skill 做一条漫画短视频。项目目录：${created}。选题：请在项目里看一下（或我现在告诉你）。先 comic_doctor 体检环境，然后按五步走：写 story.json（先填三行头）→ comic_check → comic_prompts 出图 → comic_produce 制作 → comic_verify 验收。`)
  }
}

// ---------------------------------------------------------------- 项目详情

async function renderProject(path) {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.remove('active'))
  app.innerHTML = '<div class="loading">加载中…</div>'
  let d
  try {
    d = await api(`/api/project?path=${encodeURIComponent(path)}`)
  } catch (err) {
    app.innerHTML = `<div class="card"><b>打不开项目</b><p class="sub">${esc(String(err.message || err))}</p><a href="#/">← 回概览</a></div>`
    return
  }
  state.project = { path, ...d }
  const s = d.summary
  const running = d.produce && d.produce.status === 'running'

  // stage = 「下一步做哪」的序号：0 写故事…3 验收，4 = 全部完成
  const stepper = STAGE_NAMES.slice(0, 4).map((name, i) => `
    <div class="step ${s.stage > i ? 'done' : s.stage === i ? 'current' : ''}">
      <b><span class="n">${s.stage > i ? '✓' : i + 1}</span>${name}</b>
      ${['三行头 + 八格念白', '图生图 · 锚点参考', '配音→气泡→逐笔渲染', '抽帧看 + 听音轨'][i]}
    </div>`).join('')

  const tri = `
    <div class="tri">
      <div class="card"><div class="k">story_line · 谁想干什么</div><div class="v ${s.storyLine ? '' : 'empty'}">${esc(s.storyLine || '未填')}</div></div>
      <div class="card"><div class="k">question · 开场砸出的问题</div><div class="v ${s.question ? '' : 'empty'}">${esc(s.question || '未填')}</div></div>
      <div class="card"><div class="k">answer · 最后一格的答案</div><div class="v ${s.answer ? '' : 'empty'}">${esc(s.answer || '未填')}</div></div>
    </div>`

  const scenes = (d.scenes || []).map((sc) => {
    const img = sc.hasImage && sc.src ? `<img src="${mediaUrl(joinPath(path, sc.src))}" data-full="${mediaUrl(joinPath(path, sc.src))}" alt="${esc(sc.id)}">` : `<span class="miss">${sc.type === 'art' ? '缺图（raw/）' : '信息图未渲染'}</span>`
    const bubbles = (sc.bubbles || []).map((b) => `<span class="bubble">💬 ${esc(b.text)}</span>`).join('')
    const audio = sc.audio ? `<audio controls preload="none" src="${mediaUrl(joinPath(path, sc.audio))}"></audio>` : '<span>没配音</span>'
    return `
      <div class="card scene">
        <div class="head"><b>${esc(sc.id)}</b><span class="kind ${sc.type}">${sc.type === 'art' ? '线稿' : '信息图'}</span><span class="grow"></span><span>${sc.chars}字</span></div>
        <div class="thumb">${img}</div>
        <div class="narr">${esc(sc.narration) || '<i>没写念白</i>'}</div>
        ${bubbles ? `<div class="bubbles">${bubbles}</div>` : ''}
        <div class="foot">${audio}<span class="grow"></span>${sc.prompt ? '有 prompt' : '<span class="miss">缺 prompt</span>'}</div>
      </div>`
  }).join('')

  const missing = (d.scenes || []).filter((sc) => sc.type === 'art' && !sc.hasImage)
  const contact = d.artifacts.contact ? `<img class="contact" src="${mediaUrl(joinPath(path, d.artifacts.contact))}" data-full="${mediaUrl(joinPath(path, d.artifacts.contact))}" alt="总览图">` : ''
  const finalPath = d.artifacts.final ? joinPath(path, d.artifacts.final) : null

  const produceState = d.produce || null
  const produceCard = `
    <div class="card">
      <div class="produce-bar">
        <b>制作</b>
        ${produceState ? `<span class="badge ${running ? 'run' : produceState.status === 'done' ? 's4' : 's3'}">${{ running: '进行中', done: '完成', failed: '失败', stopped: '已停' }[produceState.status] || produceState.status}</span>` : '<span class="sub" style="margin:0">没跑过</span>'}
        ${produceState ? `<span class="sub" style="margin:0">${esc(produceState.startedAt)} 起 · quality=${esc(produceState.quality)}</span>` : ''}
        <span class="grow"></span>
        <select id="q-select">
          <option value="high">high（默认）</option>
          <option value="medium">medium</option>
          <option value="low">low（快但糊）</option>
        </select>
        <button class="primary" id="btn-produce" ${running ? 'disabled' : ''}>${running ? '制作中…' : '启动制作'}</button>
        ${running ? '<button class="danger" id="btn-stop">停止</button>' : ''}
        <button class="small" id="btn-log">看日志</button>
      </div>
      <div class="logbox" id="logbox" ${running ? '' : 'hidden'}>${esc(d.logTail || '（还没有日志）')}</div>
      ${!s.hasFinal ? '<p class="sub" style="margin:10px 0 0">启动前确认：图门禁（comic_check image）过绿、配音参数（story.json 的 tts）定稿。</p>' : ''}
    </div>`

  const finalCard = finalPath ? `
    <div class="card">
      <div class="final-wrap">
        <video controls src="${mediaUrl(finalPath)}"></video>
        <div>
          <b>${esc(d.artifacts.final)}</b>
          <p class="sub">1080×1920 竖屏成片。验收：闭眼只听音轨能说出「谁想要什么、发生了哪几件事、最后怎么收」；抽帧看画面在动、底色对、字幕不出画。</p>
          ${(d.artifacts.checkFrames || []).length ? `<div class="frames">${d.artifacts.checkFrames.map((f) => `<img src="${mediaUrl(joinPath(path, 'check', f.name))}" data-full="${mediaUrl(joinPath(path, 'check', f.name))}" alt="${esc(f.name)}">`).join('')}</div>` : ''}
          ${d.artifacts.flat ? `<p class="sub" style="margin-top:10px">平屏版：<a href="${mediaUrl(joinPath(path, d.artifacts.flat))}" target="_blank">story_flat.mp4</a></p>` : ''}
        </div>
      </div>
    </div>` : ''

  const check = d.check ? `
    <details class="report"><summary>预检报告（${esc(d.check.stage)}）${d.check.ok ? '<span class="report-ok">✓ 过</span>' : '<span class="report-bad">✗ 没过</span>'} · ${shortTime(d.check.at)}</summary>
      <div class="logbox">${esc(d.check.report || '')}</div></details>` : ''
  const verify = d.verify ? `
    <details class="report"><summary>验收报告 ${d.verify.ok ? '<span class="report-ok">✓ 过</span>' : '<span class="report-bad">✗ 没过</span>'} · ${shortTime(d.verify.at)}</summary>
      <div class="logbox">${esc((d.verify.stdout || '') + (d.verify.stderr ? `\n${d.verify.stderr}` : ''))}</div></details>` : ''

  const chars = (d.meta.characters || []).length ? `
    <h2>角色设定</h2>
    <div class="card chars">
      ${d.meta.characters.map((c) => `<div class="row"><span class="name">{${esc(c.name)}}</span><span class="desc">${esc(c.desc)}</span></div>`).join('')}
    </div>` : ''

  app.innerHTML = `
    <div class="topbar">
      <a class="back" href="#/">← 概览</a>
      <span class="grow"></span>
      <button class="small" id="btn-chat">在对话里继续</button>
    </div>
    <h1>${esc(s.title || '未填 title')}</h1>
    <p class="sub">${esc(s.path)} · 分镜 ${s.scenes} 格 · ${s.doneArts}/${s.arts} 已出图 · 配音 ${s.audio}/${s.scenes}</p>
    <div class="stepper">${stepper}</div>
    ${tri}
    ${chars}
    <h2>分镜（${(d.scenes || []).length} 格）</h2>
    ${missing.length ? `<p class="sub">还有 ${missing.length} 格没出图：${missing.map((m) => esc(m.id)).join('、')}</p>` : ''}
    <div class="scene-grid">${scenes}</div>
    ${contact ? `<h2>总览图（看画风漂没漂，一次看完）</h2>${contact}` : ''}
    <h2>制作</h2>
    ${produceCard}
    ${finalCard ? `<h2>成片</h2>${finalCard}` : ''}
    ${check}${verify}`

  bindProjectEvents(path, running)
  if (running) startLogTimer(path)
}

function bindProjectEvents(path, running) {
  const openViewer = (src, title) => {
    viewerTitle.textContent = title || ''
    viewerBody.innerHTML = src.endsWith('.mp4') || src.includes('.mp4')
      ? `<video controls autoplay src="${src}"></video>`
      : `<img src="${src}">`
    viewer.hidden = false
  }
  document.querySelectorAll('[data-full]').forEach((el) => {
    el.onclick = () => openViewer(el.dataset.full, el.alt)
  })
  const chat = document.getElementById('btn-chat')
  if (chat) chat.onclick = () => startInChat(`继续做漫画片「${(state.project && state.project.summary.title) || ''}」（目录 ${path}）。用 comic_project action=read 看当前进度，接着四步流水线下一步走。`)
  const produce = document.getElementById('btn-produce')
  if (produce) produce.onclick = async () => {
    produce.disabled = true
    try {
      await post('/api/produce', { path, action: 'start', quality: document.getElementById('q-select').value })
      toast('制作已启动，页面会自动刷新日志')
      renderProject(path)
    } catch (err) { toast(String(err.message || err), true); produce.disabled = false }
  }
  const stop = document.getElementById('btn-stop')
  if (stop) stop.onclick = async () => {
    try {
      await post('/api/produce', { path, action: 'stop' })
      toast('已停止')
      renderProject(path)
    } catch (err) { toast(String(err.message || err), true) }
  }
  const logBtn = document.getElementById('btn-log')
  if (logBtn) logBtn.onclick = async () => {
    const box = document.getElementById('logbox')
    box.hidden = !box.hidden
    if (!box.hidden) {
      try { box.textContent = (await api(`/api/log?path=${encodeURIComponent(path)}`)).log || '（空）' } catch { /* ignore */ }
    }
  }
}

function startLogTimer(path) {
  const box = document.getElementById('logbox')
  if (!box) return
  state.logTimer = setInterval(async () => {
    try {
      const r = await api(`/api/log?path=${encodeURIComponent(path)}`)
      if (box && !box.hidden) {
        box.textContent = r.log || '（等引擎输出…）'
        box.scrollTop = box.scrollHeight
      }
    } catch { /* 制作进程退出后接口还能答，忽略抖动 */ }
  }, 3000)
}

// ---------------------------------------------------------------- 指南

function renderGuide() {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === 'guide'))
  app.innerHTML = `
    <h1>四步出片</h1>
    <p class="sub">声音是主线：把音轨单独抽出来听，必须是一条讲得通的故事。画面负责加戏。</p>
    <div class="guide-steps">
      ${[
        ['① 写故事', 'comic_project 建 → 模型写 story.json', '先填 story_line / question / answer 三行头，填不出来别写格子。念白 440–540 字按 4.0 字/秒。写完 <code>comic_check</code>（script）——它只拦机械事故，好坏靠连读自查。'],
        ['② 出图', 'comic_prompts → apiz flare 图生图', '参考图 = 风格锚点（相似度 low）。已出图、prompt 没变的格子自动跳过。<code>comic_check</code>（image）只看「该在的人在不在、有没有整片涂黑」；零星文字、线条脏不看。'],
        ['③ 制作', 'comic_produce 后台跑', '配音（apiz MiniMax 单口腔）→ 气泡层 → 净化落版 → 逐笔渲染（几分钟）→ 合成竖屏烧字幕。面板这里能启动、看日志。'],
        ['④ 验收', 'comic_verify 抽帧 + 听音轨', '抽帧肉眼看：画面在动吗、底色对不对、字幕有没有出画。闭眼听：能说出「谁想要什么、发生了哪几件事、最后怎么收」才算过。']
      ].map(([t, tool, body]) => `
        <div class="card guide-step">
          <span class="no">${t.slice(1, 2)}</span>
          <div class="body"><b>${t.slice(3)} — ${tool}</b><p>${body}</p></div>
        </div>`).join('')}
    </div>
    <h2>十条硬规则（前三条管故事，后七条管制作）</h2>
    <div class="card principles">
      <ol>
        <li><b>先填三行头</b>，填不出来不写格子——八格写完才发现散是最贵的返工。</li>
        <li><b>骨架按「主角和阻力是什么关系」选</b>，别给所有选题套同一张格子表；格数 5–9 都行。</li>
        <li><b>并列的事不要编号成回合</b>；「加码」「到顶」这类解说员行话是暗号，删。</li>
        <li><b>念白必须是完整故事，台词要念出来</b>——「他回了一句」不算；气泡重复念白不算错。</li>
        <li><b>模型只画线稿</b>，字由代码叠（prompt 里写「不要画任何文字」）。</li>
        <li><b>气泡不进引擎</b>（引擎会彩色二值化成黑块），合成时按时间弹。</li>
        <li><b>不传 element_plan</b>——传了两秒画满；不传按 √面积分预算，天然铺满。</li>
        <li><b>必须图生图</b>，锚点相似度 low——high 会照抄参考图的姿势。</li>
        <li><b>角色进 characters，两人至少三项不同</b>；异类头饰给主角，冠冕留给对手。</li>
        <li><b>底色 colorkey+overlay、字幕烧 ASS 声明 PlayRes</b>——引擎已实现死，别绕过引擎自己拼 ffmpeg。</li>
      </ol>
    </div>
    <h2>钱从哪花</h2>
    <div class="card">
      <p class="sub" style="margin:0">出图 apiz flare 低分辨率档约 <b>19 积分/张</b>，一条片子四五张线稿一块钱以内；出过的图有指纹台账，没改 prompt 重跑不花钱。配音 apiz MiniMax 按量计费，edge-tts 免费兜底（腔调平）。逐笔渲染不花钱，只花时间。余额：<code>apiz account balance</code>。</p>
    </div>`
}

// ---------------------------------------------------------------- 预览浮层

document.getElementById('viewer-close').onclick = () => { viewer.hidden = true }
addEventListener('keydown', (e) => { if (e.key === 'Escape') viewer.hidden = true })

addEventListener('hashchange', route)
route()

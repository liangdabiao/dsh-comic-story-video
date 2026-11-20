// 漫画故事片场 · 浏览器半边
// 侧栏加「漫画故事片场」入口；主区域是 /comic-story-video/ 的工作台页面（iframe）。
// 页面里点「在对话里继续」时 postMessage 一段指令，这里开新对话并填进输入框。
// 明暗跟随 dsh 主题，切换时把配色发给页面。
//
// 注意：这个文件直接调 window.__ModuleLoader__.load，不要再被 build banner 包一层，
// 否则同一个 id 会注册两次（宿主会报 duplicate factory registration）。
window.__ModuleLoader__.load({
  id: 'dsh-comic-story-video',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'comic-story-video'
    const LABEL = '漫画故事片场'
    const SRC = '/comic-story-video/'

    // 画框 + 铅笔 + 对话气泡：和 icon.svg 同一枚徽标（线稿逐笔描）
    function StudioIcon(props) {
      const s = (props && props.size) || 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round'
      },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }),
        h('path', { d: 'M6.5 7.5h5v5h-5zM13.5 7.5h4M13.5 10h4M6.5 16h11' }),
        h('path', { d: 'M20.2 2.6l-6.4 8.1 1.6 2 6.4-8.1a1.3 1.3 0 0 0-1.6-2z', fill: 'currentColor', stroke: 'none' }))
    }

    function apply(ctx) {
      const frames = new Set()
      let scheme = null

      const post = (frame, payload) => {
        try { if (frame && frame.contentWindow) frame.contentWindow.postMessage(payload, location.origin) } catch { /* 跨域/已卸载 */ }
      }
      const pushScheme = () => {
        if (scheme) for (const frame of frames) post(frame, { type: 'comic-story-video:scheme', scheme })
      }

      // 主题：有 theme 服务就跟随，没有（老宿主/无主题）就用页面自己的默认
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['theme'], (c) => {
            const push = (snap) => {
              try { scheme = snap.active.colorScheme } catch { scheme = null }
              pushScheme()
            }
            try { push(c.theme.getTheme()) } catch { /* ignore */ }
            c.on('theme/change', push)
          })
        }
      } catch { /* ignore */ }

      function StudioPanel() {
        const ref = React.useRef ? React.useRef(null) : { current: null }

        if (React.useEffect) {
          React.useEffect(() => {
            const self = ref.current
            if (self) frames.add(self)
            function onMessage(e) {
              const frame = ref.current
              if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return
              const m = e.data
              if (!m || m.type !== 'comic-story-video:start' || typeof m.prompt !== 'string') return
              const ok = () => post(frame, { type: 'comic-story-video:start-ok' })
              const fail = (err) => {
                console.error('[comic-story-video] 开新对话失败', err)
                post(frame, { type: 'comic-story-video:start-failed', message: String((err && err.message) || err) })
              }
              try {
                // 多数宿主版本同步返回 undefined；返回 Promise 的版本要等它落地再回执
                const started = ctx.uiWorkspace.startSession(undefined, { prompt: m.prompt, whenDraftExists: 'replace' })
                if (started && typeof started.then === 'function') started.then(ok, fail)
                else ok()
              } catch (err) {
                fail(err)
              }
            }
            addEventListener('message', onMessage)
            pushScheme()
            return () => { removeEventListener('message', onMessage); frames.delete(self) }
          }, [])
        }

        return h('iframe', {
          ref,
          src: SRC,
          title: LABEL,
          allow: 'fullscreen; clipboard-write',
          onLoad: (e) => { pushScheme(); post(e.currentTarget, { type: 'comic-story-video:scheme', scheme }) },
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }
        })
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 8, label: () => LABEL }, StudioIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, StudioPanel))
    }

    return { inject: ['slots', 'uiWorkspace'], apply }
  }
})

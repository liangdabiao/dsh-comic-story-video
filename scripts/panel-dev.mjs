// 漫画故事片场 · 面板开发预览：假 ctx 拉起 lib/api.js 路由，浏览器可直接验收面板。
// 用法：node scripts/panel-dev.mjs [--port 8899]
import http from 'node:http'

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 8899)

const { registerApi } = await import('../lib/api.js')
const ctx = {
  get: () => undefined, // requestRejection 缺席 → 放行（对齐 dsh 0.2.x 行为）
  webServer: {
    register(route) {
      return http.createServer((req, res) => route.handler(req, res)).listen(port, '127.0.0.1')
    }
  }
}
registerApi(ctx)
console.log(`面板开发预览：http://127.0.0.1:${port}/comic-story-video/`)

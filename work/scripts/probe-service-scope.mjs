// 探针：cordis 里一个插件 provide 的服务，兄弟插件能不能 inject 到？
// 这决定了「协议库」和「消费者插件」这种平级关系能否成立。
import { createRequire } from 'node:module'
const require = createRequire('file:///D:/default-workspace/')
const APP = 'C:/Users/zxm/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules'
const { Context } = await import(require('node:url').pathToFileURL(`${APP}/@deepseek-ai/cordis/lib/index.js`).href)

const root = new Context()
const log = (...a) => console.log(...a)

// 提供方：普通函数式插件，用 ctx.provide
function provider(ctx) {
  ctx.provide('demoSvc', { hello: () => 'world' })
  log('[provider] provided; ctx.get(self) =', !!ctx.get('demoSvc'))
}

// 消费方：inject 同名服务
function consumer(ctx) {
  const svc = ctx.get('demoSvc')
  log('[consumer] active; got service =', svc ? svc.hello() : null)
}
consumer.inject = ['demoSvc']

root.plugin(provider)
root.plugin(consumer)

await new Promise((r) => setTimeout(r, 300))
log('--- root.get =', !!root.get('demoSvc'))

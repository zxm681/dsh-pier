// 探针：ctx.provide 的第三参数 check 谓词，对「兄弟插件 inject」有什么影响？
// 我们的协议库用了 check = () => kit !== null（服务就绪才算可用），
// 真机上消费者却 pending "waiting for services"。这里定因。
const APP = 'C:/Users/zxm/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules'
const { pathToFileURL } = await import('node:url')
const { Context } = await import(pathToFileURL(`${APP}/@deepseek-ai/cordis/lib/index.js`).href)

const log = (...a) => console.log(...a)

async function scenario(name, provideArgs, mutate) {
  const root = new Context()
  let state = 'idle'

  function provider(ctx) {
    const svc = { hello: () => `world-${state}` }
    const [n, v, c] = provideArgs
    if (c) ctx.provide(n, v, c)
    else ctx.provide(n, v)
    log(`[${name}] provided`)
  }

  let consumerRan = false
  function consumer(ctx) {
    consumerRan = true
    const svc = ctx.get('demoSvc')
    log(`[${name}] consumer active; svc =`, svc ? svc.hello() : null)
  }
  consumer.inject = ['demoSvc']

  root.plugin(provider)
  root.plugin(consumer)
  await new Promise((r) => setTimeout(r, 100))

  if (mutate) {
    state = 'ready'
    mutate()
    await new Promise((r) => setTimeout(r, 200))
  }
  log(`[${name}] => consumerRan=${consumerRan}\n`)
}

// A：无 check（对照）
await scenario('A-no-check', ['demoSvc', { hello: () => 'world' }])

// B：check 一开始 false，之后外部条件变化（模拟 kit 异步就绪）
await scenario('B-check-late', ['demoSvc', { hello: () => 'world-late' }, () => false], () => {})

// C：check 一直 true
await scenario('C-check-true', ['demoSvc', { hello: () => 'world-true' }, () => true])

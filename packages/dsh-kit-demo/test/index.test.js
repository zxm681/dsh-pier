/**
 * demo 插件测试：验证「第三方插件只用公开 API」这条设计承诺。
 *
 * 这些测试**不启动真 TCP**，只验解耦度与降级行为 ——
 * 跨进程已经由 dsh-kit-bridge 的 e2e.mjs 验过了，这里不重复。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../src/index.js'

test('插件形状：name / inject / apply 符合 DSH 插件契约', () => {
  assert.equal(name, 'dsh-kit-demo')
  assert.deepEqual(inject, ['dshVscodeKit'])
  assert.equal(typeof apply, 'function')
})

/**
 * 假 kit：只暴露公开 API（request/notify/vscode/ready/forPlugin），验证 demo 不越界。
 * `forPlugin` 记录绑定参数 —— demo 必须显式声明身份与档位，这是 T38 白名单的入口契约。
 */
function fakeKit(handlers) {
  const calls = []
  const bindings = []
  const kit = {
    calls,
    bindings,
    ready: true,
    request: (m, p) => { calls.push([m, p]); return Promise.resolve({}) },
    notify: () => {},
    forPlugin: (n, opts) => { bindings.push([n, opts]); return kit },
    vscode: {
      getSelection: async () => { calls.push(['getSelection']); return handlers.getSelection() },
      openFile: async (args) => { calls.push(['openFile', args]); return handlers.openFile(args) },
    },
  }
  return kit
}

function fakeCtx(kit) {
  const provided = new Map()
  return {
    provided,
    get: (n) => (n === 'dshVscodeKit' ? kit : undefined),
    provide: (n, v) => provided.set(n, v),
  }
}

test('正常路径：readSelection 把选区原样透出', async () => {
  const kit = fakeKit({
    getSelection: () => ({ file: '/ws/a.js', text: 'hello', start: { line: 1, column: 1 }, end: { line: 1, column: 6 }, isEmpty: false }),
    openFile: () => ({ opened: true }),
  })
  const demo = apply(fakeCtx(kit), {})
  const r = await demo.readSelection()
  assert.equal(r.ok, true)
  assert.equal(r.text, 'hello')
  assert.equal(r.file, '/ws/a.js')
})

test('空选区标记成 empty:true，上层好区分「没选」与「选到空」', async () => {
  const kit = fakeKit({
    getSelection: () => ({ file: '/ws/a.js', text: '', start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, isEmpty: true }),
    openFile: () => ({}),
  })
  const demo = apply(fakeCtx(kit), {})
  const r = await demo.readSelection()
  assert.equal(r.ok, true)
  assert.equal(r.empty, true)
})

test('降级：无活动编辑器时返回结构化失败，不抛异常', async () => {
  const kit = fakeKit({
    getSelection: () => { const e = new Error('no active editor'); e.code = -32003; throw e },
    openFile: () => { throw new Error('x') },
  })
  const demo = apply(fakeCtx(kit), {})
  const r = await demo.readSelection()
  assert.equal(r.ok, false)
  assert.equal(r.code, -32003)
  assert.match(r.message, /no active editor/)
})

test('降级：服务缺失时插件不崩，只是不提供能力', () => {
  const ctx = { get: () => undefined, provide: () => {} }
  assert.equal(apply(ctx, {}), undefined)
})

test('openFile 透传位置参数（line/column 由协议层做 1-based 转换）', async () => {
  const kit = fakeKit({
    getSelection: () => ({}),
    openFile: (args) => ({ opened: true, path: args.path }),
  })
  const demo = apply(fakeCtx(kit), {})
  const r = await demo.openFile('/ws/b.js', { line: 9, column: 4 })
  assert.equal(r.ok, true)
  assert.deepEqual(kit.calls.at(-1), ['openFile', { path: '/ws/b.js', line: 9, column: 4 }])
})

test('demo 注册了 dshKitDemo 服务供别的插件使用', () => {
  const ctx = fakeCtx(fakeKit({ getSelection: () => ({}), openFile: () => ({}) }))
  apply(ctx, {})
  assert.ok(ctx.provided.has('dshKitDemo'))
})

test('demo 显式声明身份与档位：forPlugin("dsh-kit-demo", { declared: "read" })', () => {
  const kit = fakeKit({ getSelection: () => ({}), openFile: () => ({}) })
  apply(fakeCtx(kit), {})
  // 白名单按插件名 × 最高档位判（契约 §6.2.8 第 3 条）：没名字 = 永远只能 read，
  // 所以消费者必须自己报名字；档位如实声明成它真正用到的最高档。
  assert.deepEqual(kit.bindings, [['dsh-kit-demo', { declared: 'read' }]])
})

test('旧版 kit 没有 forPlugin 时退回共享 facade，不崩也不静默提权', async () => {
  const kit = fakeKit({ getSelection: () => ({ file: '/ws/a.js', text: 'x', isEmpty: false }), openFile: () => ({}) })
  delete kit.forPlugin
  const demo = apply(fakeCtx(kit), {})
  const r = await demo.readSelection()
  assert.equal(r.ok, true)
  assert.equal(r.text, 'x')
})

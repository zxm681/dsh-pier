/**
 * W1–W3（多窗口寻址）的测试台。
 *
 * 文件名里没有 `.test.js`，所以 `node --test test/*.test.js` **不会**把它当成用例跑
 * —— 它只是被 `windows-list.test.js` / `windows-target.test.js` 共用的脚手架
 * （两个文件要造同一种"窗口"，共享一份才不会有第二种口径）。
 *
 * 造出来的"窗口"是**真 TCP + 真 kit server + 真 connector 协议层**，只有 `vscode.*`
 * 的实现是假的 —— 与 `t5-negative-multiwin.test.js` 同一路数，但多了 W3 的
 * `window` 块，以及"谁答的这条请求"的可辨识返回值。
 */

import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { connect, createLineSplitter } from '../src/protocol.js'

/** 测试消费者身份（写类调用必须来自已绑定身份的入口；口径同 t5）。 */
export const TEST_CONSUMER = 'dsh-kit-test'
export const TEST_CONSUMERS = { [TEST_CONSUMER]: 'delete' }

/** 假窗口声明的能力（覆盖本文件用到的读 + 写）。 */
export const WINDOW_CAPS = [
  'vscode.getSelection',
  'vscode.getDocumentState',
  'vscode.applyEdit',
  'vscode.windows.list',
]

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-multiwin-'))
}

export function fakeCtx() {
  const provided = new Map()
  const disposers = []
  return {
    provided,
    provide(n, v, check) { provided.set(n, { v, check }) },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    runDisposers() {
      while (disposers.length) {
        const d = disposers.pop()
        try { d() } catch { /* 卸载失败不影响其它清理 */ }
      }
    },
  }
}

/**
 * W3 的 `window` 块（编辑器上报的身份候选）。
 *
 * 字段与设计 §6 一致：`sessionId` / `workspace.{name,folders}` / `uiKind` / `remoteName`。
 * 这里故意**只**放这几样 —— 上报面越小，越不容易被误当成判据。
 */
export function windowBlock({ sessionId, folder = null, name = null, uiKind = 1, remoteName = null } = {}) {
  return {
    sessionId,
    workspace: { name, folders: folder ? [folder] : [] },
    uiKind,
    remoteName,
  }
}

/** `vscode.getSelection` 的合法返回（`response-contract.js` 逐字段校验）。 */
export function selectionResult(file) {
  return {
    text: 'hi', file, start: { line: 1, column: 1 }, end: { line: 1, column: 3 }, isEmpty: false,
  }
}

/** `vscode.getDocumentState` 的合法返回（T34 起的绑定读）。 */
export function stateResult(file, version = 7, incarnation = 'inc-A') {
  return {
    file, version, incarnation, isDirty: false, eol: 'lf', lineCount: 3, textLength: 11,
  }
}

/**
 * 一个"窗口"：裸 TCP 连桥，带上 W3 的 `window` 块报到，并记录收到的每一条帧。
 *
 * @param {{port:number,token:string}} server 真 kit server
 * @param {{label:string, file?:string, version?:number, incarnation?:string,
 *          window?:object, isRogue?:boolean}} opts
 *        `isRogue: true` = 只建 TCP，什么都不发（未准入连接，用来证明它既不在
 *        `list()` 里、也解析不到 —— 设计 §4）。
 */
export async function windowClient(server, opts = {}) {
  const {
    label,
    file = '/ws/a.js',
    version = 7,
    incarnation = `inc-${label}`,
    isRogue = false,
  } = opts
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method, params) => {
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
      if (method === 'bridge.grantRevoke') return { ok: true }
      if (method === 'bridge.ping') return { pong: true }
      // 返回里带上是哪个窗口答的 —— A4 靠它断言"帧去了 target"，不靠猜。
      if (method === 'vscode.getSelection') return selectionResult(`/ws/from-${label}.js`)
      if (method === 'vscode.getDocumentState') return stateResult(file, version, incarnation)
      if (method === 'vscode.applyEdit') {
        return { applied: true, file, saved: false, textLength: (params?.text ?? '').length }
      }
      throw new Error(`unexpected method ${method}`)
    },
  })
  socket.on('data', createLineSplitter((line) => {
    const msg = JSON.parse(line)
    seen.push(msg)
    if (!isRogue) link.handleLine(line)
  }))
  socket.on('error', () => {})
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    label,
    socket,
    seen,
    count(method) { return seen.filter((m) => m.method === method).length },
    last(method) { return seen.filter((m) => m.method === method).at(-1) },
    /**
     * 报到。第三个参数是 W3 的 `window` 块 —— **不给就整块不出现**，
     * 这正是"老扩展 / 编辑期删掉 window 块"的形状（守门测试靠它）。
     */
    hello(ptv = 1, capabilities = WINDOW_CAPS, window = undefined) {
      return link.request('bridge.hello', {
        client: `win-${label}`,
        extensionVersion: '0.3.1',
        protocolVersion: ptv,
        capabilities,
        ...(window ? { window } : {}),
      })
    },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

/** 等某个条件成立（带上限，避免测试挂死）。 */
export function waitFor(fn, { timeoutMs = 3000, intervalMs = 10, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const iv = setInterval(() => {
      let ok = false
      try { ok = fn() } catch { ok = false }
      if (ok) { clearInterval(iv); resolve() }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(iv)
        reject(new Error(`timed out waiting for ${label}`))
      }
    }, intervalMs)
    iv.unref?.()
  })
}

/**
 * 起一个真的 kit（插件 apply → boot）+ 若干窗口。
 *
 * @param {{home?:string}} [opts] `home` 传进来就复用（"DSH 重启"用例：号从
 *        `windows.json` 恢复，连接序号从 1 重新数）。
 */
export async function withKit(opts = {}) {
  const home = opts.home ?? tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, {
    consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {},
  })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v.forPlugin(TEST_CONSUMER, { declared: 'delete' })
  const server = handle.kit.server
  const clients = []

  /** 开一个窗口并让它报到。`opts.window` 决定 hello 里有没有 W3 的块。 */
  const open = async (o = {}) => {
    const c = await windowClient(server, o)
    await c.hello(1, o.capabilities ?? WINDOW_CAPS, o.window)
    clients.push(c)
    return c
  }

  /** 只建 TCP、不报到（未准入连接）。 */
  const openRogue = async (o = {}) => {
    const c = await windowClient(server, { ...o, label: o.label ?? 'rogue', isRogue: true })
    clients.push(c)
    return c
  }

  const list = () => svc.vscode.windows.list()

  const closeAll = async () => {
    for (const c of clients) if (!c.socket.destroyed) await c.close().catch(() => {})
  }

  const cleanup = async ({ keepHome = false } = {}) => {
    await closeAll()
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    if (!keepHome) rmSync(home, { recursive: true, force: true })
  }

  return { home, ctx, handle, kit: handle.kit, svc, server, clients, open, openRogue, list, cleanup }
}

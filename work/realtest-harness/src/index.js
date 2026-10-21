/**
 * 真机验证用「第三方消费者」控制探针（**测试脚本，不是产品代码**）。
 *
 * 用途：让 T6 的多窗口仲裁验证能对**真实的 `dsh web` 进程**按需发起桥接请求。
 * 只 import 公开 API（`ctx.get('dshVscodeKit')`），不知道 TCP / 端口 / token 的存在 ——
 * 与 `dsh-kit-demo` 同一接法，因此它同时也证明了「第三方插件零耦合」这条主张。
 *
 * 为什么不直接用 dsh-kit-demo：demo 的 smoke 是启动时一次性脚本，无法
 * 「关掉一个窗口 → 立刻再调一次」这种按需时序操作，而多窗口仲裁的缺口恰恰在时序上。
 *
 * 控制口（只在 127.0.0.1 上）：
 *   POST /call     {"method":"vscode.getSelection","params":{},"timeoutMs":8000}
 *                  → {"ok":true,"result":...,"elapsedMs":n}
 *                  → {"ok":false,"code":-32004,"message":"...","elapsedMs":n}
 *   GET  /snapshot → kit.snapshot()（含 connections = links.size）
 *   GET  /health   → {"ok":true,"pid":n}
 */

import { createServer } from 'node:http'

export const name = 'dsh-kit-realtest-harness'

/** 等主体服务就绪后加载；纯声明，不 import cordis。 */
export const inject = ['dshVscodeKit']

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 3097)
  const log = (m) => console.log(`[harness] ${m}`)

  const kit = ctx.get('dshVscodeKit')
  if (!kit) {
    log('dshVscodeKit unavailable; harness stays idle')
    return
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(200, { ok: true, pid: process.pid })
      }
      if (req.method === 'GET' && req.url === '/snapshot') {
        return send(200, { ok: true, snapshot: kit.snapshot() })
      }
      if (req.method === 'POST' && req.url === '/call') {
        const raw = await readBody(req)
        const { method, params, timeoutMs } = JSON.parse(raw || '{}')
        if (typeof method !== 'string' || method === '') {
          return send(400, { ok: false, message: 'method is required' })
        }
        const t0 = Date.now()
        try {
          const result = await kit.request(method, params ?? {}, { timeoutMs: timeoutMs ?? 8000 })
          const elapsedMs = Date.now() - t0
          log(`call ${method} ok ${elapsedMs}ms`)
          return send(200, { ok: true, result, elapsedMs })
        } catch (err) {
          const elapsedMs = Date.now() - t0
          log(`call ${method} FAIL code=${err?.code} ${err?.message} ${elapsedMs}ms`)
          return send(200, {
            ok: false,
            code: err?.code,
            message: err?.message ?? String(err),
            data: err?.data,
            elapsedMs,
          })
        }
      }
      send(404, { ok: false, message: 'not found' })
    } catch (err) {
      send(500, { ok: false, message: String(err?.message ?? err) })
    }
  })

  server.on('error', (err) => log(`control server error: ${err?.message ?? err}`))
  server.listen(port, '127.0.0.1', () => log(`control server on 127.0.0.1:${port}`))
  server.unref?.()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { try { server.close() } catch { /* ignore */ } })
  }
  log('ready')
}

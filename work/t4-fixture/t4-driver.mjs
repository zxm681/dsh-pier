/**
 * T4 真机驱动：DSH 侧起 kit 监听，由命令文件驱动。
 *
 * 为什么不用交互 stdin：本卡要在多次工具调用之间保持**同一条** grant / 同一个端口，
 * 只能常驻一个进程；而 Git Bash 后台进程的 stdin 在调用之间不好接。改成轮询命令文件：
 *   - 读 work/t4-cmd.txt 里追加的每一行 JSON（记录已消费的字节偏移）
 *   - 结果按行 append 到 work/t4-driver.log（`RESULT <json>`）
 * 这样每一条实验证据都能被后续调用的 cat/grep 读到，且顺序稳定。
 *
 * 用法：DSH_HOME 默认走 resolveDshHome()（即 ~/.dsh），与真机扩展的默认发现路径一致。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { apply } from '../packages/dsh-vscode-kit/src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CMD = path.join(here, 't4-cmd.txt')
const LOG = path.join(here, 't4-driver.log')

const out = (line) => {
  appendFileSync(LOG, line + '\n')
  console.log(line)
}
const result = (id, payload) => out(`RESULT ${JSON.stringify({ id, ...payload })}`)

const ctx = {
  provide: () => {},
  effect: (fn) => { try { return fn() } catch { return () => {} } },
}

const handle = apply(ctx, { onLog: (lv, m) => out(`LOG ${lv}: ${m}`) })
await handle.boot
const kit = handle.kit
out(`READY port=${kit.server.port}`)

/** 等一个「编辑器已准入且报过 hello」的连接。 */
async function waitEditor(ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const ed = kit.lastEditor
    if (ed) return ed
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

const commands = {
  async state() {
    const ed = kit.lastEditor
    return {
      port: kit.server.port,
      trusted: kit.server.trusted?.size ?? null,
      editor: ed
        ? {
            client: ed.client,
            extensionVersion: ed.extensionVersion,
            protocolVersion: ed.protocolVersion,
            capabilities: ed.capabilities,
          }
        : null,
      grants: kit.grants.entries(),
    }
  },
  async waitEditor({ ms = 60000 }) {
    const ed = await waitEditor(ms)
    return { authorized: ed !== null, editor: ed ? { client: ed.client, extensionVersion: ed.extensionVersion } : null }
  },
  async grant({ sessionId }) {
    const g = await kit.editing.grant({ sessionId, windowId: 't4-window' })
    return { grant: g }
  },
  async applyEdit({ file, range, text, opts }) {
    try {
      const r = await kit.vscode.applyEdit({ file, range, text }, opts ?? { timeoutMs: 15000 })
      return { ok: true, result: r }
    } catch (err) {
      return { ok: false, error: { code: err?.code ?? null, message: err?.message ?? String(err), data: err?.data ?? null } }
    }
  },
  async openFile({ path: p, line, column }) {
    try {
      const r = await kit.vscode.openFile({ path: p, line, column }, { timeoutMs: 15000 })
      return { ok: true, result: r }
    } catch (err) {
      return { ok: false, error: { code: err?.code ?? null, message: err?.message ?? String(err), data: err?.data ?? null } }
    }
  },
  async request({ method, params }) {
    try {
      const r = await kit.request(method, params ?? {}, { timeoutMs: 15000 })
      return { ok: true, result: r }
    } catch (err) {
      return { ok: false, error: { code: err?.code ?? null, message: err?.message ?? String(err), data: err?.data ?? null } }
    }
  },
  async listEditors() {
    try {
      return { ok: true, result: await kit.vscode.listOpenEditors({}, { timeoutMs: 15000 }) }
    } catch (err) {
      return { ok: false, error: { code: err?.code ?? null, message: err?.message ?? String(err) } }
    }
  },
  async revoke({ id }) {
    return { revoked: kit.editing.revoke(id ?? null) }
  },
  async quit() {
    setTimeout(() => process.exit(0), 200)
    return { quitting: true }
  },
}

let offset = 0
async function drain() {
  if (!existsSync(CMD)) return
  const raw = readFileSync(CMD, 'utf8')
  if (raw.length <= offset) return
  const chunk = raw.slice(offset)
  offset = raw.length
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let cmd
    try { cmd = JSON.parse(line) } catch (e) { result(null, { ok: false, error: 'bad-json' }); continue }
    const fn = commands[cmd.cmd]
    if (!fn) { result(cmd.id ?? null, { ok: false, error: `unknown cmd ${cmd.cmd}` }); continue }
    try {
      const r = await fn(cmd)
      result(cmd.id ?? null, { cmd: cmd.cmd, ok: true, ...r })
    } catch (err) {
      result(cmd.id ?? null, { cmd: cmd.cmd, ok: false, error: { message: err?.message ?? String(err), code: err?.code ?? null } })
    }
  }
}

setInterval(() => { drain().catch((e) => out(`DRAIN-ERR ${e?.message ?? e}`)) }, 100)

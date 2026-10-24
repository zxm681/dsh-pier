/**
 * 窗口注册表（W1）：`windowId` 由 **DSH 侧签发**并持久化。
 *
 * 为什么不从 VS Code 拿 id（多窗口寻址设计 §0/§1.1）：
 *  - 一条连接 = 一个窗口（`extension.js` 每个窗口 activate 各建一条连接），但连接会断，
 *    重连后 `connSeq` 就变了；我们要给"同一个窗口"一个跨重连不变的名字。
 *  - `connSeq` 是**进程内序号**，只用来排序与诊断；它不是身份，也不能和 windowId 互相比
 *    （设计 §1.2 的"禁止 `windowId = String(connSeq)`"）。
 *
 * 签发规则（§1.2/§1.3）：建连时算一条指纹 `sessionId + workspace 根 + uiKind`，
 * 在 `~/.dsh/dsh-vscode-kit/windows.json` 里找命中 → 复用原 `win-NN`；
 * 找不到 → 发新号（序号只增，**永不复用**）。
 * 指纹不稳（老扩展没上报、或没有 sessionId / 没有工作区）→ `tmp-<connSeq>` + `stable:false`，
 * 且**不落盘**：临时号的生命周期就是这条连接，写进文件只会污染下次启动的签发。
 *
 * ⚠️ `windowId` **不是安全判据**（§1.2 末段）。它只回答"这是哪个窗口"，
 * 准入与授权一律看 token / grant，不看它。
 *
 * 零依赖：只用 node:fs / node:crypto / node:path —— 与 discovery.js 同一套原子写范式。
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { discoveryDir } from './discovery.js'
import { canonicalPath } from './paths.js'

/** 注册表文件名（与发现文件同目录；`sweepDiscoveryDir` 会保留非数字前缀的 json）。 */
export const WINDOWS_FILE_NAME = 'windows.json'

/**
 * 注册表最多保留多少条窗口记录。
 *
 * 没有上限的文件会随着人开窗历史一直长；淘汰按 `lastSeenAt` 从旧到新 ——
 * 被淘汰的窗口下次连上来只是拿一个新号（`win-NN` 序号继续往上走），不会串到别人身上。
 */
export const WINDOW_RECORD_LIMIT = 64

/** 注册表文件绝对路径。 */
export function windowsFilePath(dshHome) {
  return join(discoveryDir(dshHome), WINDOWS_FILE_NAME)
}

/**
 * `target` 认得的 windowId 形状。
 *
 * 两种都是 `windows.list()` 真会报出来的号：
 *  - `win-NN`：本端签发的稳定号；
 *  - `tmp-<connSeq>`：指纹不稳时的降级号（老扩展 / 没有工作区）——§6 要求这种情况下
 *    target 仍然可用，所以 `tmp-*` 必须能被寻址，只是它随连接生灭。
 *
 * 其余写法（label、裸数字、空串）**不解析**：宁可报 `window-not-found`，
 * 也不要发明一套"看起来也行"的写法 —— target 是路由到某个窗口的凭据，含糊就是事故。
 */
export const WINDOW_ID_PATTERN = /^(?:win|tmp)-[A-Za-z0-9_-]+$/

/** `win-NN` → 序号；不是本端签发的形状返回 null。 */
export function sequenceOf(windowId) {
  if (typeof windowId !== 'string') return null
  const m = /^win-(\d+)$/.exec(windowId)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** `UiKind` 数字 → 稳定串（VS Code：1=Desktop、2=Web）。未知值原样串化。 */
export function describeUiKind(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (value === 1) return 'desktop'
    if (value === 2) return 'web'
    return String(value)
  }
  if (typeof value === 'string' && value.trim() !== '') return value.trim().toLowerCase()
  return null
}

/** 路径最后一段（Windows/POSIX 都认；只用于给人看的 label）。 */
export function folderNameOf(folderPath) {
  if (typeof folderPath !== 'string' || folderPath === '') return null
  const parts = folderPath.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length > 0 ? parts[parts.length - 1] : null
}

/**
 * 归一化 hello 里的 `window` 块（**身份候选**，不参与任何判定）。
 *
 * 只做形状收口：认不出来的字段一律降级成 null，绝不抛 ——
 * 一个坏字段不该让建连失败，更不该让 hello 带崩（§6 兼容：老扩展根本没有这个块）。
 *
 * @param {unknown} raw
 * @returns {{sessionId: string|null, workspace: {name: string|null, folders: string[]}|null,
 *   uiKind: string|null, remoteName: string|null, focused: boolean|null}|null}
 */
export function normalizeWindowBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim() !== ''
    ? raw.sessionId.trim()
    : null

  const wsRaw = raw.workspace && typeof raw.workspace === 'object' && !Array.isArray(raw.workspace)
    ? raw.workspace
    : null
  const folders = Array.isArray(wsRaw?.folders)
    ? wsRaw.folders.filter((f) => typeof f === 'string' && f !== '')
    : []
  const declaredName = typeof wsRaw?.name === 'string' && wsRaw.name !== '' ? wsRaw.name : null
  const name = declaredName ?? folderNameOf(folders[0])
  const workspace = name || folders.length > 0 ? { name, folders } : null

  return {
    sessionId,
    workspace,
    uiKind: describeUiKind(raw.uiKind),
    remoteName: typeof raw.remoteName === 'string' && raw.remoteName !== '' ? raw.remoteName : null,
    focused: typeof raw.focused === 'boolean' ? raw.focused : null,
  }
}

/**
 * 指纹里的路径归一化：分隔符统一、去掉尾斜杠，再统一到**对外可见形态**（`canonicalPath`）。
 *
 * ★ T60：末尾那一步以前是"把盘符折成小写"，即注册表键自己发明了第三种大小写写法，
 * 与 RPC 出口（大写盘符）、事件 payload（小写盘符）三足鼎立。现在它直接调用同一个
 * `canonicalPath`：盘符大写（这是唯一被两条管线改写过的字节），段名与顺序原样保留 ——
 * 键的**身份**语义与旧实现等价（旧实现只改盘符大小写，而 Windows 路径比较本来就不区分
 * 盘符大小写），只是字面写法跟着对外形态走。老注册表的键由 `_load` 里的
 * `renormalizeFingerprint` 就地迁移，`win-NN` 号不变。
 */
function normalizeRoot(p) {
  const out = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return canonicalPath(out)
}

/**
 * 把**旧格式**指纹就地迁移成当前格式（T60）。旧格式 = 盘符被折成小写
 * （`["s","d:/ws","desktop"]`）；新格式 = `["s","D:/ws","desktop"]`。
 *
 * 只重算第二段（workspace 根），其余原样带回；解析不了就原样返回（不猜、不丢记录）。
 * 迁移是**幂等**的：新键重算后不变。
 *
 * @param {string} fingerprint
 * @returns {string}
 */
function renormalizeFingerprint(fingerprint) {
  let parts
  try {
    parts = JSON.parse(fingerprint)
  } catch {
    return fingerprint
  }
  if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[1] !== 'string') return fingerprint
  const root = normalizeRoot(parts[1])
  if (root === parts[1]) return fingerprint
  return JSON.stringify([parts[0], root, parts[2]])
}

/**
 * 指纹 = `sessionId + workspace 根 + uiKind`（§1.3 的稳定性矩阵）。
 *
 * @returns {string|null} `null` = 指纹不稳（没有 sessionId、或没有工作区）→ 调用方降级 `tmp-*`
 */
export function windowFingerprint(block) {
  if (!block || typeof block !== 'object') return null
  if (typeof block.sessionId !== 'string' || block.sessionId === '') return null

  const folders = Array.isArray(block.workspace?.folders) ? block.workspace.folders : []
  const declaredName = typeof block.workspace?.name === 'string' && block.workspace.name !== ''
    ? block.workspace.name
    : null
  const root = folders[0] ?? declaredName
  if (typeof root !== 'string' || root === '') return null

  // JSON.stringify 而不是字符串拼接：三段之间不会因为分隔符出现在内容里而撞车。
  return JSON.stringify([block.sessionId, normalizeRoot(root), block.uiKind ?? 'unknown'])
}

/** `windows.list()` 的 label（§2.2）：`<workspace.name 或文件夹名> · <windowId>`。 */
export function windowLabel(workspace, windowId) {
  const name = typeof workspace?.name === 'string' && workspace.name !== ''
    ? workspace.name
    : folderNameOf(workspace?.folders?.[0]) ?? 'unnamed'
  return `${name} · ${windowId}`
}

/**
 * 窗口注册表：读一次、按需写回。
 *
 * 写失败只 log 不抛：签发号是**尽力而为**的事，为了存不下这张表而拒掉一条能用的连接
 * 是把可用性换给了一个诊断字段。
 */
export class WindowRegistry {
  /**
   * @param {{file?: string, onLog?: (level: string, msg: string, data?: any) => void}} [opts]
   */
  constructor(opts = {}) {
    this.file = typeof opts.file === 'string' && opts.file !== '' ? opts.file : windowsFilePath()
    this.onLog = opts.onLog
    this.loaded = false
    /** @type {Array<{windowId: string, fingerprint: string, createdAt: number, lastSeenAt: number}>} */
    this.windows = []
    /** 已签发的最大序号（只增，永不复用）。 */
    this.seq = 0
  }

  /** 懒读文件：注册表不在构造期做 I/O（插件被卸载/未启用时不该碰磁盘）。 */
  _load() {
    if (this.loaded) return
    this.loaded = true
    let payload = null
    try {
      payload = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      payload = null // 文件不存在 / 半截 JSON / 不是文件：一律当空表，绝不因此拒连
    }
    const list = Array.isArray(payload?.windows) ? payload.windows : []
    /** 是否发生过旧格式迁移 —— 只有真迁过才在下次写盘时落回去。 */
    this.migrated = false
    for (const rec of list) {
      const windowId = typeof rec?.windowId === 'string' ? rec.windowId : null
      const raw = typeof rec?.fingerprint === 'string' ? rec.fingerprint : null
      const n = sequenceOf(windowId)
      if (windowId === null || raw === null || n === null) continue
      // ★ T60：旧盘符小写形态就地迁移成当前形态（幂等）。`win-NN` 号不变，
      // 不重写过的旧记录；没有任何旧记录时 `migrated` 保持 false，不会无谓写盘。
      const fingerprint = renormalizeFingerprint(raw)
      if (fingerprint !== raw) this.migrated = true
      this.windows.push({
        windowId,
        fingerprint,
        createdAt: Number.isFinite(rec?.createdAt) ? rec.createdAt : Date.now(),
        lastSeenAt: Number.isFinite(rec?.lastSeenAt) ? rec.lastSeenAt : Date.now(),
      })
      if (n > this.seq) this.seq = n
    }
  }

  /** 这个号是否由本端签发过（用于把"曾经有过、现在不在"判成 `window-closed`）。 */
  has(windowId) {
    if (typeof windowId !== 'string' || windowId === '') return false
    this._load()
    return this.windows.some((w) => w.windowId === windowId)
  }

  /**
   * 给一条连接签发/复用 windowId。
   *
   * @param {{fingerprint?: string|null, connSeq?: number}} input
   * @returns {{windowId: string, stable: boolean}}
   */
  assign(input = {}) {
    this._load()
    const { fingerprint, connSeq } = input

    if (typeof fingerprint !== 'string' || fingerprint === '') {
      const seqText = Number.isInteger(connSeq) ? String(connSeq) : 'unknown'
      return { windowId: `tmp-${seqText}`, stable: false }
    }

    const now = Date.now()
    const hit = this.windows.find((w) => w.fingerprint === fingerprint)
    if (hit) {
      hit.lastSeenAt = now
      this._save()
      return { windowId: hit.windowId, stable: true }
    }

    this.seq += 1
    const record = {
      windowId: `win-${String(this.seq).padStart(2, '0')}`,
      fingerprint,
      createdAt: now,
      lastSeenAt: now,
    }
    this.windows.push(record)
    this._prune()
    this._save()
    return { windowId: record.windowId, stable: true }
  }

  /** 超出上限时按 `lastSeenAt` 淘汰最旧的（重写同一份文件，不涉及任何删除调用）。 */
  _prune() {
    if (this.windows.length <= WINDOW_RECORD_LIMIT) return
    this.windows.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    this.windows = this.windows.slice(this.windows.length - WINDOW_RECORD_LIMIT)
  }

  /** 原子写（临时文件 → chmod 0600 → rename），失败只 log。 */
  _save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, windows: this.windows }, null, 2), { mode: 0o600 })
      try { chmodSync(temp, 0o600) } catch { /* Windows 上 mode 常被忽略 */ }
      renameSync(temp, this.file)
    } catch (err) {
      this.onLog?.('warn', `window registry not persisted: ${err?.message ?? err}`, { file: this.file })
    }
  }
}

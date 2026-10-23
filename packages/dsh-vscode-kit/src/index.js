/**
 * dsh-vscode-kit —— DSH 侧桥接协议库的插件入口。
 *
 * 设计约束（阶段4 §4 公开 API 面，先定死）：
 *  1. 零依赖：不 import '@deepseek-ai/cordis'。服务用 ctx.provide(name, 普通对象) 注册，
 *     已实测可用（见 docs/phase5-打样日志.md §1.1）。消费者用 inject: ['dshVscodeKit'] 拿到。
 *  2. 消费者只见公开 API：request(method, params) + 糖衣 kit.vscode.*。
 *     不知道 TCP、端口、发现文件、token 的存在。
 *  3. 能力缺失降级：返回 -32005 unsupported，不崩溃。
 *
 * 插件形状：函数式 cordis 插件（export { name, inject, apply }），与 dsh-agy-link 同款。
 */

import {
  startBridgeServer, listLiveBridges, discoveryDir, resolveDshHome, liveTrustedLinks,
} from './server.js'
import {
  BridgeError, ERR, PROTOCOL_VERSION, SUPPORTED_PROTOCOL, hasCapability, judgeProtocolVersion,
} from './protocol.js'
import {
  WINDOW_ID_PATTERN, WindowRegistry, normalizeWindowBlock, windowFingerprint, windowLabel,
  windowsFilePath,
} from './windows.js'
import { validateResponse } from './response-contract.js'
import {
  GrantStore, GRANT_REASONS, GRANT_TOMBSTONE_LIMIT, WRITE_METHODS, isWriteMethod,
  judgeGrant, judgeSession, dshWriteGate, editNotBoundError, rejectParamsSessionId,
  assertWritableNotNotified,
} from './grant.js'
import { Whitelist, UNBOUND_CONSUMER, HOST_CONSUMER } from './whitelist.js'

/** cordis 插件名，必须与 package.json 的 name 一致。 */
export const name = 'dsh-vscode-kit'

/**
 * 插件依赖的服务。
 *
 * 空数组是刻意的：本库不依赖任何 DSH 内部服务，才能在任何 profile 里加载而不被
 * 「服务缺失 → 插件卸载」的机制带走。
 */
export const inject = []

/** 本端（DSH 侧）声明支持的能力：DSH 能接收的入站方法族。 */
const INBOUND_CAPABILITIES = ['bridge.ping']

/**
 * 对端在 hello 里声明"我回锚点时带文档实例身份"的 feature 名（T34）。
 *
 * ⚠️ 与 `packages/dsh-kit-bridge/src/connector.js` 的 `PEER_FEATURES` **必须逐字相同**
 * （bridge 侧的 test/t34-incarnation.test.js 直接比对两个常量）。
 *
 * 为什么用 hello 的 `features` 而不是 `capabilities`：`capabilities` 是**方法名**清单，
 * 回答"你能接哪些方法"；这里要回答的是"你的锚点里有没有 `incarnation`、你会不会判它"。
 * 声明了 ⇒ 糖衣强制要求 `expectedIncarnation`；没声明（老扩展）⇒ 不强制，
 * 否则两端会互相锁死在升级窗口里。
 */
export const PEER_FEATURE_DOCUMENT_INCARNATION = 'document-incarnation'

/**
 * **会话绑定的读方法**（T34）：这些方法一旦拿到 `opts.sessionId`，目标连接就必须是
 * 该会话 grant 记录里的那条 `link`，**不许**回退到 `_activeLink()`。
 *
 * 为什么（T5 的 Q1，高危）：写路径早就按 grant 绑定了，但读还是"问最活跃的窗口"。
 * A 拿 grant、B 后连 ⇒ 锚点从 B 读、写入落 A。两个窗口版本数字一重合，按 B 视角的
 * 坐标就静默写进了 A 的缓冲区 —— 版本门一个字都拦不住（数字相等）。
 * 修法就是把读也钉在同一条连接上：**读和写必须是同一份视角**。
 */
export const SESSION_BOUND_READS = Object.freeze(['vscode.getDocumentState'])

/** 默认等待编辑器连接的时间。 */
const DEFAULT_CONNECT_WAIT_MS = 3_000

/**
 * 默认等待对端 hello（拿协议版本）的时间。
 *
 * hello 之前没有对端版本 —— 契约 §4.1 ① 第 3 行 + §7 #3 要求「未知版本保守处理」，
 * 即不得推断成 v1。所以先等一小段（扩展连上后立刻会报 hello），等不到就 fail-closed。
 */
const DEFAULT_HELLO_WAIT_MS = 1_000

/**
 * 等扩展侧 `bridge.grant` 回执的上限（评审 F9）。
 *
 * 3s 是"本机 IPC 往返 + 扩展侧存表"的量级：正常路径几毫秒就回，超时基本等于
 * handler 没装 / 连接半死。宁可让 `grant()` 报错（用户重试），也不要把
 * `delivered:true` 变成"写进 socket 了"的同义词。
 */
const DEFAULT_GRANT_ACK_TIMEOUT_MS = 3_000

/**
 * 「写入必须带版本锚点」的本地闸门（T30）。
 *
 * 位置：**糖衣里、request() 之前**。这里抛 = 一个字节都没发出去。
 * 为什么不靠对端的 -32602 兜底：对端拒是一次"谈成了但被否"，会经过网络、会重试、
 * 会在日志里长得像故障；而这里是编程错误（调用方没读版本就写），越早越响越安全。
 * 绕过糖衣直接 `kit.request('vscode.applyEdit', {...})` 仍然会被扩展侧 -32602 拒 ——
 * 两道闸，本地这道负责"让安全路径成为唯一路径"，远端那道负责"不信本端"。
 *
 * @param {string} method
 * @param {object} params
 * @throws {BridgeError} ERR.INVALID_PARAMS（`data.stage === 'local'`）
 */
function assertLocalExpectedVersion(method, params) {
  const v = params?.expectedVersion
  if (Number.isInteger(v) && v >= 0) return
  const reason = v === undefined ? 'expected-version-missing'
    : typeof v !== 'number' ? 'expected-version-not-a-number'
      : !Number.isInteger(v) ? 'expected-version-not-an-integer'
        : 'expected-version-negative'
  throw new BridgeError(ERR.INVALID_PARAMS,
    'vscode.applyEdit requires a version anchor: pass expectedVersion (integer >= 0) read from '
    + 'kit.vscode.getDocumentState(file).version. Refusing to send a write without one.',
    { method, reason, stage: 'local', got: { type: typeof v } })
}

/**
 * 「写锚点必须带文档实例身份」的本地闸门（T34 引入；**T35 收紧为无条件必填**）——
 * 与 `assertLocalExpectedVersion` 同族：在这里抛 = 一个字节都没发出去。
 *
 * ## 位置：**所有写入口共用的发送路径**（`request()` 里）
 *
 * T34 时这道门只装在糖衣 `kit.vscode.applyEdit` 里，且"仅当对端 hello 声明了
 * `document-incarnation` 才强制"。T6 终审把那个设计判掉了（H1）：公开的
 * `kit.request('vscode.applyEdit', …)` **绕过糖衣**，省略 `expectedIncarnation` 就一路写成功；
 * 两个窗口版本数字相同时，按另一窗口的视图覆盖了授权窗口中的人工内容，还报 `applied:true`。
 * 于是本闸门移到 `request()` 的写分支里 —— raw / 糖衣 / 位置形态 / 对象形态
 * **只有这一条发送路径**，谁也绕不过去。糖衣里那次调用保留为"更早、更清楚"的重复闸。
 *
 * ## 什么时候强制：**永远**
 *
 * 不再看对端有没有公告化身支持。公告只说明"对端能回 incarnation"，它不是强制条件 ——
 * 把强制绑在公告上，等于"对端一沉默，本端就把判据关掉"。理由一句话：**没有化身身份就
 * 无法证明写的是同一个文档实例**，而版本号是每个实例各自计数的、关闭重开后被复用。
 *
 * ## ★ 有意的不兼容收紧（被接受的代价）
 *
 * 旧版扩展（不返回 `incarnation`）从此**不能被写**：调用方拿不到化身 ⇒ 这里 `-32602`。
 * 这不是回归，而是把"做不到唯一保证的写"从"静默放行"改成"明确拒写"。
 *
 * ## 两件不同的事，同一个 reason 家族
 *
 *  - `expected-incarnation-missing`：该给没给（含"对端不公告"的老端）；
 *  - `expected-incarnation-not-a-non-empty-string`：给了但不是非空字符串。
 *    空串尤其危险 —— 它会让"宿主读不到化身"与"调用方给了空串"互相匹配成功。
 *
 * `data`：`{ method, reason, stage: 'local', got: {type} }`。
 * 码位 `-32602`（参数错）：这是**调用方自己的编程错误**，不是对端拒绝，也不是授权问题；
 * 与 `-32012`（对端判你锚点过期了）分工明确 —— 这里根本没发出去。
 *
 * @param {string} method
 * @param {object} params
 * @throws {BridgeError} ERR.INVALID_PARAMS（`data.stage === 'local'`）
 */
function assertLocalExpectedIncarnation(method, params) {
  const v = params?.expectedIncarnation
  if (typeof v === 'string' && v !== '') return
  const reason = v === undefined
    ? 'expected-incarnation-missing'
    : 'expected-incarnation-not-a-non-empty-string'
  throw new BridgeError(ERR.INVALID_PARAMS,
    'vscode.applyEdit requires the document-instance anchor: pass expectedIncarnation '
    + '(the string returned as vscode.getDocumentState.incarnation) together with expectedVersion. '
    + 'Refusing to send a write that cannot tell "the same document" from "a reopened one".',
    { method, reason, stage: 'local', got: { type: typeof v } })
}

/**
 * 归一化 `vscode.save` 的两种调用形态（T39）：
 *   `save(file, { expectedVersion, expectedIncarnation, expectedDisk, grant?, timeoutMs? })`
 *   `save({ file, expectedVersion, expectedIncarnation, expectedDisk, grant? }, opts?)`
 *
 * 与 `normalizeApplyEditArgs` 同一条理由：锚点是**请求参数**，不是传输选项 ——
 * 留在 opts 里就等于宿主根本收不到（T30 的 `includeText` 踩过一次）。`timeoutMs` /
 * `waitForEditor` / `sessionId` 这类传输选项继续走 opts。
 *
 * ★ T40：`vscode.deleteFile` **复用本函数**。它的锚点字段全集与 `vscode.save` 完全相同
 * （双锚点 + 磁盘锚点 + grant），复制一份只会让两处慢慢漂移；名字带 save 是历史，判定
 * 是"哪些字段属于请求参数"，与具体能力无关。
 */
function normalizeSaveArgs(args) {
  const first = args[0]
  if (typeof first === 'string') {
    const opts = isPlainObject(args[1]) ? args[1] : {}
    const params = { file: first }
    for (const k of SAVE_ANCHOR_FIELDS) if (opts[k] !== undefined) params[k] = opts[k]
    return { params, opts }
  }
  const params = isPlainObject(first) ? { ...first } : {}
  const opts = isPlainObject(args[1]) ? args[1] : {}
  for (const k of SAVE_ANCHOR_FIELDS) {
    if (params[k] === undefined && opts[k] !== undefined) params[k] = opts[k]
  }
  return { params, opts }
}

/**
 * 「落盘必须有磁盘锚点」的本地闸门（T39 / 契约 §6.2.3）—— 与版本/化身闸门同族：
 * 在这里抛 = 一个字节都没发出去，宿主零调用。
 *
 * 形状固定 `{mtime, size}`，两个非负整数：
 *  - 缺 / 不是对象 / 字段类型不对 → 各自一个 `reason`，**不回显值**（错误 data 会进日志）；
 *  - 整数与 `>= 0` 一起判：`NaN`、`Infinity`、浮点毫秒进来都会让"等值比较"变成
 *    "永远不等"（看起来像磁盘一直在变，实际是参数算错了）。
 *
 * @param {string} method
 * @param {object} params
 * @throws {BridgeError} ERR.INVALID_PARAMS（`data.stage === 'local'`）
 */
function assertLocalExpectedDisk(method, params) {
  const v = params?.expectedDisk
  let reason = null
  if (v === undefined) reason = 'expected-disk-missing'
  else if (!isPlainObject(v)) reason = 'expected-disk-not-an-object'
  else {
    for (const key of ['mtime', 'size']) {
      const n = v[key]
      if (typeof n !== 'number') { reason = `expected-disk-${key}-not-a-number`; break }
      if (!Number.isInteger(n) || n < 0) { reason = `expected-disk-${key}-not-a-non-negative-integer`; break }
    }
  }
  if (reason === null) return
  const action = method === 'vscode.deleteFile' ? 'delete' : 'save'
  throw new BridgeError(ERR.INVALID_PARAMS,
    `${method} requires the disk anchor: pass expectedDisk = {mtime, size} `
    + '(integer mtime in ms and byte size) — the values you observed on disk just now. '
    + `Refusing to send a ${action} that cannot tell "the bytes I saw" from "bytes someone changed".`,
    { method, reason, stage: 'local', got: { type: typeof v } })
}

/**
 * 调用方上下文里的会话身份（`opts.sessionId`）。
 *
 * 唯一可信来源是**调用方自己的 DSH 上下文**，不是线路数据：`params.sessionId` 由
 * `rejectParamsSessionId` 在写路径上直接拒（评审 F2）。空串按"没给"处理 ——
 * 空串当会话会让 `_grantForSession` 静默匹配不到，错误会变成难读的 -32010。
 * @param {{sessionId?: unknown}} [opts]
 * @returns {string|null}
 */
function readSessionId(opts) {
  const v = opts?.sessionId
  return typeof v === 'string' && v !== '' ? v : null
}

/** 只是对象（不是数组/null/类实例的壳子）—— 形态判定用。 */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 从 `opts.target` 里取窗口寻址目标（多窗口寻址 §1.2：只认 `windowId` 或 `#connSeq`）。
 *
 * 返回 `{raw, text}` 而不是直接返回字符串：报错时 `raw` 要能原样回显
 * （"你说的是 `{target: 1}` 还是 `{target: '1'}`" 对排障是两件事），
 * 而解析只用 `text`。`null` = **没给** —— 与"给了但解析不出来"必须区分：
 * 前者走老的活跃连接路径，后者是错误。
 *
 * 数字/对象形态**不做善意解释**（不把 `1` 当 connSeq、也不当 windowId 序号）：
 * 两种意图都能写清楚（`'#1'` / `'win-01'`），含糊的 target 一律按解析失败处理。
 *
 * @param {{target?: unknown}} [opts]
 * @returns {{raw: unknown, text: string}|null}
 */
function readWindowTarget(opts) {
  const raw = opts?.target
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') return { raw, text: raw.trim() }
  if (typeof raw === 'number') return { raw, text: String(raw) }
  return { raw, text: '' }
}

/**
 * 造一个 `-32014 window-target-failed`（多窗口寻址设计 §5：一个码 + `data.reason`）。
 *
 * `data` 里 `reason` 是**唯一**的处置依据（码本身只说"寻址没成"）；其余字段都是排障用的，
 * 故意带上 `side: 'dsh'` —— 这个码只在 DSH 侧产生，对端不会发它。
 *
 * @param {string} method
 * @param {{raw: unknown, text: string}|null} target
 * @param {'window-not-found'|'window-closed'|'window-ambiguous'|'target-unauthorized'|'target-not-routable'} reason
 * @param {object} [extra]
 * @returns {BridgeError}
 */
function windowTargetError(method, target, reason, extra) {
  const shown = typeof target?.text === 'string' && target.text !== ''
    ? `"${target.text}"`
    : `(${target ? JSON.stringify(target.raw) ?? 'empty' : 'missing'})`
  return new BridgeError(
    ERR.WINDOW_TARGET_FAILED,
    `window target ${shown} cannot be used for "${method}": ${reason}`,
    {
      method,
      target: typeof target?.text === 'string' && target.text !== '' ? target.text : null,
      rawTarget: target?.raw ?? null,
      reason,
      side: 'dsh',
      ...extra,
    },
  )
}

/**
 * 从 opts 里挑出**属于请求参数**的锚点字段（位置形态没有别的地方放它们）。
 *
 * `expectedIncarnation`（T34）与 `expectedVersion` 同族：两者一起构成写锚点
 * （`{version, incarnation}`），都必须原样落到 `params` 上发给对端 —— 留在 opts 里
 * 宿主收不到，那就等于这道门从来没开过。真机踩过同一形态的坑（`includeText`，T30）。
 */
const ANCHOR_FIELDS = ['expectedVersion', 'expectedIncarnation', 'expectedRangeText', 'grant']

/**
 * `vscode.save` 的锚点字段 = 双锚点 + **磁盘锚点**（T39 / 契约 §6.2.3）。
 *
 * 单列一份而不是往 `ANCHOR_FIELDS` 里加 `expectedDisk`：那是 `applyEdit` 的白名单，
 * 往里塞一个 `applyEdit` 根本不用的字段，会让"这里列的就是写锚点全集"这句话变模糊。
 */
const SAVE_ANCHOR_FIELDS = [...ANCHOR_FIELDS, 'expectedDisk']

/**
 * `vscode.deleteFile` 请求的**线路**超时（T40 / 契约 §7 #5(b)）。
 *
 * 为什么删除要一条自己的长超时，而不是沿用 `DEFAULT_TIMEOUT_MS = 30s`：
 * 这条请求**中间夹着一个人**。执行端弹 modal、等人点"删除"，30s 到点会拒绝一次完全
 * 正常的操作 —— 而"人反应慢"与"通道坏了"必须分辨清楚（后者才该快速失败）。
 *
 * 为什么是 180s 而不是跟执行端的确认超时一样 120s：这里要比对端**宽**。对端 120s 到期
 * 会回 `-32004 reason:'confirm-timeout'`（一个能读懂、说明"许可作废、文件没删"的错误）；
 * 如果本端先超时，调用方只会拿到一个光秃秃的 `-32004 request timed out`，**分不清**
 * "人没点"与"连接断了"。留 60s 余量让对端那个更具体的错误先到。
 *
 * ⚠️ 推论（写在这里免得以后被当成 bug）：`dshKit.deleteConfirmTimeoutMs` 若配到
 * ≥180s，本端会先超时，`reason:'confirm-timeout'` 就看不到了 —— 两者要一起调。
 */
export const DELETE_REQUEST_TIMEOUT_MS = 180_000

/**
 * 归一化 `applyEdit` 的两种调用形态。
 *
 *  位置形态：applyEdit(file, range, text, opts)   ← 文档里的主形态
 *  对象形态：applyEdit(params, opts)              ← 既有调用方（含 demo 与 39 条用例）在用
 *
 * 锚点字段可以放在位置形态的 opts 里、或对象形态的 params/opts 里 —— 但不论哪种，
 * 归一化之后必须落在 `params` 上（协议里它们就是请求参数，不是传输选项）。
 * `timeoutMs` / `waitForEditor` 这类**传输**选项继续由 opts 往下传给 request()。
 */
function normalizeApplyEditArgs(args) {
  const first = args[0]
  if (typeof first === 'string') {
    const opts = isPlainObject(args[3]) ? args[3] : {}
    const params = { file: first }
    if (args[1] !== undefined) params.range = args[1]
    if (args[2] !== undefined) params.text = args[2]
    for (const k of ANCHOR_FIELDS) if (opts[k] !== undefined) params[k] = opts[k]
    return { params, opts }
  }
  const params = isPlainObject(first) ? { ...first } : {}
  const opts = isPlainObject(args[1]) ? args[1] : {}
  for (const k of ANCHOR_FIELDS) {
    if (params[k] === undefined && opts[k] !== undefined) params[k] = opts[k]
  }
  return { params, opts }
}

/**
 * 归一化 `getDocumentState` 的两种调用形态：
 *  `getDocumentState(file, opts?)` / `getDocumentState({file, includeText?}, opts?)`。
 * 只有 `file` 是参数，`opts`（超时等）原样往下传。
 */
function normalizeDocStateArgs(args) {
  const first = args[0]
  if (typeof first === 'string') {
    return { params: withDocStateFields({ file: first }, args[1]), opts: isPlainObject(args[1]) ? args[1] : {} }
  }
  const params = isPlainObject(first) ? withDocStateFields({ ...first }, args[1]) : {}
  return { params, opts: isPlainObject(args[1]) ? args[1] : {} }
}

/**
 * 把 `includeText` 从「第二个参数（选项）」提升进**请求参数**。
 *
 * ★ 真机踩出来的（T30 验收，2026-10-22）：开头只把它留在 opts 里 —— 于是能力层根本
 *   收不到 `includeText`，`getDocumentState(file,{includeText:true})` 静默返回
 *   "没有 text 也没有 textUnavailable"的形状。单测当时还断言了错误行为（`opts.includeText`），
 *   所以两边一起绿、现场一起错。区分口径：
 *     `includeText` = **业务参数**（决定宿主给不给全文）→ 进 params；
 *     `timeoutMs` / `waitForEditor` = **传输选项**（决定这趟怎么发）→ 留在 opts。
 */
function withDocStateFields(params, opts) {
  if (!isPlainObject(opts)) return params
  if ('includeText' in opts) params.includeText = opts.includeText
  return params
}

/**
 * 是不是协商通道方法（`bridge.*`）。
 *
 * `bridge.ping` / `bridge.hello` / `bridge.grant` / `bridge.grantRevoke` / `bridge.setTrust`…
 * 是**协议自身的协商面**，不是编辑器能力：把它们纳入白名单只会让"未绑定身份的插件
 * 连 hello 都发不出去"，而 §6.2.5 收口的是「拿到服务就能调任何 `vscode.*`」。
 */
function isBridgeMethod(method) {
  return typeof method === 'string' && method.startsWith('bridge.')
}

/**
 * 造一个**身份已绑定**的 facade（`kit.forPlugin(name, { declared })` 的返回值）。
 *
 * 形状与 `ctx.provide` 出去的那个 facade 完全一致（铁律 2：方法必须稳定存在），
 * 区别只有一个：每个方法都把**这个身份**作为第 4 个实参传下去，调用方改不了。
 * `snapshot` / `waitReady` / `editing` 全部委托给宿主 facade
 * （授权面不随插件身份变化 —— 谁能 `grant()` 由持有 kit 实例的那一方决定，那不是插件）。
 *
 * @param {() => any} getKit 取实例（未就绪时返回 null）
 * @param {{name: string, declared: string, source: string}} consumer
 * @param {any} host 宿主 facade（提供 ready / waitReady / snapshot / editing）
 */
function boundFacade(getKit, consumer, host) {
  const readyErr = (method) => new BridgeError(ERR.DISCONNECTED,
    'dsh-vscode-kit is not listening yet', { method, reason: 'server-not-ready' })
  const request = (method, params, opts) => {
    const kit = getKit()
    return kit
      ? kit.request(method, params, opts, consumer)
      : Promise.reject(readyErr(method))
  }
  const read = (method) => (params, opts) => request(method, params, opts)
  const facade = {
    /** 这个 facade 绑的是谁（诊断用；不是判据）。 */
    consumer: { ...consumer },
    get ready() { return host.ready },
    waitReady: (timeoutMs) => host.waitReady(timeoutMs),
    get editing() { return host.editing },
    get vscode() {
      return {
        openFile: read('vscode.openFile'),
        getSelection: read('vscode.getSelection'),
        getDiagnostics: read('vscode.getDiagnostics'),
        listOpenEditors: read('vscode.listOpenEditors'),
        // 多窗口视图（W1）：**本地**视图，因此未就绪时返回空表而不是 rejected Promise
        // （与 `editing.list()` 一致：诊断视图不该把调用方拖进 catch）。
        windows: {
          list: () => {
            const kit = getKit()
            return kit ? kit.listWindows(consumer) : []
          },
        },
        // 写入类：**唯一**入口是实例上的 `applyEditAs` —— 本地锚点门（版本 / 化身 / 来源）
        // 与普通调用共用同一份实现，绑身份只多做一件事：把 consumer 盖进 opts。
        applyEdit: (...args) => {
          const kit = getKit()
          return kit ? kit.applyEditAs(consumer, args) : Promise.reject(readyErr('vscode.applyEdit'))
        },
        getDocumentState: (...args) => {
          const { params, opts } = normalizeDocStateArgs(args)
          return request('vscode.getDocumentState', params, opts)
        },
        // 落盘（T39）：与 `applyEdit` 同一条路 —— 本地闸门共用 `saveAs`，
        // 绑身份只多做一件事：把 consumer 盖进 request 的第 4 个实参。
        save: (...args) => {
          const kit = getKit()
          return kit ? kit.saveAs(consumer, args) : Promise.reject(readyErr('vscode.save'))
        },
        // 归档（T40 / Tier 4；T44 起语义是**移入隔离区，永不删**）：与 `save` 同一条路。
        // **不可逆的是"移动"，不是"销毁"** —— 所以本端要多做一件事：线路超时垫长到 180s
        // （要盖住人看确认框的时间）。返回体里没有 `deleted`/`trashed`：这条能力不销毁
        // 任何字节（想让文件回来，人自己去 `.dsh-quarantine/` 挪回原位，没有 `restore` 入口）。
        deleteFile: (...args) => {
          const kit = getKit()
          return kit ? kit.deleteFileAs(consumer, args) : Promise.reject(readyErr('vscode.deleteFile'))
        },
      }
    },
    request,
    notify: (method, params) => {
      const kit = getKit()
      if (!kit) throw readyErr(method)
      return kit.notify(method, params, consumer)
    },
    snapshot: () => host.snapshot(),
  }
  // 再绑一层没有意义（身份已经定了），但"方法必须稳定存在"（铁律 2）：返回自己。
  facade.forPlugin = () => facade
  return facade
}

/**
 * 消费者拿到的服务对象。
 *
 * 只暴露两个入口：request（万能）与 vscode（糖衣）。其余字段以 `_` 前缀标为内部，
 * 消费者插件不该碰，但排障时可读。
 */
class VscodeKit {
  constructor({
    server, dshVersion, connectWaitMs, helloWaitMs, grantAckTimeoutMs, onLog, whitelist, dshHome,
  }) {
    this.server = server
    this.dshVersion = dshVersion
    this.connectWaitMs = connectWaitMs
    this.helloWaitMs = helloWaitMs ?? DEFAULT_HELLO_WAIT_MS
    // 等扩展侧回 `{ok:true,id}` 的上限（评审 F9）：没回执 = 没生效，超时即撤销本地记录。
    this.grantAckTimeoutMs = Number.isInteger(grantAckTimeoutMs) && grantAckTimeoutMs > 0
      ? grantAckTimeoutMs
      : DEFAULT_GRANT_ACK_TIMEOUT_MS
    this.onLog = onLog

    /**
     * per-plugin 能力白名单（契约 §6.2.5）。**唯一判定点**在 `_assertConsumer()`，
     * 由 `request()` / `notify()` 在发线路之前调用；配置由 `apply()` 从 cordis 传进来
     * （本库不读文件，铁律 3 零依赖）。
     *
     * 类直构（`new VscodeKit(...)`，测试与 E2E 用）没有配置可传：那就一个消费者都不登记，
     * 而它自己的调用走 `HOST_CONSUMER` 通道（owner，不受配置约束） —— 这正是"宿主不是插件"
     * 的边界，见 `whitelist.js` 里 `HOST_CONSUMER` 的论证。
     */
    this.whitelist = whitelist ?? new Whitelist(undefined, { onLog })

    // 这里**故意没有** lastEditor 槽：对端身份（协议版本 / 能力清单）挂在
    // 「这条连接」自己身上（`link.editor`，由 protocol.js 的 `ctx.link` 落位），
    // `lastEditor` 只是读当前目标连接那一份的只读视图。
    // 双源是评审 F1 的根因：全局槽记「最后一次 hello」，而目标按 connSeq 挑，
    // 目标切换/交错时两者不是同一条连接 → 门拿 A 的背书放行了 B 的包。
    /** 等待连接时的等待者队列。 */
    this.waiters = new Set()
    /** 等对端 hello（拿协议版本）的等待者队列。 */
    this.helloWaiters = new Set()

    /**
     * 对端 hello 里声明的 `features`（T34）—— **按连接**存（WeakMap），不写进
     * `link.editor` 的形状里：这是"这条连接说了什么"，随连接回收，
     * 与 `link.editor` 同生共死，但不动既有身份对象的字段（不改已发布形状）。
     * @type {WeakMap<object, Set<string>>}
     */
    this._peerFeatures = new WeakMap()

    /**
     * **锚点来源表**（T34）：`incarnation` → 它是从哪条连接、哪个会话读出来的。
     *
     * 存在的唯一理由：`applyEdit` 要能在**本地**发现"你拿 A 窗口的锚点去写 B 窗口"。
     * 判据只能是 `incarnation → link` 的对象身份（不用版本号：版本号正是会撞的那个）。
     *
     * 上限 256 条（FIFO 淘汰）：这是加速/自证用的小缓存，不是事实源 —— 淘汰之后
     * 只是"本端不再能自证来源"，写入照样由对端的化身门兜底（-32012），不会因此放行。
     * 不用 Map 就丢不掉内存，用无限 Map 就是一处慢性泄漏。
     * @type {Map<string, {link: object|null, sessionId: string|null, file: string|null, at: number}>}
     */
    this._anchorSources = new Map()

    /**
     * 窗口注册表（W1）：`windowId` 的签发与持久化，落在
     * `~/.dsh/dsh-vscode-kit/windows.json`（`dshHome` 由 `apply()` 传进来；类直构时用默认值）。
     *
     * 懒加载 + 写失败只 log：注册表是**诊断字段的家**，不是连接的前提。
     * @type {WindowRegistry}
     */
    this.windowRegistry = new WindowRegistry({
      file: windowsFilePath(dshHome),
      onLog,
    })

    /**
     * 已关闭的窗口（W2 的 `window-closed` 判据）。
     *
     * 为什么要墓碑：连接断了以后 `trusted` 里就查不到了，而"你问的那个窗口曾经存在、
     * 现在关了"与"你问的号根本没有过"是两种完全不同的排障方向（前者该重连，
     * 后者该检查调用方的 target 拼写）。墓碑只活在这个进程里，上限 256 条（FIFO），
     * 淘汰之后最坏退化成 `window-not-found` —— 仍然是个错误，不会误投。
     * @type {{seqs: Set<number>, ids: Set<string>}}
     */
    this._closedWindows = { seqs: new Set(), ids: new Set() }

    // 糖衣方法族。新增能力只在这里加一行，协议层不改。
    // 注意两个参数都要往下传：早期写成 `openFile: (params) => this.request(m, params)`
    // 会把消费者传的 opts（timeoutMs / waitForEditor）静默丢掉。
    this.vscode = {
      openFile: (params, opts) => this.request('vscode.openFile', params, opts),
      getSelection: (params, opts) => this.request('vscode.getSelection', params, opts),
      getDiagnostics: (params, opts) => this.request('vscode.getDiagnostics', params, opts),
      listOpenEditors: (params, opts) => this.request('vscode.listOpenEditors', params, opts),
      // 多窗口视图（W1）：**本地**视图 —— 列的是本端握着的几条连接，一个字节都不发给对端
      // （没有"哪个窗口"可问：要问的就是"有几个窗口"）。同步返回数组，与 `editing.list()` 一致。
      windows: {
        list: () => this.listWindows(HOST_CONSUMER),
      },
      // 写入类：额外过会话授权绑定门（契约 §6.1，发送前）。糖衣只做转发，
      // 门在 request() 里统一判 —— 绕过糖衣走 raw request 也照样过门。
      //
      // 版本锚点（T30）：缺 `expectedVersion` 在这里**本地就拒**，一个字节都不发。
      // 为什么不交给对端回 -32602：错误越晚被人看见，越容易被当成"网络问题"重试，
      // 而重试的正是那条没有锚点的写路径 —— 安全路径要成为**唯一**路径，
      // 就不能留一条"发出去再被拒"的软路径。
      // 两种调用形态都支持，但**都要**带锚点：
      //   applyEdit(file, range, text, { expectedVersion, expectedRangeText?, grant? })
      //   applyEdit({ file, range, text, expectedVersion, expectedRangeText?, grant }, opts?)
      // 写成 `async` 是有意的：让"本地拒绝"与"对端拒绝"都表现为**被拒的 Promise**，
      // 调用方只需一种处理方式（否则一半要 try/catch、一半要 .catch，总会有人漏）。
      // 类实例自己的糖衣 = **宿主通道**（`HOST_CONSUMER`）。插件永远拿不到实例，
      // 它拿到的是 `ctx.provide` 出去的 facade 或 `forPlugin()` 绑定的 facade —— 那两个
      // 各自带着自己的身份调 `applyEditAs()`。实现在下面那一个方法里，只有一份。
      applyEdit: (...args) => this.applyEditAs(HOST_CONSUMER, args),
      // 读取版本号（写入锚点的读侧）。同样是双形态：
      //   getDocumentState(file, { includeText?, timeoutMs? })
      //   getDocumentState({ file, includeText? }, opts?)
      getDocumentState: (...args) => {
        const { params, opts } = normalizeDocStateArgs(args)
        return this.request('vscode.getDocumentState', params, opts)
      },
      // Tier 3 落盘（T39）。与 applyEdit 同构：本地闸门在**发送之前**，实现在 saveAs 一处。
      //   save(file, { expectedVersion, expectedIncarnation, expectedDisk, grant?, ... })
      //   save({ file, expectedVersion, expectedIncarnation, expectedDisk, grant? }, opts?)
      save: (...args) => this.saveAs(HOST_CONSUMER, args),
      // Tier 4 删除（T40）：形态与 `save` 完全一致（同一套本地闸门 + 同一组锚点），
      // 区别只在**执行端多两道闸**（人工确认 + 内容快照）与**请求级超时更宽**。
      //   deleteFile(file, { expectedVersion, expectedIncarnation, expectedDisk, grant?, timeoutMs? })
      //   deleteFile({ file, expectedVersion, expectedIncarnation, expectedDisk, grant? }, opts?)
      // 不可逆：不保证进回收站、不提供撤销、不支持目录/递归。
      deleteFile: (...args) => this.deleteFileAs(HOST_CONSUMER, args),
    }

    /**
     * `vscode.applyEdit` 的**唯一实现**（三个入口共用）。
     *
     * 三个入口只是"身份不同"：
     *  - 类实例的糖衣 → `HOST_CONSUMER`（owner 通道，E2E 与类直构单测走这条）；
     *  - `forPlugin()` 绑定的 facade → 该插件的身份；
     *  - `ctx.provide` 出去的 facade → `UNBOUND_CONSUMER`（天花板 `read`，写必拒）。
     *
     * 本地闸门一字不差地留在这里（而不是抄到每个入口）：
     * 版本锚点 → 绑定写目标 → 化身锚点 → 锚点来源，判在发送之前 ⇒ 抛在这里 = 一个字节都没发出去。
     * ★ T35：化身必填**不再看对端公告**（原 `required: this._peerRequiresIncarnation(...)`）
     *   —— 公告不是强制条件，"对端一沉默本端就少判一半"正是 H1 的形态；真正的兜底在
     *   `request()` 的写分支里（raw request 走那条路），这里是同一判据的**更早一道**。
     *
     * @param {{name: string|null, declared: string, source: string}} consumer 由入口决定，调用方改不了
     * @param {any[]} args `applyEdit(...)` 的原始实参（位置形态 / 对象形态都支持）
     */
    // 写成实例属性（不是 class 方法）是**故意的**：它紧挨着 `this.vscode` 定义，
    // 而糖衣 `applyEdit` 就是它的一行转发 —— 放在一起才不会漂移。
    this.applyEditAs = async (consumer, args) => {
      const { params, opts } = normalizeApplyEditArgs(args)
      // W2 / §3.2：写路径不接受窗口寻址 —— 在绑定目标**之前**拒，对端零帧。
      this._rejectWriteWindowTarget('vscode.applyEdit', opts)
      assertLocalExpectedVersion('vscode.applyEdit', params)
      // 三个本地闸门，顺序有意：形状 → 必填 → 来源（最贵的放最后）。
      const sessionId = readSessionId(opts)
      const bound = this._bindWriteTarget(params, sessionId)
      assertLocalExpectedIncarnation('vscode.applyEdit', params)
      this._assertAnchorSource('vscode.applyEdit', params, {
        link: bound.link,
        sessionId,
      })
      return this.request('vscode.applyEdit', params, opts, consumer)
    }

    /**
     * `vscode.save` 的**唯一实现**（三个入口共用，T39 / 契约 §6.2.1 Tier 3）。
     *
     * 本地闸门（发送之前，抛在这里 = 宿主零调用、线上一字节没有）：
     *  ① `expectedVersion` 形状 → ② 绑定写目标（会话 → grant 记录 → 连接）→
     *  ③ `expectedIncarnation` 形状 → ④ `expectedDisk` 形状 → ⑤ 锚点来源。
     *
     * ★ **意图位不在这里读**：`allowDirtySave` 只长在 grant 记录上（`editing.grant` 发放时
     *   定型、`bridge.grant` 投递给执行端），**不接受** `params.allowDirtySave`。放进来
     *   就等于调用方自己给自己授权（契约 §6.2.2 的结论）—— 而且我们连读都不读它，
     *   免得"没生效但看起来被接受了"。
     *
     * 本地闸门之外还有：白名单（`request()` 第一步，`vscode.save` = `disk-write`）、
     * 双锚点（`request()` 写分支再判一次）、绑定门（DSH 侧 `_writeGate` + 执行端复核）。
     * 这道门是"更早、更清楚"的那一道，不是唯一一道。
     *
     * @param {{name: string|null, declared: string, source: string}} consumer 由入口决定
     * @param {any[]} args `save(...)` 的原始实参（位置形态 / 对象形态都支持）
     */
    this.saveAs = async (consumer, args) => {
      const { params, opts } = normalizeSaveArgs(args)
      // W2 / §3.2：写路径不接受窗口寻址 —— 在绑定目标**之前**拒，对端零帧。
      this._rejectWriteWindowTarget('vscode.save', opts)
      assertLocalExpectedVersion('vscode.save', params)
      const sessionId = readSessionId(opts)
      const bound = this._bindWriteTarget(params, sessionId)
      assertLocalExpectedIncarnation('vscode.save', params)
      assertLocalExpectedDisk('vscode.save', params)
      this._assertAnchorSource('vscode.save', params, {
        link: bound.link,
        sessionId,
      })
      return this.request('vscode.save', params, opts, consumer)
    }

    /**
     * `vscode.deleteFile` 的**唯一实现**（三个入口共用，T40 / 契约 §6.2.1 Tier 4）。
     *
     * 名字是历史包袱，语义是 T44 裁决的"**移入隔离区，永不删**"：它把目标 rename 进
     * 工作区根下的 `.dsh-quarantine/` 并把归档后的实测 sha256 交回来。
     *
     * 本地闸门与 `saveAs` **同一套、同顺序**（① 版本 → ② 绑定写目标 → ③ 化身 →
     * ④ 磁盘锚点 → ⑤ 锚点来源）：移动是比落盘更狠的动作，没有理由在发送前比它更松。
     * 抛在这里 = 宿主零调用、线上一字节没有，**也没人会被弹确认框**。
     *
     * ★ 本端**不做**的三件事（它们执行端才做得了，这里假装做等于给假保险）：
     *   - 弹确认框（没有 UI；`showWarningMessage` 只在扩展宿主里存在）；
     *   - 读文件内容做快照（本端能读，但"谁读了算数"必须与"谁移动"同一个人，否则
     *     快照可以来自另一份文件）；
     *   - 判断目录/链接（路径守卫在扩展侧，本端看不到 lstat）。
     *
     * 白名单档位是**最高档** `delete`（`whitelist.js` 的 `METHOD_TIERS`），绑定门由
     * `WRITE_METHODS` 自动继承 —— 与 `applyEdit` / `save` 共用同一份判定。
     *
     * @param {{name: string|null, declared: string, source: string}} consumer 由入口决定
     * @param {any[]} args `deleteFile(...)` 的原始实参（位置形态 / 对象形态都支持）
     */
    this.deleteFileAs = async (consumer, args) => {
      const { params, opts } = normalizeSaveArgs(args)
      // W2 / §3.2：写路径不接受窗口寻址 —— 在绑定目标**之前**拒，对端零帧。
      this._rejectWriteWindowTarget('vscode.deleteFile', opts)
      assertLocalExpectedVersion('vscode.deleteFile', params)
      const sessionId = readSessionId(opts)
      const bound = this._bindWriteTarget(params, sessionId)
      assertLocalExpectedIncarnation('vscode.deleteFile', params)
      assertLocalExpectedDisk('vscode.deleteFile', params)
      this._assertAnchorSource('vscode.deleteFile', params, {
        link: bound.link,
        sessionId,
      })
      // 线路超时要盖住"人看确认框"的那段（§7 #5(b) 的独立长超时）。显式给了就听调用方的。
      const wireOpts = { ...opts, timeoutMs: opts.timeoutMs ?? DELETE_REQUEST_TIMEOUT_MS }
      return this.request('vscode.deleteFile', params, wireOpts, consumer)
    }

    /**
     * per-plugin 能力白名单的唯一判定点（契约 §6.2.5）—— 发线路**之前**，失败零字节。
     *
     * `bridge.*` 豁免：那是协议协商面，不是编辑器能力（白名单收口的是"能调任何 `vscode.*`"）。
     * 位置在 `request()` / `notify()` 的最前面：只要身份/档位不够，连"等编辑器 3 秒"
     * 都不该开始等 —— 那种"先等一会儿再告诉你没权限"的失败形态在真机上会被当成网络问题重试。
     *
     * @param {{name: string|null, declared: string, source: string}} consumer
     * @param {string} method
     * @throws {BridgeError} `-32602`（`data.stage === 'local'`，`data.reason` 说明是哪种不够格）
     */
    this._assertConsumer = (consumer, method) => {
      if (isBridgeMethod(method)) return
      this.whitelist.judge(consumer ?? HOST_CONSUMER, method)
    }

    /**
     * 会话授权（编辑会话凭证）表 —— **本端是唯一生成方**（契约 §6.1.1 ①）。
     *
     * `link` 存的是连接**对象引用**：失效判定按对象身份比，不按任何序号（铁律 §6.1.1）。
     */
    this.grants = new GrantStore()
    /** 发送前门的唯一实例：判的是「这次要发的那条连接」，不是别的视图。 */
    this._writeGate = dshWriteGate(this.grants)

    /**
     * 编辑授权对外面（`kit.editing.*`）。
     *
     * 三个动作各有明确归属：
     *  - `grant()`：**只在有已准入且协议兼容的目标连接时**发放；没有就抛错，不排队不缓存。
     *  - `revoke(id?)`：先本地失效（权威），再尽力通知对端；通知送不到不影响撤销结论。
     *  - `list()`：诊断视图，不是判据。
     */
    this.editing = {
      grant: (opts) => this.grantEditing(opts),
      revoke: (id) => this.revokeEditing(id),
      list: () => this.grants.entries(),
      // 写入锚点的**绑定读**（T34）：按会话拿到"我获准写入的那份文档"的
      // `{version, incarnation}`。`kit.vscode.getDocumentState(file)` 是**活跃视角**，
      // 在它上面derive 出的锚点可能来自另一个窗口 —— 这个方法是唯一正确的读法。
      stateFor: (sessionId, file, opts) => this.readStateFor(sessionId, file, opts),
    }
  }

  /**
   * 内部：**写路径**上的窗口寻址拒绝（W2 / 多窗口寻址 §3.2）。
   *
   * 写目标只能由 grant 记录决定（见下一个方法），所以"写给哪个窗口"这件事
   * **不接受调用方指定**。这里拒绝，不是忽略：悄悄忽略会让人以为写到了自己点的
   * 那个窗口，实际写到了别处 —— 那是最坏的一种"成功"。
   *
   * 位置要求：必须在 `_bindWriteTarget` **之前**，且抛在这里对端**零帧**
   * （连 grant 都不会被查，更不会有人被弹确认框）。
   *
   * @param {string} method 业务方法名（进错误 `data.method`）
   * @param {any} opts     调用方 opts（`target` 只会出现在这里，不在 params 里）
   */
  _rejectWriteWindowTarget(method, opts) {
    const target = readWindowTarget(opts)
    if (!target) return
    throw windowTargetError(method, target, 'target-not-routable', {
      write: true,
      boundBy: 'grant',
    })
  }

  /**
   * 内部：写路径的目标连接 —— **只从 grant 记录来**，绝不经过 `_activeLink()`。
   *
   * ★ 评审 F3：契约 §6.1.1 明令写目标是保存的 `grant.link`。旧实现先按
   *   `_activeLink()` 选 argmax 再比 grant，于是「A 有有效 grant、B 后连」会让
   *   A 的合法写请求被拒绝（绑定门退化成"只许给当前活跃窗口写"）。
   *   这里的口径反过来：**谁能写**由记录决定，**写给谁**也是记录决定；
   *   B 后连不影响 A 一个字，A 消失也只是失败（不许回落到 B）。
   *
   * @param {any} params      业务参数（可能携带调用方显式给的 grant，用于世代判定）
   * @param {string|null} sessionId 调用方上下文里的会话身份（不来自 params）
   * @returns {{link: object|null, params: any}}
   */
  _bindWriteTarget(params, sessionId) {
    const given = params?.grant ?? null
    // ① 找记录：调用方显式给了 grant 就按 id 找（世代/形状由判定表判）；
    //    没给就按**可信会话**找 —— 契约要的是"由会话找到记录"，不是"由凭据找窗口"。
    const found = given ? this.grants.lookup(given?.id ?? null) : this._grantForSession(sessionId)
    const record = found?.kind === 'active' ? found.record : null
    const link = record ? this._liveTargetOrNull(record) : null

    // ② 补内部字段（评审 F2 后半句「第三方不应负责复制内部 grant 字段」）：
    //    只有"调用方没给"时才补，且补的是**同一条**记录。调用方给了就一个字都不改，
    //    否则错误的 epoch 会被悄悄改对，第 5 行永远命中不了。
    if (link && !given && record) {
      return { link, params: { ...params, grant: { id: record.id, epoch: record.epoch } } }
    }
    return { link: record ? link : null, params }
  }

  /**
   * 按可信会话找它当前的有效 grant（同一会话重复发放时后一条覆盖前一条，
   * 与 `issue()` 的 supersede 语义一致）。
   * @param {string|null} sessionId
   * @returns {{kind: 'active', record: object} | null}
   */
  _grantForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    let best = null
    for (const record of this.grants.active()) {
      if (record.sessionId === sessionId) best = record
    }
    return best ? { kind: 'active', record: best } : null
  }

  /**
   * 记录里的承载连接**现在还活着吗**（评审 F3「检查该 link 的准入/版本/存活」）。
   *
   * 死连接不在这里另造一种拒绝：就地按断线回收（与 `onLinkClosed` 同一机制），
   * 然后让判定表第 3 行给出 `target-gone` —— 拒绝理由只有一处来源。
   * @param {object} record
   * @returns {object|null}
   */
  _liveTargetOrNull(record) {
    const target = record?.link ?? null
    if (!target) return null
    const dead = target.closed === true
      || target.socket?.destroyed === true
      || (this.server?.trusted instanceof Set && !this.server.trusted.has(target))
    if (!dead) return target
    this.grants.closeLink(target)
    return null
  }

  /**
   * 内部：**已准入且仍活着**的连接（W1 起成为唯一口径）。
   *
   * 三处共用它：`_activeLink()` 的挑选面、`windows.list()` 的可见面、target 解析的候选面。
   * 集合的定义在 `server.js` 的 `liveTrustedLinks()`（与 `broadcast` 的投递面同一个函数）——
   * 三处各写一遍判断，就会有一处忘了跳过死连接，那类 bug 表现为"表里有、一发就断"。
   * @returns {any[]}
   */
  _liveLinks() {
    return liveTrustedLinks(this.server?.trusted)
  }

  /**
   * 内部：一条连接的 `windowId`。
   *
   * 报过 hello 且有 `window` 块 → 注册表签发的号；否则按 §6 降级成 `tmp-<connSeq>`
   * （老扩展没有这个块，也不许因此少一行视图）。`windowId` **永远存在**（§1.3 末段），
   * 不稳定只体现在 `stable:false` 上。
   * @param {object|null} link
   * @returns {string}
   */
  _windowIdOf(link) {
    const noted = link?.window?.windowId
    if (typeof noted === 'string' && noted !== '') return noted
    const seq = typeof link?.connSeq === 'number' ? String(link.connSeq) : 'unknown'
    return `tmp-${seq}`
  }

  /**
   * 内部：一条连接在 `windows.list()` 里的那一行（§2.2 字段表）。
   *
   * `windowId` 与 `connSeq` 是**两个字段**（§1.2：禁止 `windowId = String(connSeq)`）：
   * 前者是身份、跨重连稳定；后者是进程内序号、只用于排序与诊断。
   * `active` 只是"此刻 `_activeLink()` 是谁"的视图，不是身份、也不是权限。
   * @param {object} link
   * @returns {object}
   */
  _windowRow(link) {
    const win = link?.window ?? null
    const editor = link?.editor ?? null
    const windowId = this._windowIdOf(link)
    const workspace = win?.workspace
      ? {
        name: typeof win.workspace.name === 'string' ? win.workspace.name : null,
        folders: Array.isArray(win.workspace.folders) ? [...win.workspace.folders] : [],
      }
      : null
    const pv = editor?.protocolVersion
    return {
      windowId,
      stable: win ? win.stable === true : false,
      connSeq: typeof link?.connSeq === 'number' ? link.connSeq : null,
      label: windowLabel(workspace, windowId),
      workspace,
      uiKind: typeof win?.uiKind === 'string' ? win.uiKind : null,
      remoteName: typeof win?.remoteName === 'string' ? win.remoteName : null,
      focused: typeof win?.focused === 'boolean' ? win.focused : null,
      extensionVersion: typeof editor?.extensionVersion === 'string' ? editor.extensionVersion : null,
      protocolVersion: typeof pv === 'string' || typeof pv === 'number' ? String(pv) : null,
      active: link === this._activeLink(),
    }
  }

  /**
   * `vscode.windows.list()` —— 本端握着的窗口（W1）。
   *
   * 只会看见**已准入且活着**的连接（`_liveLinks()`）：一个裸 socket、握手都没做完的
   * 连接既不在表里，也不能被 target 命中（未准入与"不存在"同码，§4：target 不许变成
   * 准入探针）。排序口径只有一个：`connSeq` 升序（§2.2），跨重连的稳定顺序不在本方法里。
   *
   * 不看对端能力位、也不对任何单条连接做版本预检：这是**本端视图**，
   * 没有"单一对端"可问；老扩展（没有这个能力位）照样应该出现在表里（§7 A9）。
   *
   * @param {{name: string|null, declared: string, source: string}} [consumer]
   * @returns {Array<object>}
   */
  listWindows(consumer) {
    this._assertConsumer(consumer, 'vscode.windows.list')
    return this._liveLinks()
      .slice()
      .sort((a, b) => {
        const sa = typeof a?.connSeq === 'number' ? a.connSeq : Number.POSITIVE_INFINITY
        const sb = typeof b?.connSeq === 'number' ? b.connSeq : Number.POSITIVE_INFINITY
        return sa - sb
      })
      .map((link) => this._windowRow(link))
  }

  /**
   * 内部：hello 到达时给连接记下窗口身份（W1）。
   *
   * 只写 `link.window`（与 `link.editor` 同生共死），**不参与任何判定** ——
   * 准入看 token、授权看 grant、写入看锚点，都不读这个字段（§4「target 不提升权限」）。
   * 因此把 hello 里的 `window` 块整个删掉，所有判定测试必须依然全绿（§7 A9 的守门）。
   *
   * @param {object} link
   * @param {unknown} rawWindow hello 里的 `window` 块（可能是 undefined / 坏形状 / null）
   * @returns {object|null}
   */
  _noteWindowIdentity(link, rawWindow) {
    if (!link) return null
    const block = normalizeWindowBlock(rawWindow)
    const issued = this.windowRegistry.assign({
      fingerprint: windowFingerprint(block),
      connSeq: link.connSeq,
    })
    link.window = {
      windowId: issued.windowId,
      stable: issued.stable === true,
      workspace: block?.workspace ?? null,
      uiKind: block?.uiKind ?? null,
      remoteName: block?.remoteName ?? null,
      focused: block?.focused ?? null,
    }
    return link.window
  }

  /**
   * 内部：连接关掉时留一块墓碑（`window-closed` 的判据，`_resolveWindowTarget` 用）。
   *
   * 为什么需要："那个窗口曾经存在、现在关了"（该重连）与"你写的号根本没有过"
   * （该检查拼写）是两种完全不同的排障方向，合并成一句 not-found 就把线索丢了。
   * 上限 256 条 FIFO：淘汰后最坏退化成 `window-not-found`，仍然是个错误、不会误投。
   *
   * @param {object|null} link
   */
  _noteWindowClosed(link) {
    if (!link) return
    if (typeof link.connSeq === 'number') this._closedWindows.seqs.add(link.connSeq)
    const windowId = link.window?.windowId
    if (typeof windowId === 'string' && windowId !== '') this._closedWindows.ids.add(windowId)
    for (const set of [this._closedWindows.seqs, this._closedWindows.ids]) {
      while (set.size > 256) {
        const oldest = set.values().next().value
        if (oldest === undefined) break
        set.delete(oldest)
      }
    }
  }

  /**
   * 内部：把 `{target}` 解析成**一条**活连接（W2 / §5 的 reason 判定序）。
   *
   * 判定顺序（先命中先返回，与 §5 一致）：
   *  1. 目标写错（`#abc`、`{}`、空串、label 撞多行）→ `window-not-found` / `window-ambiguous`；
   *  2. 解析到 0 条活连接 → 有墓碑/有签发记录 ⇒ `window-closed`，否则 `window-not-found`；
   *  3. 解析到 >1 条活连接 → `window-ambiguous`（同一 windowId 挂在两条连接上就是这个 case）。
   *
   * 候选集合只有 `_liveLinks()`：未准入的连接**不在候选里**，所以 target 永远探不到准入状态。
   *
   * @param {{raw: unknown, text: string}} target
   * @param {string} method
   * @returns {object} 命中的连接
   * @throws {BridgeError} -32014 + `data.reason`
   */
  _resolveWindowTarget(target, method) {
    const text = typeof target?.text === 'string' ? target.text : ''
    const fail = (reason, extra) => windowTargetError(method, target, reason, extra)
    const live = this._liveLinks()
    const candidatesOf = (hits) => hits.map((l) => this._windowIdOf(l))

    // ── `#<connSeq>`：进程内序号，最容易拿到、也最容易过期（DSH 重启即重排）──
    if (text.startsWith('#')) {
      const n = Number.parseInt(text.slice(1), 10)
      if (!Number.isInteger(n) || String(n) !== text.slice(1)) throw fail('window-not-found')
      const hits = live.filter((link) => link.connSeq === n)
      if (hits.length === 1) return hits[0]
      if (hits.length > 1) throw fail('window-ambiguous', { candidates: candidatesOf(hits) })
      throw fail(this._closedWindows.seqs.has(n) ? 'window-closed' : 'window-not-found', { connSeq: n })
    }

    // ── `windowId`：`windows.list()` 真报出来的号（`win-NN` 本端签发 / `tmp-N` 降级号）──
    if (WINDOW_ID_PATTERN.test(text)) {
      const hits = live.filter((link) => this._windowIdOf(link) === text)
      if (hits.length === 1) return hits[0]
      if (hits.length > 1) throw fail('window-ambiguous', { candidates: candidatesOf(hits) })
      // 签发过（windows.json 里有）或刚刚关掉（墓碑）⇒ 曾经存在；否则这个号从没出现过。
      const known = this.windowRegistry.has(text) || this._closedWindows.ids.has(text)
      throw fail(known ? 'window-closed' : 'window-not-found', { windowId: text })
    }

    // ── 其余写法（label / 裸数字 / 对象 / 空串）一律不路由 ──
    // 只有一种情况值得区分：给的是一行 label 且撞了多行（那是真实存在的歧义）。
    const labeled = live.filter((link) => this._windowRow(link).label === text)
    throw fail(labeled.length > 1 ? 'window-ambiguous' : 'window-not-found', {
      candidates: labeled.length > 1 ? candidatesOf(labeled) : undefined,
    })
  }

  /**
   * 内部：取当前活跃连接 —— **只在已准入的连接里挑，且按连接序号挑**。
   *
   * ★ 安全（洞 2）：不能简单取「最后连上的」。裸连一个 socket、什么都不发，
   *   就能把 active 位抢走，之后 DSH 的 vscode.* 请求全被它接走
   *   （work/scripts/lesson3-hijack.mjs 是复现）。
   *   准入 = 至少发过一条 token 正确的消息（server.js 的 authorize 升格到 trusted）。
   *   不遍历 links：即使以后忘写 authorized 过滤，也不会选中未准入 socket。
   *
   * ★ 回归（评审 R1）：目标必须按**连接先后**（server.js 的 connSeq），不是准入先后。
   *   trusted 在首次准入时 add，取集合末项等于「最后准入优先」；拆分前的实现是
   *   「最后连接优先」（links 在建连时 add）。两条都合法时两种口径会选出不同连接，
   *   connect A → connect B → 先准入 B → 后准入 A：旧算法给 B，取末项给 A。
   *   所以这里扫 trusted 取 connSeq 最大者 —— 与旧行为一致，且不回退到 links。
   */
  _activeLink() {
    let best = null
    let bestSeq = -Infinity
    // W1：候选面统一走 `_liveLinks()`（= `server.liveTrustedLinks(trusted)`），
    // 挑选规则一字未改：connSeq 最大者，同序号保留先遇到的，死连接不参与。
    for (const link of this._liveLinks()) {
      // 未带序号的连接（白盒/旧对象）排在所有带序号的连接之后；
      // 同序号时保留先遇到的那条，结果稳定可测。
      const seq = typeof link.connSeq === 'number' ? link.connSeq : -Infinity
      if (best !== null && seq <= bestSeq) continue
      best = link
      bestSeq = seq
    }
    return best
  }

  /**
   * 当前目标连接上报的身份（诊断用）。**只是视图，不是事实源**。
   *
   * 事实源只有一处：目标连接自己的 `link.editor`（由 hello 写入、随连接回收）。
   * 所以 `kit.lastEditor` 与兼容门读的必然是同一份 —— 这正是 F1 要求的「同源读法」。
   * @returns {object|null} 目标连接没报过 hello（或没有目标）时为 null
   */
  get lastEditor() {
    return this._activeLink()?.editor ?? null
  }

  /** 内部：等编辑器连上，最多等 waitMs；超时返回 null。 */
  _waitForEditor(waitMs) {
    const link = this._activeLink()
    if (link) return Promise.resolve(link)
    if (waitMs <= 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(null)
      }, waitMs)
      if (typeof timer.unref === 'function') timer.unref()
      const waiter = (lnk) => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(lnk)
      }
      this.waiters.add(waiter)
    })
  }

  /** 内部：编辑器连上时唤醒等待者。 */
  _notifyConnected(link) {
    for (const waiter of [...this.waiters]) waiter(link)
  }

  /**
   * 内部：某条连接报了自己的 hello（协议版本）时唤醒等待者。
   *
   * 只唤醒等**这条连接**的等待者（`_waitForHello(link, …)` 里的 waiter 会比对 link）——
   * 别的连接的 hello 不得给它的等待者「解围」，那正是 F1 的 fail-open 入口。
   */
  _notifyHello(link) {
    for (const waiter of [...this.helloWaiters]) waiter(link ?? null)
  }

  /**
   * 内部：等**指定连接**的 hello（协议版本）到达。
   *
   * hello 之前没有对端版本 = 契约里的「未知版本」，不得推断为 v1
   * （§4.1 ① 第 3 行、§7 #3「hello 前必须按未知版本保守处理」）。
   *
   * ★ 评审 F1：以前是「等任意一条连接的 hello」（读全局槽 `this.lastEditor`），
   *   多窗口时 A 的 hello 会给 B 的目标位背书。现在只认传进来的这条。
   *
   * @param {object|null} link 目标连接
   * @param {number} waitMs 上限
   * @returns {Promise<boolean>} 该连接是否在时限内报过 hello
   */
  _waitForHello(link, waitMs) {
    if (!link) return Promise.resolve(false)
    if (link.editor) return Promise.resolve(true)
    if (!(waitMs > 0)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer)
        this.helloWaiters.delete(waiter)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), waitMs)
      if (typeof timer.unref === 'function') timer.unref()
      const waiter = (who) => {
        if (who === link) finish(true)
      }
      this.helloWaiters.add(waiter)
    })
  }

  /**
   * 协议兼容门（契约 §4.1 ②：「DSH 侧 kit = 权威判定层」）。
   *
   * 判定表见 `judgeProtocolVersion`：整数且落在 `SUPPORTED_PROTOCOL` 区间内才放行；
   * 整数越界 / 缺失 / 非整数 / 非数字一律按**不兼容**处理（不得推断为 v1）。
   * 必须跑在能力预检**之前**、发包**之前** —— 不兼容时一个业务方法都不执行，
   * 连「旧方法」也不放行（§4.1 硬规则 + 「先过门、再谈降级」）。
   *
   * 豁免 `bridge.*` 协议层方法（ping/hello）：它们不是业务能力，不受版本门约束 ——
   * 否则版本不兼容时连「问一句对方是几版」都做不到。业务能力（`vscode.*`）没有豁免。
   *
   * @throws {BridgeError} -32008，data = { required:{min,max}, peer, peerType, reason, helloReceived, method, side:'dsh' }
   * @param {string} method
   * @param {object|null} [link] 判定与发包必须是**同一条连接**；省略时取当前目标
   */
  _assertProtocolCompatible(method, link, opts = {}) {
    // `exempt:false` 强制不豁免 —— 授权发放用：`bridge.grant` 发的是写权限凭证，
    // 虽然名字在 `bridge.*` 里，但绝不能投给版本不兼容的对端（契约 §6.1：只有
    // 「已准入且协议兼容」的目标连接才配拿到 grant）。
    const exempt = opts.exempt ?? (typeof method === 'string' && method.startsWith('bridge.'))
    if (exempt) return
    // ★ 评审 F1：判据只取这一条连接自己上报的版本（`link.editor`），不再有全局槽。
    //   调用方（request/notify）已经选好了 link 并会用它发包，所以「判的」=「发的」。
    const target = link ?? this._activeLink()
    const editor = target?.editor ?? null
    const verdict = judgeProtocolVersion(editor ? editor.protocolVersion : undefined)
    if (verdict.compatible) return

    const [min, max] = SUPPORTED_PROTOCOL
    throw new BridgeError(
      ERR.PROTOCOL_INCOMPATIBLE,
      `protocol version incompatible: peer protocolVersion is ${verdict.reason}`
        + ` (supported ${min}..${max}); refusing to send "${method}"`,
      {
        required: { min, max },
        peer: verdict.peer,
        peerType: verdict.peerType,
        reason: verdict.reason,
        helloReceived: editor !== null,
        method,
        side: 'dsh',
      },
    )
  }

  /**
   * 能力降级预检（协议 §7）：只认**这条连接**在 hello 里声明的能力清单。
   *
   * 空清单 / 未声明 = 不预检（旧扩展不报 capabilities，不能因此全拒）。
   * `bridge.*` 与入站能力族不受约束（前者是协议层，后者是编辑器发给我们调的）。
   *
   * @throws {BridgeError} -32005 不支持
   */
  _assertCapability(method, link) {
    if (typeof method === 'string' && method.startsWith('bridge.')) return
    const caps = (link ?? this._activeLink())?.editor?.capabilities
    if (Array.isArray(caps) && caps.length > 0 && !hasCapability(caps, method)
        && !INBOUND_CAPABILITIES.includes(method)) {
      throw new BridgeError(ERR.UNSUPPORTED,
        `editor does not advertise capability for "${method}"`,
        { method, capabilities: caps })
    }
  }

  /**
   * 记下这条连接在 hello 里声明的语义能力（T34）。**按连接**存，WeakMap。
   *
   * 只认字符串项：畸形 feature 混进 Set 会让"声明的支持"变成猜谜。
   * ★ T35：声明与否**不再改变强制行为** —— 化身锚点无条件必填（见
   *   `assertLocalExpectedIncarnation`）。这张表从此只用于诊断/兼容性判断。
   * @param {object|null} link
   * @param {unknown} features hello 的 `params.features`
   */
  _notePeerFeatures(link, features) {
    if (!link) return
    const list = Array.isArray(features) ? features.filter((f) => typeof f === 'string') : []
    this._peerFeatures.set(link, new Set(list))
  }

  /**
   * 这条连接是否声明了"锚点里带文档实例身份"（T34）。
   *
   * ★ **T35：只是诊断查询，不再决定强制。** 曾经"未声明 = 老扩展 ⇒ 不强制
   * `expectedIncarnation`"，那让"对端不公告"变成一条关掉判据的路径（T6 终审 H1 的
   * 态度问题：安全不变量不能挂在对方的公告上）。现在化身无条件必填，
   * 所以本方法**不参与**任何放行判断 —— 别再用它去决定要不要判。
   * @param {object|null} link
   * @returns {boolean}
   */
  _peerRequiresIncarnation(link) {
    if (!link) return false
    const feats = this._peerFeatures.get(link)
    return feats instanceof Set && feats.has(PEER_FEATURE_DOCUMENT_INCARNATION)
  }

  /**
   * 给**绑定读**的结果打来源标记，并记进锚点来源表（T34）。
   *
   * 两件事都做：
   *  1. `boundTo`：`'session'`（按会话钉在 grant 的连接上）/ `'active'`（活跃视角）。
   *     调用方据此知道"这个锚点是不是写路径的视角" —— 活跃视角的锚点**可能来自
   *     另一个窗口**，用它去写本会话就等着被 `applyEdit` 本地拒。
   *  2. `incarnation → {link, sessionId}`：`applyEdit` 判"锚点来源 ≠ 写目标"的唯一依据。
   *
   * 注意 `boundTo` 是**加在返回体上**的元信息，不是协议字段：对端不知道会话，
   * 它只回答"这份文档是什么状态"。所以它在 `validateResponse` **之后**加 ——
   * 契约校验的是对端回的字段，不是本端补的视图。
   *
   * @param {object} result 已过响应形状校验的对端结果
   * @param {{link: object|null, sessionId: string|null}} p
   * @returns {object}
   */
  _markBoundRead(result, { link, sessionId }) {
    if (result && typeof result === 'object' && typeof result.incarnation === 'string') {
      this._anchorSources.set(result.incarnation, {
        link: link ?? null,
        sessionId: sessionId ?? null,
        file: typeof result.file === 'string' ? result.file : null,
        at: Date.now(),
      })
      // FIFO 淘汰：Map 的插入顺序就是淘汰顺序（不是 LRU —— 这里够用且更简单诚实）。
      while (this._anchorSources.size > 256) {
        const oldest = this._anchorSources.keys().next()
        if (oldest.done) break
        this._anchorSources.delete(oldest.value)
      }
    }
    return {
      ...result,
      boundTo: sessionId ? 'session' : 'active',
      ...(sessionId ? { boundSessionId: sessionId } : {}),
    }
  }

  /**
   * 本地拒绝「拿别的窗口/别的会话的锚点去写」（T34）。
   *
   * 判据是对象身份：`incarnation` 是本次进程读出来的、且当时那条 `link` **不是**
   * 这次要写的那条 ⇒ 拒。**一个字节都不发**：错配的写请求一旦发出去，对端只能凭
   * 版本号判断，而版本号相等时它放行 —— 那正是 T5 记下的静默错配。
   *
   * 三种情况不拒（都不是"错配"，各有更该说话的人）：
   *  - 锚点不是本进程读出来的（表里没有）：来源不可自证，交给对端化身门兜底；
   *  - 写目标为空（没有有效 grant）：让绑定门报 -32010，那个错更准确；
   *  - 来源与目标**是同一条连接**：读和写走同一条线，正是我们要的形状。
   *
   * `data`：`{ method, reason: 'anchor-source-mismatch', stage: 'local',
   *           anchor: {boundTo, sessionId, file}, target: {sessionId} }`。
   * 码位 `-32602`：调用方用错了锚点，改法明确（改用 `kit.editing.stateFor(sessionId, file)`）。
   *
   * @param {string} method
   * @param {object} params
   * @param {{link: object|null, sessionId: string|null}} p
   * @throws {BridgeError}
   */
  _assertAnchorSource(method, params, { link, sessionId }) {
    const incarnation = params?.expectedIncarnation
    if (typeof incarnation !== 'string' || incarnation === '') return
    const source = this._anchorSources.get(incarnation)
    if (!source) return
    if (!link) return
    if (source.link === link) return
    throw new BridgeError(ERR.INVALID_PARAMS,
      'anchor-source-mismatch: this anchor was read from another window/session '
      + `(${source.sessionId ? `session ${source.sessionId}` : 'the active editor view'}`
      + `${source.file ? `, ${source.file}` : ''}), but this write is bound to `
      + `${sessionId ? `session ${sessionId}` : 'no session'}. Refusing to send it — `
      + 're-read the anchor with kit.editing.stateFor(sessionId, file).',
      {
        method,
        reason: 'anchor-source-mismatch',
        stage: 'local',
        anchor: {
          boundTo: source.sessionId ? 'session' : 'active',
          sessionId: source.sessionId ?? null,
          file: source.file ?? null,
        },
        target: { sessionId: sessionId ?? null },
      })
  }

  /**
   * 写入锚点的**绑定读**（T34）：`kit.editing.stateFor(sessionId, file, opts?)`。
   *
   * 与 `kit.vscode.getDocumentState` 的区别只有一处、但那是全部：**目标连接由会话的
   * grant 记录决定**，与写路径同一套口径。于是"锚点来自哪份文档"与"写入落哪份文档"
   * 由同一个事实源回答，跨窗口错配在源头上就不存在。
   *
   * 失败面：
   *  - 会话没有有效 grant / 记录里的连接已死 → `-32010`（`data.reason` = `no-grant` /
   *    `target-gone`）。**绝不**回退到活跃编辑器：回退就等于把 T5 的 Q1 原地复现。
   *  - `sessionId` / `file` 不成形 → `-32602`（`stage: 'local'`，本端零发送）。
   *
   * 返回体带 `boundTo:'session'` + `boundSessionId`，并把锚点记进来源表 —— 之后
   * `applyEdit` 才能证明"你这份锚点确实是这个会话读出来的"。
   *
   * @param {string} sessionId 调用方自己的 DSH 会话标识（不来自线路）
   * @param {string} file 工作区内的文件（绝对路径或相对工作区根）
   * @param {{includeText?: boolean, timeoutMs?: number}} [opts]
   * @returns {Promise<{file: string, version: number, incarnation?: string, isDirty: boolean,
   *   eol: 'lf'|'crlf', lineCount: number, textLength: number, text?: string,
   *   boundTo: 'session', boundSessionId: string}>}
   */
  async readStateFor(sessionId, file, opts = {}) {
    const method = 'vscode.getDocumentState'
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'kit.editing.stateFor(sessionId, file) requires a non-empty sessionId — '
        + 'the anchor is read through the grant record of that session, '
        + 'and there is no way to guess which window you mean',
        { method, reason: 'session-id-required', stage: 'local', got: { type: typeof sessionId } })
    }
    if (typeof file !== 'string' || file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'kit.editing.stateFor(sessionId, file) requires a non-empty file',
        { method, reason: 'file-required', stage: 'local', got: { type: typeof file } })
    }
    const params = { file }
    if (isPlainObject(opts) && 'includeText' in opts) params.includeText = opts.includeText
    const transport = isPlainObject(opts) ? { ...opts } : {}
    delete transport.includeText
    delete transport.sessionId
    return this.request(method, params, { ...transport, sessionId })
  }

  /**
   * 发放编辑授权（契约 §6.1 / §6.1.1 ①）。
   *
   * v1 最小形态（本卡定的申请流程，契约把"申请"留给协作编辑）：
   *  - **只在有目标连接时发放**：没有已准入且协议兼容的目标，直接抛（-32007 / -32008）。
   *    **不排队、不缓存** —— 排队等于发放一条对端永远收不到的凭证，还留在表里放行；
   *  - `id`/`epoch` 在这里各 `randomBytes(16)` 生成一次，此后终生不变（单一生成方=DSH）；
   *  - `sessionId` 是**调用方自己的 DSH 会话标识**（消费者从它自己的上下文里取，
   *    不是线路数据、也不是 grant 的一部分）。写请求必须带来同一个值才会放行
   *    （评审 F2；判定在 `dshWriteGate` 里，与七行判定同源）。不给 = 这条 grant
   *    永远不能用于写入（fail closed），所以正常调用都必须给；
   *  - 投递用 **request 并等结构化回执**（评审 F9）：扩展侧 `bridge.grant` 的 handler
   *    先把凭证存进它自己的表，然后才回 `{ok:true, id}`。收到回执才算发放成功；
   *    送不出去 / 超时 / 回执形状不对 → **撤销本地记录**再抛（不自动重发，
   *    重发由调用方决定，因为每次重发都可能覆盖旧凭证）。
   *
   * 异步（返回 Promise）：v1 起投递语义从"写进 socket 就算送达"改成了"等到回执"。
   *
   * @param {{sessionId?: string|null, windowId?: string|null, timeoutMs?: number,
   *          allowDirtySave?: boolean}} [opts] `allowDirtySave`（T39 / 契约 §6.2.2 结论）：
   *   允许 `vscode.save` 把**脏缓冲区**写进磁盘。★ **只属于授权方**——它在这里发放、
   *   落到 grant 记录上、随 `bridge.grant` 投递给执行端，**不许**由调用方在
   *   `params` 里自填（那等于自己给自己授权）。缺省 = 不允许（脏 = 拒）。
   * @returns {Promise<{id: string, epoch: string, windowId: string|null,
   *                    delivered: true, ack: {ok: true, id: string}}>}
   * @throws {BridgeError} -32007 没有目标连接 / -32008 目标协议不兼容
   *   / -32004 等不到回执 / -32010 `sessionId` 缺失或形状不对（凭证无法参与会话绑定）
   *   / -32602 `allowDirtySave` 不是布尔（放宽安全门的位不收"看起来像 true"的值）
   */
  async grantEditing({ sessionId = null, windowId = null, timeoutMs, allowDirtySave } = {}) {
    const link = this._activeLink()
    if (!link) {
      throw new BridgeError(
        ERR.DISCONNECTED,
        'no editor connected; refusing to grant editing (no target to deliver the grant to)',
        { method: 'bridge.grant', reason: 'no-editor', granted: false },
      )
    }
    // 版本门：`bridge.grant` 是协议层方法，但发的是**写权限凭证**，强制不豁免。
    this._assertProtocolCompatible('bridge.grant', link, { exempt: false })

    // 没有会话标识的 grant 是"谁拿到都能用"的 bearer 凭证 —— 契约要的会话授权不允许。
    // 在发放时就拒，而不是先发出去再指望没人用得上（评审 F2：默认允许 null 会话就是洞）。
    // 判序排在「有没有目标 / 版本是否兼容」之后：那两条是更前置的前提，
    // 先回答"现在能不能发"，再回答"发给谁、能不能用"。
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        "editing.grant requires sessionId (the caller's own DSH session); "
        + 'a grant without a session can never authorize a write',
        { method: 'bridge.grant', reason: 'session-required', field: 'sessionId', granted: false })
    }

    // ★ 评审 R2-2：**先 stage，不生效**。
    //   第一版这里是 `issue()`（生成即入 active 表），于是"等回执"这段时间里
    //   `lookup` / `_grantForSession` / writeGate 已经能拿它放行 —— 评审实测：回执永不返回，
    //   同 session 的并发写照样到达写宿主。而"对端还不知道这条凭证"这件事，恰恰是
    //   最不能放行的时刻（对端没有记录可复核，写请求等于裸奔）。
    //   pending 存在两张表之外，因此没有任何放行路径能看到它。
    // ★ T39：意图位**在发放时**就定型（契约 §6.2.2 的结论 / §6.2.8 待决 1 取 (b)）。
    //   只认严格布尔：`'true'`、`1`、`{}` 一律 -32602 —— 这个位放宽的是一道安全门，
    //   形状宽松就等于"半个默认开启"。缺省 = false（不传就是不允许）。
    if (allowDirtySave !== undefined && typeof allowDirtySave !== 'boolean') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'editing.grant allowDirtySave must be a boolean when provided; '
        + 'a permission bit does not accept truthy look-alikes',
        {
          method: 'bridge.grant',
          reason: 'allow-dirty-save-not-a-boolean',
          field: 'allowDirtySave',
          granted: false,
          got: { type: typeof allowDirtySave },
        })
    }
    const dirtySaveAllowed = allowDirtySave === true

    const { id, epoch } = this.grants.stage({ link, sessionId, windowId, allowDirtySave: dirtySaveAllowed })
    const grant = {
      id, epoch, sessionId, windowId, ...(dirtySaveAllowed ? { allowDirtySave: true } : {}),
    }
    const waitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.grantAckTimeoutMs
    let ack
    try {
      // 走 request（不是 notify）：没有回执就没有"扩展已存档"的证据（评审 F9）。
      // link.request 构造时带着 token，凭据的显式携带规则不变。
      ack = await link.request('bridge.grant', { grant }, { timeoutMs: waitMs })
      if (!ack || ack.ok !== true || ack.id !== id) {
        throw new BridgeError(ERR.INTERNAL,
          'bridge.grant was not acknowledged with {ok:true, id}; the editor did not store this grant',
          { method: 'bridge.grant', reason: 'no-ack', granted: false, ack: ack ?? null })
      }
      // ★ 回执合格还不够：承载连接/授权必须**此刻仍然有效**（评审 R2-2 ②）。
      //   等回执期间连接可能已经断了（或已被移出 trusted）—— 那时激活一条绑定在
      //   死连接上的凭证，等于制造一条永远无法复核的权限。
      if (!this._isCarrierUsable(link)) {
        throw new BridgeError(ERR.DISCONNECTED,
          'carrier connection went away while waiting for bridge.grant ack; grant not activated',
          { method: 'bridge.grant', reason: 'carrier-gone', granted: false })
      }
      // ★ 原子激活：同步一次状态迁移（Map delete+set，中间没有 await）。
      //   失败说明这条 pending 已被 supersede / 连接回收作废 —— 按"没生效"处理，绝不重试。
      if (!this.grants.activate(id)) {
        throw new BridgeError(ERR.INTERNAL,
          'staged grant was retired before activation (superseded or carrier closed); not granted',
          { method: 'bridge.grant', reason: 'grant-vanished', granted: false })
      }
    } catch (err) {
      // ★ 失败收口（评审 R2-2 ③；评审 R3-2 修正）：本地**和**对端都要处理，
      //   但**只针对这一条 id**，绝不波及承载连接。
      //   不能只清本地 pending —— 执行端可能已经 adopt 了这条权限（报文到了、回执没回来，
      //   或者回执在半路丢了），"我没收到回执"不等于"对端没存档"。所以：
      //     discard 本地 pending → 给这个 id 发 grantRevoke（尽力而为、幂等）→ 记诊断。
      //   ⚠️ 不 `link.close()`、不 `socket.destroy()`：那条连接上可能已经有一条健康的新
      //   授权（旧 pending 被 supersede 之后才失败），而且小超时可以反复触发 —— 踢连接
      //   既是误伤也是断连 DoS（评审实测，见 `_abortPendingGrant` 的注释）。
      this._abortPendingGrant(id, link, err)
      if (err instanceof BridgeError) throw err
      throw new BridgeError(ERR.INTERNAL,
        `bridge.grant delivery failed: ${err?.message ?? err}`,
        { method: 'bridge.grant', reason: 'delivery-failed', granted: false })
    }
    this.onLog?.('info', `edit grant issued (id ${id.slice(0, 8)}…, window ${windowId ?? 'n/a'})`)
    return { id, epoch, windowId, delivered: true, ack: { ok: true, id } }
  }

  /** @param {object} link 这条连接此刻还能承载凭证吗（活连接 + 仍被准入）。 */
  _isCarrierUsable(link) {
    if (!link || typeof link !== 'object') return false
    if (link.closed === true) return false
    if (link.socket?.destroyed === true) return false
    if (this.server?.trusted instanceof Set && !this.server.trusted.has(link)) return false
    return true
  }

  /**
   * 发放失败的对端收口（评审 R2-2 ③，**评审 R3-2 重做**）。
   *
   * 契约要求"失败闭合"，而**只有本端闭合是不够的**：对端可能已经存下这条凭证
   * （报文到了、回执没回来，或者回执在半路丢了）—— "我没收到回执"不等于"对端没存档"。
   *
   * 所以：本地 discard 这条 pending → 给**这一个 id** 发 `grantRevoke`（尽力而为、幂等）
   * → 记诊断。**就这三件事。**
   *
   * ⚠️ **绝不终止承载连接**（这是 R3-2 的结论，第一版写错了）：
   *  - 承载连接上可能已经有一条**另一条健康的新授权**（旧 pending 被 supersede 之后才失败），
   *    踢掉连接就是误伤它 —— 评审实测过 `NEW_GRANT_COLLATERAL {socketDestroyed:true,
   *    active:0, newGrantState:'tombstone', cause:'disconnected'}`。
   *  - 而且这是可反复触发的：小超时重试几次就能把连接反复踢断，构成断连 DoS
   *    （评审实测 `SMALL_DEADLINE_DOS`：一轮就把连接踢了）。
   * 每条失败只该影响**它自己那一条 id**。代价是"撤销报文可能没送到、对端留着一条本端
   * 已经不认的凭证"—— 但那条凭证的对端回执从没回来过，本端从头到尾没放过行，
   * 而这个残留由"连接断开时按 disconnected 回收"兜底，不需要靠主动断连来换。
   *
   * 关于"对端活着但一直不回执"（R3-2 ④）：pending 超时后按 `revoked` 永久作废
   * （不入 `disconnected`：连接还活着，这不是断连），并且**不禁**同一连接重新 `grant()`——
   * `stage()` 只作废该连接的既有记录，不会因为"上一条超时过"而拒绝新的一次发放，
   * 否则一次超时就把这个窗口永久锁死了。
   *
   * @param {string} id 已 stage 的 grant id（**只动它**）
   * @param {object} link 承载连接（只用来发撤销报文，不碰它的生命周期）
   * @param {unknown} err 触发收口的错误（只用于日志）
   */
  _abortPendingGrant(id, link, err) {
    // ① 本地：pending → 墓碑 revoked（永久作废；墓碑留给下次拿它来写时解释成 revoked
    //    而不是含糊的 no-grant）。命中不了（已被 supersede / 连接已回收）也算正常幂等。
    let discarded = false
    try {
      discarded = this.grants.discardPending(id, 'revoked')
    } catch (e) {
      this.onLog?.('warn', `abort pending grant: local discard failed: ${e?.message ?? e}`)
    }
    // ② 对端：**只给这个 id** 发撤销（带 token；不等回执 —— 拿不到回执正是这次失败的
    //    原因之一，再等一次没有意义）。连接没了就发不出去，那也无所谓：对端连接没了，
    //    它本地的 pending 也跟着没了。
    let delivered = false
    if (link && link.closed !== true && link.socket?.destroyed !== true) {
      try {
        link.notify('bridge.grantRevoke', { id, reason: 'revoked' }, { withToken: true })
        delivered = true
      } catch (e) {
        this.onLog?.('warn', `abort pending grant: revoke notify failed: ${e?.message ?? e}`)
      }
    }
    // ③ 诊断：说清"作了废什么 / 撤销有没有送到 / 连接刻意保留"。不碰连接，
    //    所以同连接上的其它 active grant 与后续 grant() 都完全不受影响。
    this.onLog?.('warn',
      `edit grant ${id.slice(0, 8)}… aborted after failed delivery: ${err?.message ?? err}`
      + ` (pending ${discarded ? 'discarded' : 'already gone'}; revoke`
      + ` ${delivered ? 'sent' : 'undeliverable'}; carrier link kept alive)`)

    // ④ 迁移合法性自检（R2-4 思想）：收口之后，这个 id **绝不能**还是 active/pending。
    //    留一条诊断比留一条隐形权限便宜得多。
    try {
      const after = this.grants.lookup(id)
      if (after?.kind === 'active') {
        this.onLog?.('error', `abort pending grant: ${id.slice(0, 8)}… is STILL active after abort`)
      }
    } catch { /* 诊断失败不影响收口结论 */ }
  }

  /**
   * 撤销编辑授权（`revoke(id?)`；省略 id 则撤销本端所有有效 grant）。
   *
   * **先本地失效，再尽力通知**：契约 §6.1.1 ①-b(2) 要求执行端的失效在本地完成、
   * 不依赖事后补发 —— 所以撤销报文丢了也不改变"已经撤销"这个结论。
   *
   * @param {string} [id]
   * @returns {{revoked: string[], count: number}}
   */
  revokeEditing(id) {
    const ids = (id === undefined || id === null)
      ? this.grants.active().map((r) => r.id)
      : [id]
    const revoked = []
    for (const one of ids) {
      const found = this.grants.lookup(one)
      if (!found) {
        // 可能是仍在等回执的 pending（`lookup` 按契约看不见它）：撤销 = 不再等它。
        // 对端这时可能已经存档，所以照样发撤销报文（拿 pendingCarrier 找到承载连接）。
        const carrier = this.grants.pendingCarrier(one)
        if (this.grants.discardPending(one, 'revoked')) {
          try { carrier?.notify('bridge.grantRevoke', { id: one, reason: 'revoked' }, { withToken: true }) } catch { /* 尽力而为 */ }
          revoked.push(one)
        }
        continue // 查不到/已是墓碑：幂等，不报错
      }
      if (found.kind !== 'active') continue
      const link = found.record.link
      this.grants.revoke(one, 'revoked') // ① 本地权威失效
      try { // ② 尽力通知（带 token；对端可能已经不在，发不出去不影响结论）
        link.notify('bridge.grantRevoke', { id: one, reason: 'revoked' }, { withToken: true })
      } catch (err) {
        this.onLog?.('warn', `edit grant revoke notify failed: ${err?.message ?? err}`)
      }
      revoked.push(one)
    }
    if (revoked.length > 0) {
      this.onLog?.('info', `edit grant revoked (${revoked.length})`)
    }
    return { revoked, count: revoked.length }
  }

  /**
   * 发起一次桥接请求。
   *
   * @param {string} method 形如 'vscode.openFile'，方法名即能力命名空间。
   * @param {object} [params]
   * @param {{timeoutMs?: number, waitForEditor?: boolean}} [opts]
   * @returns {Promise<any>}
   * @throws {BridgeError} -32001 未授权 / -32003 不存在 / -32004 超时 / -32005 不支持
   *   / -32007 未连接 / -32008 协议版本不兼容（契约 §4.1，发包前就拒）
   *   / -32009 对端响应形状不合格（契约 §5.1，facade 出口校验）
   *   / -32010 写入类方法没有有效授权绑定（契约 §6.1，**发包前就拒，一个字节都不发**）
   */
  async request(method, params = {}, opts = {}, consumer) {
    if (typeof method !== 'string' || method === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'method must be a non-empty string')
    }

    // ── per-plugin 能力白名单（契约 §6.2.5）：**第一道门** ──
    // 位置有意在最前面（连"等编辑器"都不开始等）：身份/档位不够时，一个字节都不发，
    // 也不消耗 3 秒等待 —— 否则真机上表现为"卡一下然后说没权限"，容易被当网络问题重试。
    // 身份是**第 4 个实参**，不是 opts 里的字段：opts 是"这趟怎么发"（timeoutMs 等），
    // 身份是"谁在发"。分开才不会让插件以为 `opts.consumer` 是它能填的东西，
    // 也保证糖衣不会因为注入身份而改变 opts 的形状（T30 有断言逐字守着这一点）。
    this._assertConsumer(consumer, method)

    const write = isWriteMethod(method)
    // ★ 评审 F2：`params.sessionId` 直接拒 —— 会话身份不许由业务参数自证。
    if (write) rejectParamsSessionId(params, method)

    const waitForEditor = opts.waitForEditor !== false
    const waitMs = waitForEditor ? (opts.waitMs ?? this.connectWaitMs) : 0

    // 调用方上下文里的会话身份（本端可信来源：消费者自己的 DSH 上下文，不是线路数据）。
    const sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== ''
      ? opts.sessionId
      : null

    // ── 窗口寻址（W2 / 多窗口寻址设计 §3）──
    // `opts.target` 只对**读**有意义：写目标由 grant 决定（§3.2），带 target 一律拒。
    // ★ 位置就是判定本身：`_bindWriteTarget` 之前、任何线路动作之前 ⇒ 对端零帧。
    //   写路径的 target **不退化成"最近的那个窗口"**：写错窗口比写失败贵得多。
    const target = readWindowTarget(opts)
    if (target && write) {
      throw windowTargetError(method, target, 'target-not-routable', {
        write: true,
        boundBy: 'grant',
      })
    }

    // ── 选目标（评审 F3）──
    // 读路径：显式 target > 绑定读的 grant 记录 > 当前活跃连接；写路径：只认 grant 记录。
    let link
    let wireParams = params
    if (write) {
      const bound = this._bindWriteTarget(params, sessionId)
      link = bound.link
      wireParams = bound.params
    } else if (sessionId && SESSION_BOUND_READS.includes(method)) {
      // ── 绑定读（T34）：给了 sessionId 就必须走该会话 grant 记录的那条 link ──
      // 与写路径**同一套**会话标识、同一条记录、同一个对象身份。
      // 没有有效记录时**绝不**回退 `_activeLink()` —— 那正是 T5 的 Q1：
      // 回退 = 锚点从"谁最后连上"的窗口读出来，再拿去写另一个窗口。
      //
      // ★ W2：target 解析排在记录检查**之前**（§3.1 ② 早于 ③）—— 给了 target 却指不到
      //   任何窗口时，报的是"你指错了窗口"（-32014），不是"你没有授权"（-32010）。
      const targetLink = target ? this._resolveWindowTarget(target, method) : null
      const found = this._grantForSession(sessionId)
      const record = found?.record ?? null
      link = record ? this._liveTargetOrNull(record) : null
      if (!link) {
        // 行 1（没有该会话的记录）/ 行 3（记录里的连接已死）—— 与判定表同一套 reason。
        throw editNotBoundError(method, record ? 'target-gone' : 'no-grant', record ? 3 : 1)
      }
      if (targetLink && targetLink !== link) {
        // 同一趟里"绑定的窗口"和"你指名的窗口"不是同一条连接 ⇒ 视角冲突，拒。
        // ★ 这里**不许**挑一边：挑 target = 读的不是你获准写的那份文档（T5 的 Q1 原形）；
        //   挑 record = 静默忽略调用方明确说了的 target。两种猜测都会让人以为成功了。
        throw windowTargetError(method, target, 'target-unauthorized', {
          sessionId,
          boundWindow: this._windowIdOf(link),
          targetWindow: this._windowIdOf(targetLink),
        })
      }
    } else if (target) {
      // 纯读显式寻址：**只**用 target 指的那条连接。解析不出来就在这里抛 -32014，
      // 绝不回退 `_activeLink()` —— 回了退，target 就成了"建议"而不是"路由"（§3.1 ④⑤）。
      link = this._resolveWindowTarget(target, method)
    } else {
      link = await this._waitForEditor(waitMs)
      if (!link) {
        throw new BridgeError(
          ERR.DISCONNECTED,
          'no editor connected; make sure the dsh-kit-bridge VSCode extension is running',
          { method, discoveryDir: discoveryDir(), waitedMs: waitMs },
        )
      }
    }

    // ── 协议兼容门 + 能力预检：判的、发的是**同一条**连接 ──
    // hello 之前没有对端版本，属于「未知版本」：先等一小段（扩展连上后立刻报 hello），
    // 等不到就按不兼容处理 —— 绝不把「还没报」推断成 v1。
    // ★ 评审 F1：等的是**这条连接**的 hello，判的也是这条连接，发还是这条连接。
    //   以前读全局槽，A 的 hello 会给 B 的目标位背书（探针 B/D 实测 fail-open）。
    // ★ 评审 F3：写路径的 link 可能为 null（没有有效记录），此时**不**回退到
    //   `_activeLink()` —— 显式传 null 进去，让下面那道门按判定表给出 -32010。
    if (link) {
      if (!link.editor && waitForEditor && this.helloWaitMs > 0) {
        await this._waitForHello(link, Math.min(this.helloWaitMs, waitMs))
      }
      this._assertProtocolCompatible(method, link)
      this._assertCapability(method, link)
    }

    // ── 会话授权绑定门（契约 §6.1，第二个门）：版本门 / 能力预检之后，写线路之前 ──
    // 位置就是契约要的那一处：判的是「这次要发的那条连接」（link），不是别的视图。
    // 失败在这里直接抛 -32010 —— 下面的 link.request 一行都没执行，业务帧零字节出门。
    // 判据是一张表（WRITE_METHODS）而不是一个开关：新增写入类能力只加一条表项，门自动生效。
    // ★ 评审 F2：会话身份从 `opts.sessionId`（调用方上下文）来，与记录里的比对。
    if (write) this._writeGate(method, wireParams, link, { sessionId })

    if (!link) {
      // 理论上到不了：上面那道门对"没有有效记录"必然抛 -32010。留一行兜底，别让
      // 裸 TypeError 成为失败形态（铁律 2）。
      throw new BridgeError(ERR.DISCONNECTED, 'no editor connected', { method })
    }

    // ── ★ T35：写锚点的第二半（文档实例身份）—— **所有写入口共用的那一道闸** ──
    // 为什么必须放在这里、而不是只放在糖衣 `kit.vscode.applyEdit` 里：
    // T6 终审 H1 证明公开的 `request('vscode.applyEdit', …)` 绕过糖衣就很成功 ——
    // 省略 `expectedIncarnation` ⇒ 桥端早失败跳过 + 事务内比较跳过 ⇒ 只剩整数版本比较，
    // 两个窗口版本数字相同时（v7/inc-A 与 v7/inc-B）按 B 的视图覆盖了 A 的人工内容。
    // raw request / 糖衣 / 位置形态 / 对象形态最后都汇到这一行，判在这里 = 四条入口同一道门。
    //
    // 判的是 `wireParams`（真正要上线的那份），不是调用方手里的 `params`：
    // 少判一次"发出去的那份"就等于给"参数在补 grant 时被换掉"留了缝。
    //
    // 位置有意排在 `_writeGate` **之后**：授权绑定门（-32010）的判定序是契约 §6.1.1 ①-c
    // 的七行，不能被参数形状门抢到前面去（那会让"没有授权"错报成"参数错"）。
    // 但仍在 `link.request` **之前** ⇒ 抛在这里 = 一个字节都没发出去（与 expectedVersion 同族）。
    if (write) assertLocalExpectedIncarnation(method, wireParams)

    // 断线不清任何「版本槽」：版本事实挂在连接上，连接没了自然失效。
    // （旧实现这里清全局 lastEditor，会导致下一条连接继承/丢失判定，见 F1。）
    const result = await link.request(
      method, wireParams, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined,
    )

    // ── facade 出口形状校验（契约 §5.1，-32009 invalid-response）──
    // 位置：糖衣 `kit.vscode.*` 就是本方法的一行转发，所以这里是「结果交回调用方之前」
    // 的唯一点，raw request() 与糖衣方法共用同一道闸。
    // ★ 只处理**成功返回**：上面的版本门 / 能力预检 / link.request 抛的 -3200x 在到达
    //   这里之前就已 reject，原样上浮，不会被包装成 -32009。
    // 校验规则见 response-contract.js（已发布能力逐字对照契约表，未登记能力只有最低校验）。
    const validated = validateResponse(method, result)
    // ★ T34：绑定读的出口标记。**只在形状校验之后**加 —— 契约校验的是对端回了什么，
    //   `boundTo` 是本端补的视图（对端根本不知道会话），不该混进对端字段里受校验。
    if (SESSION_BOUND_READS.includes(method)) {
      return this._markBoundRead(validated, { link, sessionId })
    }
    return validated
  }

  /**
   * 单向通知（不等待响应）。
   *
   * ★ 评审 F2：业务方法同样过版本门 + 能力预检 —— 单向不等于可以绕过判定，
   *   否则不兼容对端照样收到业务帧（探针 C：notify 业务方法 threw=null、对端增量 1）。
   *   `bridge.*` 继续豁免（协商通道不能被自己堵死，见上一轮裁决）。
   *   不改成 request：那会把「发了就算」变成「等回执」，改变语义与阻塞行为；
   *   判定失败时抛错，错误契约与 request 一致。
   */
  notify(method, params = {}, consumer) {
    if (typeof method !== 'string' || method === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'method must be a non-empty string')
    }
    // ★ 白名单对通知同样生效（单向不等于可以不判）：身份由入口给（第三个实参），
    //   未传时按宿主通道处理（类实例的既有调用方）。消费者拿到的 facade 已经替他们盖好了。
    this._assertConsumer(consumer, method)
    // ★ 评审 F5：写入类方法**不许**走通知。通知没有回执，发送前门判完也证明不了
    //   对端存下了；而"默认给通知带 token 让它变成可执行写"是把漏洞换个位置。
    //   入口就拒，要求改用 request()（那道门与会话绑定才跑得起来）。
    assertWritableNotNotified(method, 'notify')
    const link = this._activeLink()
    if (!link) throw new BridgeError(ERR.DISCONNECTED, 'no editor connected', { method })
    this._assertProtocolCompatible(method, link)
    this._assertCapability(method, link)
    link.notify(method, params)
  }

  /**
   * 诊断快照：排障时打印用，不属于稳定 API。
   *
   * `protocolCompatible` / `lastEditor` 与兼容门**同源**：都从当前目标连接的
   * `link.editor` 取（评审 F1：snapshot 不得另算一份）。
   */
  snapshot() {
    const editor = this.lastEditor
    return {
      port: this.server.port,
      pid: process.pid,
      dshVersion: this.dshVersion,
      protocolVersion: PROTOCOL_VERSION,
      // 兼容区间（契约 §4.1 ①）与对端判定结果都放进诊断快照：
      // snapshot 不属于稳定 API，增删字段不算破坏性变更。
      supportedProtocol: SUPPORTED_PROTOCOL,
      protocolCompatible: editor ? editor.protocolCompatible : false,
      // 没有目标 / 目标没报 hello 时给出原因，排障不用猜（与评审 F4 同精神）。
      protocolReason: editor ? editor.protocolReason : 'no-target',
      connections: this.server.links.size,
      lastEditor: editor,
      discoveryPath: this.server.discoveryPath,
      /**
       * per-plugin 白名单的**可观测面**（契约 §6.2.5 要求"默认拒必须看得见"）。
       *
       * 三份记录回答三个真机问题：①这个消费者被判成哪一档（`consumers`/`bindings`）；
       * ②它为什么被拒（`denials` 里每条的 `{method, tier, consumer, declared, allowed, reason}`）；
       * ③配置里哪几行没生效（`invalid`）。没有这三份，"能力不存在"这种误导性失败
       * 在真机上就只剩重试。
       */
      consumerPolicy: this.whitelist.snapshot(),
    }
  }
}

/**
 * cordis 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @param {number[]} [config.portRange]  默认 [7410, 7419]
 * @param {string}   [config.dshHome]    覆盖 DSH_HOME（测试用）
 * @param {number}   [config.connectWaitMs] 请求前等编辑器连接的时长，默认 3000
 * @param {number}   [config.helloWaitMs]   请求前等对端 hello（协议版本）的时长，默认 1000
 * @param {boolean}  [config.enabled]    置 false 则只注册服务不监听（便于排障）
 * @param {object}   [config.consumers]  per-plugin 能力白名单：`{ 插件名: 档位 }`，
 *   档位取 `read` / `buffer-edit` / `disk-write` / `delete`（契约 §6.2.5）。
 *   未列出的插件默认 `read`（只读四能力放行，`buffer-edit` 及以上一律拒）。
 *   配置从 cordis 传进来，本库**不读配置文件**（零依赖 + 配置归宿主）。
 * @param {(level: string, msg: string, extra?: any) => void} [config.onLog]
 */
export function apply(ctx, config = {}) {
  const {
    portRange,
    dshHome,
    connectWaitMs = DEFAULT_CONNECT_WAIT_MS,
    helloWaitMs = DEFAULT_HELLO_WAIT_MS,
    grantAckTimeoutMs = DEFAULT_GRANT_ACK_TIMEOUT_MS,
    enabled = true,
    consumers,
    onLog,
  } = config ?? {}

  const log = (level, msg, extra) => {
    try {
      onLog ?. (level, `[dsh-vscode-kit] ${msg}`, extra)
      if (!onLog) {
        const line = `[dsh-vscode-kit] ${msg}`
        if (level === 'error') console.error(line, extra ?? '')
        else if (level === 'warn') console.warn(line, extra ?? '')
        else console.log(line, extra ?? '')
      }
    } catch { /* 日志不许影响主流程 */ }
  }

  /** 服务实例在监听成功后才有；消费者可能早于监听就 inject，故用惰性代理。 */
  let kit = null

  /**
   * per-plugin 能力白名单（契约 §6.2.5 / §6.2.8 第 3 条）。
   *
   * 粒度是 **插件名 × 最高档位**（契约 §6.2.8 第 3 条的待决项落在这里）：
   * 「能读」和「能删」不是同一根轴上的刻度，所以配置里给每个插件只写一个档位词。
   * 配置落 **DSH 宿主侧**（cordis 的 `consumers`），不落扩展侧 —— 扩展根本不知道
   * DSH 里的插件叫什么名字。
   *
   * 在 `apply()` 里就建好（不是 boot 里）：消费者可能在 boot 之前就 `forPlugin()` 领身份，
   * 领身份不依赖监听，只依赖配置。
   */
  const whitelist = new Whitelist(consumers, { onLog: log })
  // 加载期一句话把策略说清楚（配错了要在这里看得见，而不是等到某次调用被拒）。
  log('info', whitelist.summary())
  /**
   * 监听已起、但 kit 还没装配完的空窗期里通过准入的连接。
   * 单纯丢掉它们会让「扩展恰好比 kit 快一步」变成一次静默失败，
   * 所以要记下来、装配完补通知。
   */
  const pendingAuthorized = new Set()
  let disposed = false
  /**
   * 监听就绪信号。一次性 Promise：resolve 后 await 它永远立即返回 true。
   * 不用 EventEmitter —— 只需要「就绪/超时」两种结果，一个已结算的 Promise 就够。
   */
  let settleReady
  const readySignal = new Promise((resolve) => { settleReady = resolve })

  // 消费者通过 inject: ['dshVscodeKit'] 拿到的就是这个对象。
  // 用普通对象（不是 Service 子类）+ 转发方法，避免消费者在监听就绪前拿到 null。
  //
  // ★ 早期写成 `get vscode() { return kit?.vscode ?? {} }`，真机上出过两类问题：
  //   ① 监听没起来时消费者拿到 `{}`，调用得 `kit.vscode.openFile is not a function`
  //      （裸 TypeError，没有错误码、没有原因，最糟的失败形态）；
  //   ② 消费者把方法**解构**出去后（`const { bind } = kit.vscode`），就算监听后来就绪，
  //      解构出来的已经是 `undefined`，永远好不了。
  //   所以糖衣方法必须是**稳定存在**的转发函数，只在调用时检查就绪状态。
  const notReady = (method) => Promise.reject(new BridgeError(ERR.DISCONNECTED,
    'dsh-vscode-kit is not listening yet', { method, reason: 'server-not-ready' }))

  /**
   * 共享 facade 的请求入口 —— **未绑定身份通道**（`UNBOUND_CONSUMER`）。
   *
   * 这是本次收口的关键一行：以前这里原样透传 `opts`，于是 `ctx.provide` 出去的
   * 那个共享实例在能力判定上没有身份可言（谁能拿到服务就能调任何 `vscode.*`，
   * 契约 §6 开头点名的那笔债）。现在每一个调用都盖上"未绑定"的戳：
   * 天花板 `read`，写入类一律 `-32602` 拒，且**零字节出门**。
   *
   * 想写 ⇒ 必须先 `kit.forPlugin('你的插件名', { declared })` 领一个身份
   * （并且那个名字要在宿主配置的 `consumers` 里被放行）。
   */
  const requestUnbound = (method, params, opts) => (kit
    ? kit.request(method, params, opts, UNBOUND_CONSUMER)
    : notReady(method))

  const vscode = {
    // 只读四能力（契约 §6.2.1 Tier 1）：未声明身份也**必须**继续可用 —— 这是
    // 白名单落地的兼容底线，不因为"没报名字"就把读也一起关了。
    openFile: (params, opts) => requestUnbound('vscode.openFile', params, opts),
    getSelection: (params, opts) => requestUnbound('vscode.getSelection', params, opts),
    getDiagnostics: (params, opts) => requestUnbound('vscode.getDiagnostics', params, opts),
    listOpenEditors: (params, opts) => requestUnbound('vscode.listOpenEditors', params, opts),
    // 写入类糖衣：与 VscodeKit.vscode.applyEdit 成对出现（契约 §2.2 第②步：
    // 要加就两处都加；只加一处会让 facade 消费者拿到裸 TypeError）。
    // 注意这里用 `(...args)` 原样转发：`applyEdit` 支持位置形态与对象形态两种调用，
    // facade 若只转发 `(params, opts)` 就会把位置形态的第二个参数（range）当成 opts 丢掉。
    // ★ 走未绑定通道 ⇒ 未 `forPlugin()` 的消费者在这里拿 `-32602`（reason `consumer-unbound`）。
    applyEdit: (...args) => (kit
      ? kit.applyEditAs(UNBOUND_CONSUMER, args)
      : notReady('vscode.applyEdit')),
    // 写入锚点的读侧（T30），同样两处都加。
    getDocumentState: (...args) => {
      const { params, opts } = normalizeDocStateArgs(args)
      return requestUnbound('vscode.getDocumentState', params, opts)
    },
    // 落盘（T39）：两处都加（契约 §2.2 第②步）。未绑定身份 ⇒ 白名单 `read` 天花板
    // 在这条路上先拒（`consumer-unbound` / 档位不足），轮不到绑定门说话。
    save: (...args) => (kit
      ? kit.saveAs(UNBOUND_CONSUMER, args)
      : notReady('vscode.save')),
    // 删除（T40 / Tier 4）：两处都加。未绑定身份 ⇒ 白名单最高档 `delete` 先拒
    // （`consumer-unbound`），**连确认框都不会弹** —— 这是有意的：不可逆动作不接受
    // "先试一下看看"。
    deleteFile: (...args) => (kit
      ? kit.deleteFileAs(UNBOUND_CONSUMER, args)
      : notReady('vscode.deleteFile')),
    // 多窗口视图（W1 / 契约 §2.2 第②步：三处都加 —— 类实例、绑身份、未绑定）。
    // 只读诊断：未就绪时返回空表（同 `editing.list`），不 reject；档位 `read` ⇒
    // 未声明身份也放行（白名单里 `vscode.windows.list` 就是 read）。
    windows: {
      list: () => (kit ? kit.listWindows(UNBOUND_CONSUMER) : []),
    },
  }

  /**
   * 编辑授权面（`kit.editing.*`）—— 同样是**稳定存在**的转发函数。
   *
   * 未就绪时的失败形态按语义分：`grant`/`revoke` 是命令，抛 -32007 server-not-ready；
   * `list` 是只读诊断，返回空表（让排障代码不必为"还没起来"写分支）。
   */
  const editing = {
    grant: (opts) => {
      if (!kit) {
        throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
          { method: 'bridge.grant', reason: 'server-not-ready' })
      }
      return kit.editing.grant(opts)
    },
    revoke: (id) => {
      if (!kit) {
        throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
          { method: 'bridge.grantRevoke', reason: 'server-not-ready' })
      }
      return kit.editing.revoke(id)
    },
    list: () => (kit ? kit.editing.list() : []),
    /**
     * 写入锚点的**绑定读**（T34）。与 `kit.editing.grant/revoke` 一样稳定存在：
     * 未就绪时抛 -32007（它是命令，不是诊断视图）—— 拿不到锚点就没法写，
     * 与其返回一个空对象让调用方解构出 undefined 去发请求，不如当场说清楚。
     */
    stateFor: (sessionId, file, opts) => {
      if (!kit) {
        throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
          { method: 'vscode.getDocumentState', reason: 'server-not-ready' })
      }
      return kit.editing.stateFor(sessionId, file, opts)
    },
  }

  const facade = {
    get ready() { return kit !== null },
    /** 未绑定身份（诊断用；不是判据）。 */
    consumer: { ...UNBOUND_CONSUMER },
    get vscode() { return vscode },
    get editing() { return editing },
    request: requestUnbound,
    notify: (method, params) => {
      if (!kit) throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
        { method, reason: 'server-not-ready' })
      return kit.notify(method, params, UNBOUND_CONSUMER)
    },
    /**
     * 领一个**绑定身份**的 facade（本次新增的显式入口）。
     *
     * 名字：`forPlugin`。理由有三，都是"少一层歧义"：
     *  - 它回答的问题是「**哪个插件**在调」，而不是「以什么路径调」——`forPlugin('dsh-kit-demo')`
     *    读起来就是"给 dsh-kit-demo 绑一个身份"，与 `inject: ['dshVscodeKit']` 里的插件名
     *    同一个语境（所以要求传**自己的 cordis 插件名**，而不是随手起的别名）；
     *  - 比 `as()` / `bind()` / `with()` 具体：那几个名字在别的库里都是"改 this"的意思，
     *    而这里改的是**能力天花板**，含糊的名字会让调用方以为它只是语法糖；
     *  - 与配置项 `consumers: { <同一个名字>: <档位> }` 逐字对齐 —— 报的名字要和配的键一致，
     *    这是本层唯一能做的"身份校验"（advisory，见 `whitelist.js` 顶部）。
     *
     * `declared` 是你**自己声明**的最高档位：`read` / `buffer-edit` / `disk-write` / `delete`。
     * 省略或拼错一律按 `read`（想写就必须显式写出来）。最终天花板 = min(declared, 配置给的值)。
     *
     * @param {string} name 你的 cordis 插件名
     * @param {{declared?: string}} [opts]
     * @returns {object} 形状与 facade 相同、但每个调用都带这个身份的 facade
     */
    forPlugin: (name, opts) => boundFacade(() => kit, whitelist.bind(name, opts), facade),
    snapshot: () => (kit ? kit.snapshot() : { ready: false }),
    /**
     * 等监听就绪。消费者在 apply 里立刻调用能力时（真机 demo 就这么干的），
     * 服务已被 provide 但 server 还没 listen，此时 request 会得到 server-not-ready。
     * 与其让每个消费者自己写轮询，不如提供这一个等待点。
     * 超时返回 false（不抛），让调用方自己决定降级策略。
     * 一旦就绪，后续调用立即返回 true（Promise 已 resolve）。
     */
    waitReady: async (timeoutMs = 5000) => {
      if (kit !== null) return true
      if (!(timeoutMs > 0)) return false
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
      const ok = await Promise.race([readySignal, timeout])
      clearTimeout(timer)
      return ok
    },
  }

  // 注册服务：ctx.provide(name, 普通值)。
  //
  // ★ 这里**刻意不传 check 谓词**。cordis 的 check 是 `get` 时的门禁
  //   （_checkImpl 里 `if (impl.check && !impl.check(...)) return delete this._store[name]`），
  //   **不是**状态变化信号：谓词变真之后没有任何机制会重新通知等待者。
  //   真机踩过：写成 `() => kit !== null` 会让消费者永远 pending
  //   （`dsh: warning: 1 entry did not activate` / `waiting for services`）。
  //   facade 本身已经能安全承受「监听未就绪」（request 会立刻拒 server-not-ready），
  //   所以这里只要无条件暴露即可。
  ctx.provide('dshVscodeKit', facade)

  if (!enabled) {
    log('warn', 'disabled by config; service registered but not listening')
    return
  }

  // 异步启动监听。不阻塞 apply，避免 DSH 启动时被端口探测拖慢。
  const boot = (async () => {
    try {
      const server = await startBridgeServer({
        portRange,
        dshHome,
        dshVersion: readDshVersion(),
        capabilities: INBOUND_CAPABILITIES,
        onRequest: handleInbound,
        onError: (err) => log('warn', `protocol error: ${err?.message ?? err}`),
        // hello 由协议层（server.js）自动下发；这里只做插件层的事：
        // 记录连接、唤醒等待编辑器的消费者。
        onConnected: (link) => {
          // 日志是排障的第一手证据：真机上「扩展到底连上没有」不该靠猜。
          // 注意这是「连上」不是「准入」——准入（token 校验通过）另有日志。
          const peer = link.socket?.remotePort
          log('info', `editor connected (remote port ${peer ?? 'unknown'})`)
        },
        // ★ 安全（洞 2）：只有通过 token 校验的连接才通知等待者。
        // 未准入的裸连接可能永远不发消息 —— 那种连接不能被当成编辑器。
        onAuthorized: (link) => {
          if (kit === null) {
            // 监听刚起、kit 还没装配完：先记进 pending，装配后补通知。
            pendingAuthorized.add(link)
            return
          }
          log('info', 'editor authorized (token accepted)')
          // ★ 新准入对端 = 新身份：上一轮 hello 的版本/能力不得为它背书（契约 §4.1）。
          //   这一步现在是**结构上自动成立**的：身份挂在连接自己身上（`link.editor`），
          //   新连接生来没有 hello 记录，不需要（也不再允许）去清一个全局槽。
          //   （旧实现是 `kit.lastEditor = null`，那正是评审 F1 的双源。）
          kit._notifyConnected(link)
        },
        // ★ 会话授权绑定（契约 §6.1.1 ①-b(2)）：承载连接消失 → 这条连接上的编辑授权
        //   立刻失效，由**协议层的连接生命周期**驱动（不是定时器、不是轮询、不是计数器）。
        //   收回判据是换进来的这个 link 对象身份，`grants` 里存的就是它。
        //   闭包读 `kit` 变量而不是参数：监听先起、kit 后装配，空窗期内没有 grant 可回收，
        //   但绑定仍然正确（那时 `kit === null`，`?.` 安全跳过）。
        onLinkClosed: (link) => {
          const n = kit?.grants.closeLink(link) ?? 0
          if (n > 0) log('info', `edit grant invalidated by disconnect (${n})`)
          // W2：留一块墓碑，好把"窗口关了"与"号写错了"分开报（`window-closed` / `window-not-found`）。
          // 只在**判定**里用，不参与放行 —— 墓碑只会让错误更准，不会让门更松。
          kit?._noteWindowClosed(link)
        },
      })

      kit = new VscodeKit({
        server,
        dshVersion: readDshVersion(),
        connectWaitMs,
        helloWaitMs,
        grantAckTimeoutMs,
        onLog: log,
        // 白名单实例在 apply() 里就建好（`forPlugin` 可能早于 boot 调用），
        // 这里只是把它交给实例 —— 判定表与拒绝记录因此只有一份。
        whitelist,
        // W1：窗口注册表落在这里（`~/.dsh/dsh-vscode-kit/windows.json`）。
        // 传下去而不是让 VscodeKit 自己读环境变量：配置只有一个来源（`apply()` 的 config）。
        dshHome,
      })

      // 服务端反向收到的编辑器身份存在 lastEditor（能力降级的判据）。
      // 编辑器连上后也会主动发 bridge.hello 请求，handleInbound 里记录。

      // 补通知空窗期内已准入的连接（它们可能比 kit 装配更早到）。
      // 这个窗口是真的：startBridgeServer 内部 await 期间端口已在监听，
      // 扩展正好轮询到就会连上并发消息 —— 那条消息的准入发生在 kit 装配之前。
      // 不打日志就会在真机上「凭空少一条 authorized」，排障时极易误判。
      replayPendingAuthorized(server, pendingAuthorized, (link) => {
        log('info', 'editor authorized during startup (notified after wiring)')
        kit._notifyConnected(link)
      })

      log('info', `listening on 127.0.0.1:${server.port} (discovery: ${server.discoveryPath})`)
      log('info', `live bridges under ${resolveDshHome(dshHome)}: ${listLiveBridges(discoveryDir(dshHome)).length}`)

      // 唤醒所有 waitReady 等待者（Promise 一旦 resolve，后续 await 立即返回 true）。
      settleReady(true)
    } catch (err) {
      log('error', `failed to start bridge server: ${err?.message ?? err}`)
      // 不抛：插件加载失败会让整个 profile 出问题（dsh-plugin-guide 排障提示 T3）。
      // 改为在 snapshot 里标记，消费者请求时得到结构化错误。
    }
  })()

  /** 处理编辑器发来的入站请求（首版只有 ping，留好扩展点）。 */
  function handleInbound(method, params, msgCtx) {
    switch (method) {
      case 'bridge.ping':
        return { pong: true, at: Date.now(), echo: params }
      case 'bridge.hello': {
        // 编辑器主动报身份（本协议服务端先发 hello，这里兜住对端也发的情况）。
        // 记录**协议版本**与能力清单：版本是 §4.1 兼容门的唯一判据（只认 hello 携带的 ptv），
        // 能力清单是能力预检的判据。
        if (kit && params && typeof params === 'object') {
          // 「没有这个字段」和「有字段但值非法」必须能分开 —— 前者绝不补成 1。
          const present = Object.prototype.hasOwnProperty.call(params, 'protocolVersion')
          const ptv = present ? params.protocolVersion : undefined
          const verdict = judgeProtocolVersion(ptv)
          const editor = {
            client: params.client ?? 'unknown',
            extensionVersion: params.extensionVersion ?? null,
            protocolVersion: ptv,
            protocolVersionPresent: present,
            protocolCompatible: verdict.compatible,
            protocolReason: verdict.reason,
            capabilities: Array.isArray(params.capabilities) ? params.capabilities : [],
            seenAt: Date.now(),
          }
          // ★ 评审 F1：写在**这条连接**身上（`ctx.link`，protocol.js 提供），
          //   不再写全局槽。这样「谁报的 hello」与「包发给谁」永远是同一条连接。
          if (msgCtx?.link) {
            msgCtx.link.editor = editor
            // ★ T34：语义能力公告（`features`）按连接记 —— 它决定糖衣要不要强制化身锚点。
            kit._notePeerFeatures(msgCtx.link, params.features)
            // ★ W1：窗口身份候选（W3 上报）。**只用来签发 / 匹配 windowId**，
            //   不参与任何判定：删掉 hello 里的 `window` 块，全部判定测试必须依然全绿。
            kit._noteWindowIdentity(msgCtx.link, params.window)
            kit._notifyHello(msgCtx.link)
          } else {
            // 理论上到不了：协议层给每次分派都带 ctx.link。真到了就 fail-closed ——
            // 不记身份等于「这条连接版本未知」，业务方法会被门拒，不会误放行。
            log('warn', 'bridge.hello without link context; peer identity not recorded '
              + '(business calls will fail-closed with -32008)')
          }
          if (!verdict.compatible) {
            log('warn', `editor protocol incompatible (${verdict.reason}: `
              + `ptv=${JSON.stringify(verdict.peer)} present=${present}); `
              + 'business capabilities fail-closed with -32008')
          }
        }
        return { ok: true, protocolVersion: PROTOCOL_VERSION, dshVersion: readDshVersion() }
      }
      default:
        throw new BridgeError(ERR.METHOD_NOT_FOUND, `unsupported inbound method "${method}"`,
          { method })
    }
  }

  // cordis 生命周期：插件卸载时关服务、删发现文件。
  // 卸载必须可等待：消费者可能紧接着断言发现文件已删 / 端口已释放。
  let disposeResolve
  const disposedPromise = new Promise((r) => { disposeResolve = r })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true
      // 唤醒 waitReady 等待者（返回 false，让它们立刻降级而不是等到超时）
      settleReady(false)
      // 断开所有等待者，避免消费者永久挂起
      for (const waiter of [...(kit?.waiters ?? [])]) waiter(null)
      const fin = () => {
        log('info', 'bridge server closed')
        disposeResolve()
      }
      if (kit) kit.server.close().then(fin, fin)
      else fin()
    })
  } else {
    log('warn', 'ctx.effect unavailable; relying on process exit hooks for cleanup')
    disposeResolve()
  }

  return {
    boot,
    get kit() { return kit },
    get disposed() { return disposed },
    /** 等 server.close() 完成（测试/CLI 用）。 */
    get stopped() { return disposedPromise },
  }
}

/**
 * 内部：补通知「启动空窗期」内已准入的连接给等待中消费者。
 *
 * 这个窗口是真的：startBridgeServer 内部 await 期间端口已在监听，扩展正好轮询到
 * 就会连上并发消息 —— 那条消息的准入发生在 kit 装配之前。单纯丢掉它们会让
 * 「扩展恰好比 kit 快一步」变成一次静默失败，所以要记下来、装配完补通知。
 *
 * ★ 必须先查 `server.trusted` 再通知：空窗期准入后又断线的连接已不在 trusted，
 *   唤醒等待者会让消费者拿一条死连接发请求。`pendingAuthorized` 无论跳过几条都必须清空，
 *   否则装配完成后它还会留在集合里，下次再也清不掉。
 *
 * @internal 导出仅为单测直接守门这条分支：该时间窗无法通过公开 API 稳定复现
 *   （listen 到 kit 装配之间只有微任务，测试进程插不进去）。不属于稳定 API。
 * @param {{trusted: Set<any>}} server
 * @param {Set<any>} pendingAuthorized
 * @param {(link: any) => void} notify
 */
export function replayPendingAuthorized(server, pendingAuthorized, notify) {
  for (const link of pendingAuthorized) {
    if (!server.trusted.has(link)) continue // 空窗期断线后不能唤醒等待者。
    notify(link)
  }
  pendingAuthorized.clear()
}

/** 读 DSH 版本，失败返回 'unknown'（绝不因为版本探测失败影响插件加载）。 */
function readDshVersion() {
  // 环境变量优先（宿主若注入），否则从 process.argv/包路径都不可靠时不猜
  return process.env.DSH_VERSION || 'unknown'
}

// 注：曾有 `export function onEditorConnected(kit, link)` —— 全仓零调用方的死代码，
// 且它维护的是已删除的全局 lastEditor 槽（评审 F5）。与会话状态有关的两件事现在各有
// 明确归属：唤醒等待者由 `apply()` 的 onAuthorized / replayPendingAuthorized 做，
// 对端身份由 hello 写到 `link.editor`。删掉不影响任何消费者（无导入点、无文档引用）。

export { VscodeKit }
// 白名单的档位模型对外暴露（消费者/测试要能查"某方法落在哪一档"，
// 也不必自己抄一份 `TIERS`；抄一份就会漂移）。
export {
  TIERS, METHOD_TIERS, tierOf, tierRank, isTier, minTier, Whitelist,
  UNBOUND_CONSUMER, HOST_CONSUMER,
} from './whitelist.js'
export {
  BridgeError, ERR, PROTOCOL_VERSION, SUPPORTED_PROTOCOL, hasCapability,
} from './protocol.js'
export {
  startBridgeServer, listLiveBridges, discoveryDir, resolveDshHome,
  writeDiscoveryFile, sweepDiscoveryDir, isProcessAlive, DEFAULT_PORT_RANGE,
} from './server.js'

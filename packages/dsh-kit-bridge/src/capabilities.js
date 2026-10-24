/**
 * 能力实现：VS Code 能力的唯一实现处。
 *
 * 设计要点：
 *  - **不直接 import 'vscode'**，全部经 `host` 注入 —— 这样能在 node:test 里单测，
 *    不必起 Electron / 扩展宿主。
 *  - 每个能力先做三项前置检查（信任 / 可用性 / 参数），再做实际动作。
 *  - 失败一律抛 BridgeError 带稳定错误码，让 DSH 侧拿到结构化原因而不是字符串。
 *
 * 坐标约定：协议对外一律 **1-based** 的 line/column（人和日志都好读），
 * 在调用 VSCode API 的边界上转成内部的 0-based。
 */

import { createHash, randomBytes } from 'node:crypto'

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
import {
  GRANT_REASONS, editNotBoundError, extensionWriteGate, isWriteMethod,
  grantAllowsDirtySave,
} from '../../dsh-vscode-kit/src/grant.js'
import {
  resolveWorkspaceFile, revalidateWriteTarget, assertTargetUnchanged,
  assertWrittenDocumentIdentity,
} from './workspace-paths.js'
import { createEventBroker } from '../../dsh-vscode-kit/src/event-subscriptions.js'
import { canonicalPath, pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'

/** 本扩展声明支持的能力清单（写进发现文件 / hello 的 capabilities）。 */
export const CAPABILITIES = [
  'vscode.openFile',
  'vscode.getSelection',
  'vscode.getDiagnostics',
  'vscode.listOpenEditors',
  'vscode.applyEdit',
  // 写入锚点的读侧（T30）：`applyEdit` 的 `expectedVersion` 只能从这里拿。
  // 只读，不改宿主状态，因此**不要求** grant（写入才要求，契约 §6.1）。
  'vscode.getDocumentState',
  // Tier 3 落盘（T39）：**写**能力，必须走绑定门（`WRITE_METHODS`）。
  // 与 `applyEdit` 的区别只有一步 —— 它真的落盘（Buffer 之外的字节被改）。
  //
  // ⚠️ 磁盘锚点的读侧（`host.readDiskStat`）**不是**一条协议能力（§6.2.3 规定的是
  //    "宿主新增 readDiskStat"，§6.2.8 待决 7 的"独立方法"也只说不许塞进
  //    `getDocumentState`）。理由：它是 `vscode.save` 自己的前置门，调用方手里的
  //    `expectedDisk` 来自它**自己观察到的那次 stat**（同机文件，读它不需要本通道）；
  //    把它开成能力等于多一条"任何人都能读任意路径元数据"的面，收益为零。
  'vscode.save',
  // Tier 4 删除（T40；T44 把语义改成"移入隔离区，永不删"）。写能力，必须走绑定门，
  // 白名单档位是最高档 `delete`（`whitelist.js` 的 `METHOD_TIERS` 早已登记）。
  //
  // ★ 契约 §6.2.5：**白名单是必要条件，不是充分条件**。这个能力必须**同时**有
  //   「白名单 + 人工确认 + 内容快照」三者，缺一条提示注入（T-B）就能成功。
  // ★ T44：动作从"删"改成"rename 进 `<root>/.dsh-quarantine/`，永不删"。名字与门槛
  //   全部保留（外部合同不变：grant/确认/整份备份都要），但代码里**没有**删除调用。
  'vscode.deleteFile',
  // 事件订阅（E3）：**观察**能力，不是写能力 —— 不进 `WRITE_METHODS`、不要求 grant，
  // 白名单档位是 `read`（`whitelist.js` 的 `METHOD_TIERS`）。
  //
  // 为什么它就够、不需要第二条"推事件"能力：事件是**通知**（`vscode.events.event`），
  // 协议层只接收、不可被调用（`protocol.js` 对带 id 的那条回 `-32600 events must be
  // notifications`）。所以要"开一条推流"的只有订阅这一件事 —— 开流、登记消费者、
  // 冻结 `{subscriptionId, streamEpoch, startSeq}` 初态屏障，全在 subscribe 的回执里。
  'vscode.events.subscribe',
  'vscode.events.unsubscribe',
]

/**
 * `includeText:true` 时允许随响应带回的文档文本上限（**字节**，UTF-8）。
 *
 * 为什么是 8 MiB 而不是"字符数"或"不设上限"：这条能力的返回会经过 ndjson 分帧、
 * loopback TCP、以及 DSH 侧的消费者（通常还要塞进模型上下文）。**超限必须整份不给**
 * （`textUnavailable:true`），绝不许截断后当全文 —— 一份被悄悄截断的"全文"是比报错
 * 危险得多的失败形态：调用方会拿它去算坐标、比对范围，然后在错的地方写字。
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024

/**
 * 删除前内容快照允许读进来的**总**字节上限（UTF-8 / 任意字节）。
 *
 * 超限**整份放弃**（`-32603 reason:'snapshot-unavailable'`），绝不"读了前半截也删" ——
 * 半份快照比没有快照更坏：它会让人以为"我有恢复材料"，而那份材料缺了尾部。
 * 8 MiB 与 `MAX_TEXT_BYTES` 同源（同一个理由：返回要过 ndjson + loopback + 消费者）。
 *
 * ★ 注意区分：这是**读**的上限。能不能**删**取决于能不能把整份字节交出去，
 * 见 `DELETE_BACKUP_MAX_BYTES`（T42 / 评审 I1）。
 */
export const DELETE_SNAPSHOT_MAX_BYTES = MAX_TEXT_BYTES

/**
 * 能**完整交付**给调用方的备份字节上限 = 允许删除的上限（T42 / 评审 I1）。
 *
 * ## 为什么删除的上限现在由"交付能力"决定，而不是由"读取能力"决定
 *
 * 契约 §6.2.4 ③ 要的是**恢复材料**。旧实现里 >1 MiB 的文本只回 `sha256` + 长度，
 * 非 UTF-8 只回 `sha256` + 长度 —— 然后**照样删**。那等于没有恢复材料：`sha256` 证明
 * "是这份字节"，但**恢复不出**这份字节。评审 I1 已明确这条路不行。
 *
 * 所以现在的判据是：**在人工确认之前**先问"这份字节我能不能整份交出去？"
 *   - 能（UTF-8 无损 → 回 `text`；非 UTF-8 → 回 `base64`）→ 带上，然后才允许确认与删除；
 *   - 不能（超过本上限）→ **拒绝删除**并说明（`-32603 reason:'backup-undeliverable'`）。
 * 没有第三条路："读过就算交过"不成立。
 *
 * ## 为什么是 1 MiB / 为什么非 UTF-8 走 base64
 *
 * - 1 MiB 的**原始字节**，UTF-8 文本形态最多 ~1 MiB 正文，二进制走 base64 约 1.37 MiB
 *   字符串。加上 JSON/ndjson 分帧与响应外壳，单次响应稳定落在 ~1.5 MiB 以内 ——
 *   这是"能真的过线路、也能被人/模型完整收下"的量级。
 * - 再往上（哪怕 8 MiB 快照上限还能读）就不是"交付"而是"塞爆消费者"：一个 8 MiB
 *   二进制 → 10.7 MiB base64 → 还得进模型上下文。**能读**不等于**能交付**，而删除
 *   只允许发生在"能交付"之后。
 * - base64 是唯一能无损过 JSON 字符串的形态（`toString('base64')` 往返逐字节相等，
 *   测试里直接 `Buffer.from(base64,'base64')` 重算 sha256 自证）。
 */
export const DELETE_BACKUP_MAX_BYTES = 1024 * 1024

/**
 * 人工确认的默认超时（毫秒）。契约 §7 #5 的"独立长超时"：
 * 确认走的是**人**，不能沿用请求级 30s 超时（人会离开工位，30s 太短会误伤正常操作）。
 * 可被 `createCapabilities({deleteConfirmTimeoutMs})` / 扩展配置覆盖。
 */
export const DEFAULT_DELETE_CONFIRM_TIMEOUT_MS = 120_000

/** `Promise.race` 里用来区分"超时"与"人的回答"的哨兵（不是任何合法回答）。 */
const CONFIRM_TIMED_OUT = Symbol('delete-confirm-timeout')

/** 人明确点了"删除"这个按钮 —— 也是哨兵，避免把宿主的任意真值当同意。 */
const CONFIRM_ACCEPTED = Symbol('delete-confirm-accepted')

/**
 * 整份字节的身份（`sha256` + 长度）。**只用于比对**，不是恢复材料。
 *
 * 评审 I1 的教训写在这里以防又被当成材料用：`sha256` 只能回答"是不是同一份字节"，
 * 它**恢复不出**任何字节。凡是要进 `result.snapshot` 的地方都必须用
 * `buildSnapshot`（带完整载荷），不能用本函数的返回值冒充。
 *
 * @param {Buffer} buffer
 * @returns {{sha256:string, byteLength:number}}
 */
function digestOf(buffer) {
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    byteLength: buffer.length,
  }
}

/**
 * 把整份字节做成"删掉的到底是什么"的材料（契约 §6.2.4 ③）——
 * **必须是可恢复的完整字节，否则不许删**（T42 / 评审 I1）。
 *
 * 交付形态只有两种，都是逐字节可逆的：
 *   - `encoding:'utf8'`：`text` = 整份正文（UTF-8 往返无损时才走这条）；
 *   - `encoding:'binary'`：`base64` = 整份字节的 base64。
 * 拿 `toString('utf8')` 的结果冒充二进制"正文"会让恢复出来的是替换字符 —— 比不给更坏，
 * 所以非 UTF-8 一律走 base64，不做替换字符工程。
 *
 * 超过 `DELETE_BACKUP_MAX_BYTES` → **直接拒绝删除**（`-32603 reason:'backup-undeliverable'`）。
 * 从前这里回 `textOmitted:'too-large'` 然后照样删，那正是评审 I1 判定的"没有恢复材料"。
 *
 * @param {Buffer} buffer 整份字节
 * @param {{method:string, file:string}} ctx 只用于错误体（调用方已经知道自己在删哪个文件）
 * @returns {{sha256:string, byteLength:number, encoding:'utf8'|'binary',
 *   textLength?:number, text?:string, base64?:string}}
 */
function buildSnapshot(buffer, ctx) {
  const { sha256, byteLength } = digestOf(buffer)
  if (byteLength > DELETE_BACKUP_MAX_BYTES) {
    // 交付不了整份字节 ⇒ 没有恢复材料 ⇒ 不许删。**不**退化成"只给 sha256"。
    throw new BridgeError(ERR.INTERNAL,
      `${ctx.file} is ${byteLength} bytes, over the ${DELETE_BACKUP_MAX_BYTES}-byte `
      + 'recoverable-backup limit; nothing was deleted — a sha256 is not recovery material, '
      + 'so this delete would have no way back',
      {
        method: ctx.method,
        file: ctx.file,
        reason: 'backup-undeliverable',
        why: 'too-large',
        byteLength,
        maxBytes: DELETE_BACKUP_MAX_BYTES,
        backup: { delivered: false, reason: 'too-large' },
        mayHaveApplied: false,
      })
  }
  const text = buffer.toString('utf8')
  const lossless = Buffer.from(text, 'utf8').equals(buffer)
  if (!lossless) {
    // 二进制：整份 base64（逐字节可逆）。绝不给"看起来像正文"的替换字符版本。
    return { sha256, byteLength, encoding: 'binary', base64: buffer.toString('base64') }
  }
  return { sha256, byteLength, encoding: 'utf8', textLength: text.length, text }
}

/**
 * 隔离目录名：工作区根下的 `.dsh-quarantine/`（T44）。
 *
 * ## 为什么不再用"同目录 + 随机名"
 *
 * T42 的隔离名是 `<同目录>/<原名>.dsh-deleting-<16 位十六进制>`，理由是"同目录必然同卷"。
 * T44 把这条能力的语义从"删"改成"**移入隔离区，永不删**"之后，那个理由的重心变了：
 * 跨卷 rename 失败**不再损失任何字节**（原件原地不动），于是"必须同卷"不再是数据安全的
 * 必要条件；而"隔离体集中在一个可列举、可解释、不会被目录监听/构建工具/glob 扫到的地方"
 * 变成了新要求 —— 挨着源文件的怪名字会被 watcher、`git status`、`glob('**\/*')` 捡进去。
 *
 * ## 跨卷怎么办
 *
 * 工作区根与源文件同卷是绝大多数情形（单根工作区，`resolveWorkspaceFile` 已把越界路径
 * 拒掉）。真跨卷（junction / subst / 网络盘）时 rename 抛 `EXDEV`：**直接失败并报
 * `-32603 reason:'quarantine-failed'`，原件原地不动** —— 绝不许退化成
 * `copyFile + unlink`，那只是"删"的另一种写法，正是 T44 要消灭的东西。
 */
export const QUARANTINE_DIR_NAME = '.dsh-quarantine'

/** UTC 时间戳 `yyyyMMdd-HHmmss`：文件名排序即时间顺序，且与本地时区/夏令时无关。 */
function utcStampOf(now = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`
    + `-${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`
}

/**
 * 按 `dir` 自己的分隔符拼子路径（不引 `node:path`：`C:\a` / `C:/a` / 末尾带分隔符都认）。
 * 隔离目录必须与工作区根同卷，所以分隔符必须跟根走，不能混。
 */
function joinUnder(dir, name) {
  const trimmed = String(dir).replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const sep = cut >= 0 && trimmed[cut] === '\\' ? '\\' : '/'
  return `${trimmed}${sep}${name}`
}

/** `<root>/.dsh-quarantine` */
function quarantineDirFor(rootAbs) {
  return joinUnder(rootAbs, QUARANTINE_DIR_NAME)
}

/**
 * 挑一个**此刻不存在**的隔离路径：
 * `<root>/.dsh-quarantine/<UTC yyyyMMdd-HHmmss>-<原名>`。
 *
 * 同名冲突（同一秒内第二次归档同名文件、或之前归档过同名的）→ 追加 `-<8 位十六进制>`，
 * 仍然"先探再用"，探满 8 次都不空就报 `quarantine-name-collision`（宁可失败，不覆盖）。
 *
 * ⚠️ 名字**不承担**任何身份绑定职责（评审 B1-a 明确否掉了"随机名/复算 hash = 绑定"这条路）。
 * 绑定由 `readFileIdentity` 的 `(dev, ino)` 承担；这里只解决"不许覆盖已存在的文件"。
 * rename 本身仍然 `overwrite:false` —— 探测与 rename 之间的竞争由宿主挡住。
 */
async function pickQuarantinePath(host, dir, realAbs, ctx) {
  const stamp = utcStampOf()
  const base = baseNameOf(realAbs)
  const plain = joinUnder(dir, `${stamp}-${base}`)
  if (!host.fileExists(plain)) return { path: plain, collided: false }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const salted = joinUnder(dir, `${stamp}-${base}-${randomBytes(4).toString('hex')}`)
    if (!host.fileExists(salted)) return { path: salted, collided: true }
  }
  throw new BridgeError(ERR.INTERNAL,
    `could not find a free name for ${base} in the quarantine directory; nothing was moved`,
    {
      method: ctx.method,
      file: ctx.file,
      reason: 'quarantine-name-collision',
      quarantineDir: canonicalPath(dir),
      mayHaveApplied: false,
      retryable: true,
    })
}

/**
 * 文件**对象身份** = `(dev, ino)`（宿主 `readFileIdentity` 注入）。
 *
 * ## 为什么是身份，而不是"再算一次 hash"（评审 B1-a）
 *
 * 评审否掉的正是"再算一次 hash 就算绑定"：hash 只能回答"这两个**名字**下的字节相同吗"，
 * 而 B1 的两条实证（open-writer 写句柄、provider 消费窗口）换掉的是**对象**，
 * 复算 hash 根本看不见。`(dev, ino)` 回答的是"这是不是**同一个 inode**"：
 *   - `rename` 不改 `dev/ino`（只改目录项），所以"我移走的那个对象"必须与"预检时那个对象"
 *     是同一对 `(dev, ino)`；
 *   - 把原件挪走、拿**同字节**的另一份顶名，`(dev, ino)` 必然变 —— 那是另一个对象，
 *     即便字节完全相同也必须拒（人批准的是那个 inode，不是那段字节）。
 *
 * 取不到（文件已消失）返回 `null`：调用方据此判断"对象不在了"，**不许**把 null 当"一致"。
 */
async function readFileIdentityOf(host, abs) {
  const raw = await host.readFileIdentity(abs)
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || raw.dev === undefined || raw.ino === undefined) {
    throw new BridgeError(ERR.INTERNAL,
      'host.readFileIdentity must return {dev, ino} or null', { reason: 'host-contract' })
  }
  return { dev: String(raw.dev), ino: String(raw.ino) }
}

function sameFileObject(before, after) {
  return before !== null && after !== null
    && before.dev === after.dev && before.ino === after.ino
}

/**
 * 移动完成后在**隔离体当前位置**重新测量 sha256 / 字节数。
 *
 * 诚实性要求（T44）：返回值里的 `quarantinedSha256` 必须来自这里，绝不复用确认时那份 ——
 * 归档之后隔离体仍可能被就地改写（open-writer 的 fd 写、provider 消费窗口），
 * 复用旧值就是"报成功却隐瞒差异"。
 *
 * 读不动（超过 `DELETE_BACKUP_MAX_BYTES` / 权限 / 已消失）→ `-32603
 * reason:'quarantine-unreadable'`，错误体带隔离体的**真实路径**：字节没被删，
 * 只是我们测不了它。
 */
async function measureQuarantined(read, abs, { method, file, quarantine }) {
  // `read` 是调用方的整份字节读（`readSnapshotBytes`），而不是这里的 `host.readFileBytes`
  // 直连：两份实现分头写必然漂移（同一个 `backup-undeliverable` 判据会有两个版本）。
  try {
    return digestOf(await read(abs))
  } catch (err) {
    throw new BridgeError(ERR.INTERNAL,
      `the file was moved to ${quarantine.path} but could not be re-measured `
      + `(${err?.message ?? err}); nothing was deleted — the bytes are still there`,
      {
        method,
        file,
        reason: 'quarantine-unreadable',
        quarantine,
        measureReason: err?.data?.reason ?? null,
        mayHaveApplied: false,
        retryable: true,
      })
  }
}

/** 隔离文件此刻在哪 —— 错误体/返回体共用的一种说法，避免各处自行编。 */
function quarantineInfo(quarantineAbs, originalAbs) {
  return {
    path: canonicalPath(quarantineAbs),
    original: canonicalPath(originalAbs),
    restored: false,
    retained: true,
  }
}

/**
 * 验证没过时把隔离文件放回原名 —— **绝不再删**（T42 / 评审 B1 第 3 条）。
 *
 * `host.fileExists` 先查原名：POSIX 的 `rename` 会**静默覆盖**已存在的目标，
 * 拿"拒绝删错文件"的机会去顶掉另一份文件是反向的数据丢失。Windows 上 rename 到
 * 已存在目标会失败，但依赖平台差异不是一回事 —— 判据写在代码里。
 *
 * 回不去（原名被占 / rename 又失败）→ **保留隔离文件**并把它的真实路径交出去：
 * 字节还在，只是名字难看。这比"为了把名字弄回原样而删掉它"安全得多。
 *
 * @returns {Promise<{path:string, original:string, restored:boolean, retained:boolean,
 *   reason:string|null}>}
 */
async function restoreQuarantined(host, quarantineAbs, originalAbs) {
  if (host.fileExists(originalAbs)) {
    return { ...quarantineInfo(quarantineAbs, originalAbs), reason: 'original-occupied' }
  }
  try {
    await host.quarantineRename(quarantineAbs, originalAbs)
    return {
      path: canonicalPath(originalAbs),
      original: canonicalPath(originalAbs),
      restored: true,
      retained: false,
      reason: null,
    }
  } catch {
    return { ...quarantineInfo(quarantineAbs, originalAbs), reason: 'rename-back-failed' }
  }
}

/** `C:\a\b.txt` → `b.txt`（只用于给人看的确认文案，不参与任何判定）。 */
function baseNameOf(p) {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return cut === -1 ? p : p.slice(cut + 1)
}

/** 二进制文件的扩展名黑名单：这些用普通文本编辑器打开会报 "File seems to be binary"（issue #33 教训）。 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
  'pdf', 'zip', 'gz', 'tar', '7z', 'rar',
  'mp3', 'wav', 'mp4', 'webm', 'mov', 'avi',
  'exe', 'dll', 'so', 'dylib', 'bin', 'node', 'wasm',
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
])

/** 1-based → 0-based（并夹到合法范围，避免 VSCode 抛 "Illegal argument"）。 */
function toZeroBased(n, fallback) {
  if (!Number.isInteger(n) || n < 1) return fallback
  return n - 1
}

/**
 * 1-based → 0-based 的**唯一一次**转换（铁律 6）。
 *
 * 入口（`params.range`）永远是 1-based，交给 host 的永远是 0-based，中间不许出现
 * 第二次减法：`line 1` 再减一次就是 `-1`，`vscode.Range` 会当场抛 "Illegal argument"，
 * 而更糟的形态是"不抛但整体错一行"——写入到错误的位置还报成功。
 * 所以转换只写在这里，且**只被调用一次**（见 applyEdit）。
 */
export function toApiRange(range) {
  return {
    start: { line: range.start.line - 1, column: range.start.column - 1 },
    end: { line: range.end.line - 1, column: range.end.column - 1 },
  }
}

/** 读一个 1-based 位置；非法就 -32602（范围校验属于参数校验，不是业务判断）。 */
function readPosition(pos, label, method) {
  if (!pos || typeof pos !== 'object' || Array.isArray(pos)) {
    throw new BridgeError(ERR.INVALID_PARAMS, `params.range.${label} must be an object`,
      { method })
  }
  const { line, column } = pos
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      `params.range.${label}.line/column must be integers >= 1 (1-based)`,
      { method, got: { line: typeof line, column: typeof column } })
  }
  return { line, column }
}

/** 读整个 range：两端都要合法，且 start 不得在 end 之后（否则是"反向选区"）。 */
function readRange(range, method) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new BridgeError(ERR.INVALID_PARAMS, 'params.range must be an object', { method })
  }
  const start = readPosition(range.start, 'start', method)
  const end = readPosition(range.end, 'end', method)
  const after = start.line > end.line
    || (start.line === end.line && start.column > end.column)
  if (after) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.range.start must not be after params.range.end',
      { method, start, end })
  }
  return { start, end }
}

/**
 * 读目标文档的形状（行数 + 关心的那几行的行长），**从文档而不是磁盘**读：
 * 缓冲区可能有未落盘的改动，按磁盘算行数会把合法范围判成越界（反之也会）。
 *
 * 宿主太老/替身没实现 → **失败闭合**（评审 F8）：宁可拒绝，也不把没校验过的范围
 * 交给 `vscode.Range` —— 宿主会自己 clamp，于是「写到第 999 行」静默变成
 * 「写到文件末尾」并且报 `applied:true`，这是最坏的一种假成功。
 *
 * @param {object} host
 * @param {string} abs    已通过路径守卫的真实路径
 * @param {number[]} lines 关心的 1-based 行号（按给定顺序回行长）
 * @param {string} method
 * @returns {Promise<{lineCount: number, lineLengths: Array<number|null>}>}
 */
async function readDocumentShape(host, abs, lines, method) {
  if (typeof host.readDocumentShape !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readDocumentShape; refusing to apply an unbounded range',
      { method, hostField: 'readDocumentShape' })
  }
  let shape
  try {
    shape = await host.readDocumentShape(abs, lines)
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
    }
    throw new BridgeError(ERR.INTERNAL,
      `cannot read document shape for ${abs}: ${err?.message ?? err}`, { method, path: abs })
  }
  if (!shape || !Number.isInteger(shape.lineCount) || shape.lineCount < 1) {
    throw new BridgeError(ERR.INTERNAL,
      `host returned an invalid document shape for ${abs}`, { method, path: abs })
  }
  // ★ 评审 R2-3：不许把「宿主给的形状不对」悄悄折成 `[]`。
  //   第一版写的是 `Array.isArray(shape.lineLengths) ? shape.lineLengths : []`，
  //   于是 `lineLengths` 缺失 / 拼错名 / 给了个字符串时，它变成空数组，而空数组在
  //   下面的边界检查里表现成"这个文档没有行长信息" —— 检查被**静默跳过**，
  //   越行的写入照样交给宿主（宿主会 clamp 到行尾，等于替调用方改内容）。
  //   形状错误是内部故障，不是"信息不足"：直接 -32603，一个字节都不交给写宿主。
  //   ★ 判序也在这里：整条 `lineLengths` 是否数组**留到 assertRangeInBounds 里判** ——
  //   那里先看 end.line 有没有越过文档，才轮到"行长能不能用"。否则"行数越界"这个
  //   调用方能自证的 -32602 会被形状问题抢先，判序就和契约反了（R2-3 明文要求：
  //   越行号仍先报 `-32602 range-beyond-document`）。
  return { lineCount: shape.lineCount, lineLengths: shape.lineLengths }
}

/**
 * 范围边界检查（评审 F8、R2-3）。
 *
 * 只给出 1-based 范围，不给出「文档有多大」时，「越界」是**调用方可以自证**的错误，
 * 所以报 -32602（参数错），并且**一个字节都不交给宿主**。
 *
 * ★ R2-3：结构错误（形状不对）与越界错误（数字超了）是两类事，判序也是契约的一部分：
 *  - 行数越界仍旧先报（`-32602 range-beyond-document`）：调用方给的 end.line 超了文档，
 *    这是可自证的参数错，哪怕行长信息也缺着，说"行数越界"比说"内部故障"更有用。
 *  - 之后**行长必须齐全且合法**（两个端点都在、都是非负整数）。缺一个、给了 `null`、
 *    负数、`NaN`、非数字 → `-32603`，**不调用** `applyEditText`。
 *    第一版那行 `if (!Number.isInteger(len)) continue` 就是 R2-3 的病根：
 *    "不知道多长"被当成"没有上界"，于是检查放过、写入交出去、宿主把行尾 clamp 一下
 *    就当成功了 —— 用户看到的报错是"成功"，文件里多了一截他不知道的内容。
 */
function assertRangeInBounds(shape, range, method) {
  const { lineCount, lineLengths } = shape
  if (range.end.line > lineCount) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      `params.range.end.line ${range.end.line} is beyond the document (${lineCount} lines)`,
      { method, reason: 'range-beyond-document', lineCount, end: range.end })
  }
  const ends = [range.start, range.end]
  // 行长必须**先存在**：缺失 / 不是数组 = 宿主形状错误（内部故障），
  // 不是"这个文档没有上界"。放在越行号之后，是为了让可自证的参数错先说话。
  if (!Array.isArray(lineLengths)) {
    throw new BridgeError(ERR.INTERNAL,
      'host returned a document shape without a usable lineLengths array; '
      + 'refusing to apply an unverified range',
      {
        method,
        reason: 'line-length-unavailable',
        hostField: 'lineLengths',
        got: typeof lineLengths,
      })
  }
  for (let i = 0; i < ends.length; i++) {
    const pos = ends[i]
    const len = lineLengths[i]
    // 上界检查必须有上界可用。缺失 ≠ 无上界。
    if (!Number.isInteger(len) || len < 0) {
      throw new BridgeError(ERR.INTERNAL,
        `document shape has no usable length for range endpoint line ${pos.line} `
        + `(got ${String(len)}); refusing to apply an unchecked range`,
        {
          method,
          reason: 'line-length-unavailable',
          line: pos.line,
          endpoint: i === 0 ? 'start' : 'end',
          got: typeof len === 'number' && Number.isNaN(len) ? 'NaN' : typeof len === 'number' ? len : typeof len,
        })
    }
    // 1-based column → 0-based 偏移；超出行长会被宿主 clamp 成"行尾"。
    if (pos.column - 1 > len) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        `params.range line ${pos.line} column ${pos.column} is beyond the line (${len} chars)`,
        { method, reason: 'range-beyond-line', line: pos.line, lineLength: len, column: pos.column })
    }
  }
}

// 出口路径规范化的实现已搬到 `dsh-vscode-kit/src/paths.js`（T60），与事件过滤 / payload / 注册表键
// 共用同一个 `canonicalPath`。用法不变：所有**对外可见**的路径（返回值、错误 data 里的 `file`）必须过它。

/**
 * 串行化键（**锁身份**）：只给 `serializeByPath` 用，不参与任何对外输出。
 *
 * 为什么不能直接用 `canonicalPath(real)`（T33 / 评审 T31 第二轮 I1 的实证）：
 * `realpath` 会展开链接、8.3 短名、`\\?\` 前缀，但**不统一段名大小写** —— 真机
 * （Node v24 / Windows）上 `D:\ws\a.txt` 与 `D:\WS\A.TXT` 是**同一个文件**（同为
 * dev+ino），`realpath` 却分别原样返回调用方拼的大小写。于是两条写请求落在两条 promise
 * 链上、并发通过前置版本检查、双双摸到写宿主：队列被别名绕过（事务 CAS 只保住了"至多
 * 一次落点"，没有保住"一次只有一个在读版本"）。锁键必须是**文件身份**，不是"一个看起来
 * 规范过的字符串"。
 *
 * 归一策略**按平台**，不许无条件折小写：
 *  - `win32`：整体 `toLowerCase()`。NTFS 默认不区分大小写，`a.txt` / `A.TXT` 本来就是
 *    同一个文件 —— 不折就必然出现两条链，那是本函数的全部理由。
 *  - 其它平台：**原样返回**。Linux 的 ext4/xfs **区分**大小写，`a.txt` 与 `A.TXT` 是两个
 *    不同的文件：无条件下折会把两个本来**可以并行写**的文件塞进同一条链（把并行误伤成
 *    串行），归属判定还可能与事务层不一致。macOS 默认卷不区分大小写但保留大小写，这里
 *    也按"其它平台"处理 —— 宁可少归并（两条链写两个不同文件，事务 CAS 照样挡住双成功），
 *    不要错归并。
 *
 * 其余别名形态**到不了这张表**，所以这里不做猜测式归一（T33 实测，见报告）：
 *  - 符号链接 / junction：路径守卫逐段 lstat，链上有链接直接 `-32602`（`reason:'symlink'`）。
 *  - 8.3 短名：**实测 `realpath` 并不展开**（`T33SHO~1\a.txt` 原样返回），但短名写法在守卫的
 *    "在根之内 + 逐段同名"判定里被判 `-32602`（fail-closed），同样进不了锁。
 *  - `\\localhost\C$\...` 这类卷别名：守卫判 `outside-workspace` 拒写。
 *  - `\\?\` 长路径前缀：上游 `stripLongPrefix` 已剥；相对路径与 `..`：`path.resolve` 已消。
 * 所以**唯一会以两种字符串指向同一文件、且两种字符串都能进锁**的形态，就是段名大小写 ——
 * 也就是本函数要折的那一件。
 */
function serializeKeyFor(real) {
  // 实现是 kit 的 `pathIdentityKey`（T60：身份口径也只留一份，与 `canonicalPath` 同文件不同名）。
  return pathIdentityKey(real)
}

// ─────────────────────────────────────────────────────────────────────────────
// 写入锚点（T30）：`expectedVersion` / `expectedRangeText` / 文档状态
//
// 为什么需要它（T4 的 NO-GO 根因）：写入请求原本只有「路径 + 坐标 + 文本」，而坐标是
// **调用方自己记的视图**。中间只要有人（用户、另一个插件、格式化）改过缓冲区，同一组
// 坐标就指向了别的内容 —— 宿主会老老实实按坐标替换，人工改动无声消失，`applied` 还是
// `true`。版本号是编辑器自己维护的单调计数器（`TextDocument.version`），它是「我基于
// 哪一刻的内容写了这组坐标」唯一能被机制证明的锚点。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读并校验 `params.expectedVersion`（**必填**）。
 *
 * 必填的理由：可选的锚点等于没有锚点 —— 调用方（尤其在上下文里丢过字段的模型）会
 * 一直走"不带版本"的路径，而那正是 T4 判 NO-GO 的那条路径。宁可让它在这里报一个
 * 说得清的参数错，也不许它拿到一个"看起来成功了"的静默覆盖。
 *
 * `data.reason` 把四种坏输入分开（缺 / 不是数字 / 不是整数 / 负数），只回类型与原因，
 * **不回显值**（与 response-contract.js 的口径一致：错误 data 里不放对端数据）。
 *
 * @returns {number} 合法的 0-based 整数版本号
 * @throws {BridgeError} -32602
 */
function readExpectedVersion(params, method) {
  const v = params?.expectedVersion
  const reason = v === undefined ? 'expected-version-missing'
    : typeof v !== 'number' ? 'expected-version-not-a-number'
      : !Number.isInteger(v) ? 'expected-version-not-an-integer'
        : v < 0 ? 'expected-version-negative'
          : null
  if (reason) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.expectedVersion is required and must be an integer >= 0; '
      + 'read it from vscode.getDocumentState.version and pass it back unchanged',
      { method, reason, got: { type: typeof v } })
  }
  return v
}

/**
 * 读并校验可选的 `params.expectedRangeText`。
 *
 * 给 `undefined` = 不做内容比对（版本仍然必填）。给了别的类型就是参数错 ——
 * 不许"当成没给"静默降级，那等于让一个拼错的字段名把内容比对悄悄关掉。
 */
function readExpectedRangeText(params, method) {
  const v = params?.expectedRangeText
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.expectedRangeText must be a string when provided',
      { method, reason: 'expected-range-text-not-a-string', got: { type: typeof v } })
  }
  return v
}

/**
 * 读并校验**必填**的 `params.expectedIncarnation`（T34 引入；**T35 收紧为无条件必填**）。
 *
 * ## ★ 这是**有意的不兼容收紧**，不是回归
 *
 * T34 时这里写成"可选"（给了才判），理由是"扩展侧不知道调用方是哪个 DSH 版本，老版本不传
 * 这个字段，写入仍应按版本锚点工作（向后兼容）"。T6 终审推翻了那个理由，证据见
 * `work/评审-T6-终审放行.md` §2（H1）：两个窗口的**版本数字相同时**（A=v7/inc-A，
 * B=v7/inc-B），一条**省略** `expectedIncarnation` 的 `vscode.applyEdit` 被两道门
 * （本能力的早失败 + 事务内比较）一起放过，按 B 的视图覆盖了授权窗口 A 中的人工内容，
 * 仍返回 `applied:true`。也就是说"可选"不是兼容，是**留了一条把判据整体关掉的公开路径**。
 *
 * 因此：**不再有"不带化身的写"**。理由只有一句 —— 没有化身身份就**无法证明**写的是
 * 同一个文档实例；版本号是每个实例各自计数的、关闭重开后会复用，它证明不了这件事。
 *
 * 代价是明确的、被接受的：**旧版扩展/旧调用方（不返回、不传 `incarnation`）从此不能被写**
 * （`-32602` / `reason:'expected-incarnation-missing'`）。这不是"断线式"退化，而是把
 * "做不到唯一保证的写"明确**降级为拒写** —— 静默放行一条拿不到保证的自动编辑，
 * 比拒写危险得多。
 *
 * 形状：空串/非字符串同样参数错 —— 空串会让"宿主读不到化身"与"调用方给了空串"
 * 互相匹配成功，那等于把这道门重新关掉。
 *
 * @returns {string} 非空化身字符串
 * @throws {BridgeError} -32602（`reason:'expected-incarnation-missing'` /
 *   `'expected-incarnation-not-a-non-empty-string'`）
 */
function readExpectedIncarnation(params, method) {
  const v = params?.expectedIncarnation
  if (typeof v === 'string' && v !== '') return v
  const reason = v === undefined
    ? 'expected-incarnation-missing'
    : 'expected-incarnation-not-a-non-empty-string'
  throw new BridgeError(ERR.INVALID_PARAMS,
    'vscode.applyEdit requires the document-instance anchor: params.expectedIncarnation must be a '
    + 'non-empty string (take it from vscode.getDocumentState.incarnation and pass it back '
    + 'unchanged). A version number alone cannot prove "the same document instance" — it is '
    + 'reused when a document is reopened — so writes without an incarnation are refused.',
    { method, reason, got: { type: typeof v } })
}

/**
 * 化身锚点判定（T34）—— 与 `assertVersionMatches` 并排的**同一道门**的第二半。
 *
 * 版本证明"内容没被改过"，化身证明"还是那一份文档"。两者都必要：
 * 关掉重开后新实例又从版本 1 开始数，只有化身能把"旧视角的坐标"与"新实例"分开。
 *
 * 报错码与版本冲突**共用** `-32012`（处置一样：重读、重发、不许拿旧锚点重试），
 * 用 `data.reason='incarnation-mismatch'` 区分是哪一半过期了。
 */
function assertIncarnationMatches(actual, expected, file, method) {
  if (actual === expected) return
  throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
    'the document instance is not the one this request was prepared against '
    + `(incarnation ${typeof actual === 'string' ? actual : 'unknown'}, expected ${expected}); `
    + 're-read vscode.getDocumentState and re-apply against the current document instance',
    { method, file, reason: 'incarnation-mismatch', expected, actual: typeof actual === 'string' ? actual : null })
}

/**
 * 读并校验**必填**的 `params.expectedDisk`（T39 / 契约 §6.2.3）。
 *
 * 形状固定为 `{mtime, size}`，两个字段都是**非负整数**：
 *  - `mtime` = 毫秒时间戳（`stat.mtimeMs` 取整）。用整数而不是 Date/ISO 串，是因为它要
 *    走 JSON、还要**逐字等值比较**；浮点毫秒在序列化/解析后可能差一个 ULP，那种"永远
 *    差一点点"的锚点等于永远冲突（而且看起来像磁盘一直在变）。
 *  - `size` = 字节数。
 *
 * 缺字段 / 类型不对 / 负数 → `-32602`（调用方自己的参数错误，**宿主零调用**），
 * 不许"当成没给"静默降级 —— 那等于让一个拼错的字段名把磁盘锚点整道关掉。
 *
 * @returns {{mtime: number, size: number}}
 * @throws {BridgeError} -32602
 */
function readExpectedDisk(params, method) {
  const v = params?.expectedDisk
  if (v === undefined) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'vscode.save requires the disk anchor: params.expectedDisk = {mtime, size} '
      + '(read it from vscode.readDiskStat and pass it back unchanged)',
      { method, reason: 'expected-disk-missing', got: { type: 'undefined' } })
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.expectedDisk must be an object {mtime, size}',
      { method, reason: 'expected-disk-not-an-object', got: { type: typeof v } })
  }
  for (const key of ['mtime', 'size']) {
    const n = v[key]
    if (typeof n !== 'number') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        `params.expectedDisk.${key} must be a number`,
        { method, reason: `expected-disk-${key}-not-a-number`, got: { type: typeof n } })
    }
    if (!Number.isInteger(n) || n < 0) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        `params.expectedDisk.${key} must be an integer >= 0`,
        { method, reason: `expected-disk-${key}-not-a-non-negative-integer`, got: { type: typeof n } })
    }
  }
  return { mtime: v.mtime, size: v.size }
}

/**
 * 读**磁盘**上的 `{mtime, size}`（T39 / 契约 §6.2.3 的 `readDiskStat`）。
 *
 * 这是 `vscode.save` 的磁盘锚点读侧：返回 `null` 表示磁盘上**没有这个文件**
 * （被删了 / 还没落过盘 / 宿主读不到）—— 调用方必须把它当成"锚点不可能匹配"，
 * 而不是"跳过判定"。
 *
 * @param {object} host
 * @param {string} abs
 * @param {string} method
 * @returns {Promise<{mtime: number, size: number}|null>}
 * @throws {BridgeError} -32603 宿主没实现 / 返回形状不对
 */
async function readDiskStatOf(host, abs, method) {
  if (typeof host.readDiskStat !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readDiskStat; refusing to save without a disk anchor',
      { method, hostField: 'readDiskStat' })
  }
  let stat
  try {
    stat = await host.readDiskStat(abs)
  } catch (err) {
    throw new BridgeError(ERR.INTERNAL,
      `cannot stat ${abs}: ${err?.message ?? err}`,
      { method, path: abs, reason: 'disk-stat-unavailable' })
  }
  if (stat === null || stat === undefined) return null
  if (!stat || typeof stat !== 'object' || Array.isArray(stat)
    || !Number.isInteger(stat.mtime) || stat.mtime < 0
    || !Number.isInteger(stat.size) || stat.size < 0) {
    throw new BridgeError(ERR.INTERNAL,
      `host returned an invalid disk stat for ${abs}`,
      { method, path: abs, fields: ['mtime', 'size'], reason: 'invalid-disk-stat' })
  }
  return { mtime: stat.mtime, size: stat.size }
}

/**
 * 磁盘锚点判定（契约 §6.2.3）—— **新码 `-32013`，永不复用 `-32012`**。
 *
 * 为什么必须是新码：`-32012` 的处置是"重读锚点、重发"；磁盘冲突**永远不能自动重试**
 * （本端不知道磁盘上那份内容是谁写的，重发就是拿没见过的内容换掉别人的改动）。
 * 复用同一个码 = 让两条处置相反的失败共用一套重试逻辑（§6.2.7 已写明）。
 *
 * `actual: null` = 磁盘上已经没这个文件（被删/被移走）—— 同样冲突，处置相同。
 *
 * @param {object} [opts] 措辞覆盖（**判定只有一处实现**，措辞按动作换）。`vscode.deleteFile`
 *   传 `{action:'delete'}` —— 删除没有"覆盖"这个出路，**绝不能**让调用方读到"要不要覆盖"，
 *   那会把人引向一个不存在的选项。
 */
function assertDiskMatches(actual, expected, file, method, opts = {}) {
  if (actual && actual.mtime === expected.mtime && actual.size === expected.size) return
  const action = opts.action ?? 'save'
  // 删除侧的诚实结论：**什么都没删**（本比对发生在 `workspace.fs.delete` 之前）。
  const outcome = opts.outcome ?? (action === 'delete' ? 'nothing was deleted' : 'nothing was saved')
  const advice = opts.advice ?? (action === 'delete'
    ? 're-read the file and decide deliberately whether it is still the file you mean to delete'
    : 're-read the file and decide deliberately whether to overwrite it')
  throw new BridgeError(ERR.DISK_STATE_CONFLICT,
    `the file on disk is not the one this ${action} was prepared against `
    + `(mtime/size ${actual ? `${actual.mtime}/${actual.size}` : 'absent'}, `
    + `expected ${expected.mtime}/${expected.size}); ${outcome} — ${advice}`,
    {
      method,
      file,
      // 只给锚点本身（mtime/size 是元数据，不是内容），对端要拿它判断"是不是我上次看到的那份"。
      expected: { ...expected },
      actual: actual ? { ...actual } : null,
      ...(opts.extra ?? {}),
    })
}


/**
 * 读**文档**状态（版本 / 脏标记 / 换行 / 行数 / 长度 / 可选全文）。
 *
 * 形状校验与 `readDocumentShape` 同一套理由（评审 R2-3）：宿主回的字段缺一个就说明
 * 这个适配器不可信，此时**失败闭合**（-32603），绝不许把 `undefined` 当版本号去比 ——
 * `undefined !== 5` 会让每次写入都报冲突，或者更糟：`undefined === undefined` 一路放行。
 *
 * @param {{includeText: boolean}} wanted
 * @returns {Promise<{version:number, incarnation?:string, isDirty:boolean, eol:'lf'|'crlf',
 *   lineCount:number, textLength:number, byteLength:number, text?:string}>}
 */
async function readDocumentState(host, abs, wanted, method) {
  if (typeof host.readDocumentState !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readDocumentState; refusing to write without a version anchor',
      { method, hostField: 'readDocumentState' })
  }
  let state
  try {
    state = await host.readDocumentState(abs, { includeText: wanted?.includeText === true })
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
    }
    throw new BridgeError(ERR.INTERNAL,
      `cannot read document state for ${abs}: ${err?.message ?? err}`, { method, path: abs })
  }
  const bad = []
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    bad.push('state')
  } else {
    if (!Number.isInteger(state.version) || state.version < 0) bad.push('version')
    if (typeof state.isDirty !== 'boolean') bad.push('isDirty')
    if (state.eol !== 'lf' && state.eol !== 'crlf') bad.push('eol')
    if (!Number.isInteger(state.lineCount) || state.lineCount < 1) bad.push('lineCount')
    if (!Number.isInteger(state.textLength) || state.textLength < 0) bad.push('textLength')
    if (!Number.isInteger(state.byteLength) || state.byteLength < 0) bad.push('byteLength')
    // ★ T34：`incarnation` 在**这个适配器版本上可选**（老宿主/测试替身没有），但"给了就要
    //   是形状对的字符串" —— 允许 `undefined`，绝不允许 `undefined` 一路被当成身份去比。
    //   空串同样拒：它会让"调用方给了空串"与"宿主没给"互相匹配成功。
    if (state.incarnation !== undefined
      && (typeof state.incarnation !== 'string' || state.incarnation === '')) {
      bad.push('incarnation')
    }
    // ★ T39：`untitled` 同样**可选**，但"给了就必须是布尔" —— 它决定 `vscode.save`
    //   要不要在动手前报 `untitled-document`；让 `undefined`/`'false'` 混进来，
    //   这个判据就会时灵时不灵。
    if (state.untitled !== undefined && typeof state.untitled !== 'boolean') {
      bad.push('untitled')
    }
  }
  if (bad.length > 0) {
    throw new BridgeError(ERR.INTERNAL,
      `host returned an invalid document state for ${abs} (bad fields: ${bad.join(', ')})`,
      { method, path: abs, fields: bad })
  }
  return state
}

/**
 * 版本锚点判定 —— 写前的**第一道实质门**（参数形状之后、范围之前）。
 *
 * 比的是等值，不是"小于/大于"：版本号只增不减，但"我的版本比它大"同样意味着中间
 * 发生过我不知道的改动（例如用户撤销）。任何不等都按冲突处理，`data` 里给三个数：
 * 文件、我以为的、实际的 —— 让调用方能立刻判断"重读一次再试"还是"放弃"。
 */
function assertVersionMatches(actual, expected, file, method) {
  if (actual === expected) return
  throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
    `document version is ${actual}, but the request was prepared for version ${expected}; `
    + 're-read vscode.getDocumentState and re-apply against the current version',
    { method, file, expected, actual })
}

/**
 * 读目标范围的**当前文本**，用于 `expectedRangeText` 逐字比对。
 *
 * 为什么还要这一道（版本已经保证了"中间没被改过"）：版本只能证明"文档没变"，
 * 证明不了"调用方记的那组坐标当时取的就是这两个字符"。坐标算错一位时版本照样匹配，
 * 而内容比对会当场发现 —— data 里带 `reason:'range-text-mismatch'`，处置与版本冲突一样。
 */
async function readTargetRangeText(host, abs, apiRange, method) {
  if (typeof host.readRangeText !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readRangeText; cannot verify params.expectedRangeText',
      { method, hostField: 'readRangeText' })
  }
  let actual
  try {
    actual = await host.readRangeText(abs, apiRange)
  } catch (err) {
    throw new BridgeError(ERR.INTERNAL,
      `cannot read range text for ${abs}: ${err?.message ?? err}`, { method, path: abs })
  }
  if (typeof actual !== 'string') {
    throw new BridgeError(ERR.INTERNAL,
      'host returned a non-string range text; refusing to compare',
      { method, path: abs, got: { type: typeof actual } })
  }
  return actual
}

/**
 * 创建能力实现集合。
 *
 * @param {object} host 注入的宿主能力，全部可替身：
 * @param {(p: string) => boolean}                    host.fileExists
 * @param {(p: string) => string}                     host.resolvePath   相对路径 → 绝对路径（锚工作区根）
 * @param {() => string[]}                            host.workspaceRoots
 * @param {() => boolean}                             host.isTrusted
 * @param {(p: string, opts) => Promise<void>}        host.openTextDocument 打开文本文件并定位
 * @param {(p: string) => Promise<void>}              host.openExternalFile  用系统方式打开二进制文件
 * @param {() => object|null}                         host.activeEditor  返回 {file, text, start, end} 或 null
 * @param {(abs: string|null) => Array<{file: string, diagnostics: Array<{severity:string,line:number,character:number,message:string,source?:string,code?:any}>}>} host.collectDiagnostics
 * @param {() => Array<{file: string, isActive?: boolean, isDirty?: boolean, languageId?: string}>} host.listEditors
 * @param {(abs: string, range: {start:{line:number,column:number}, end:{line:number,column:number}}, text: string, expectedVersion: number, expectedIncarnation?: string) => Promise<{applied: boolean, documentPath?: string|null, version?: number|null, incarnation?: string|null}>} [host.applyEditText]
 *        在**缓冲区**里替换一段文本（0-based range，已在校验层转过一次）。**不许保存**。
 *        **`expectedVersion` 必须由这一层在提交那一刻再判一次**（T32 / 评审 T31 的 B1）：
 *        适配器实现见 `edit-transaction.js` —— 在 `TextEditor.edit` 的**同步 callback** 里
 *        读 `document.version`、与 `expectedVersion` 比对，不等就**不构造任何 edit** 并报
 *        `-32012`（`data = { file, expected, actual }`，与前置检查同形）。
 *        只收一个"前置检查已通过"的布尔值是不够的：能力层到这一层之间隔着 await，
 *        人工编辑就发生在那几个让出点里（T31 实证 RACE_* 四行 `applied=true`）。
 *        `documentPath` 是**编辑器报告的文档身份**（VS Code 里即 `document.uri.fsPath`），
 *        必须由适配器提供：它是"写到底落在哪个文档"的唯一真值（评审 R3-1）。
 *        报不出来 → handler 失败闭合（`-32603 document-identity-unavailable`），不报成功。
 * @param {(abs: string, lines: number[]) => Promise<{lineCount: number, lineLengths?: Array<number|null>}>} [host.readDocumentShape]
 *        读**文档**（不是磁盘）的行数与指定 1-based 行的行长；用于范围边界检查（评审 F8）。
 *        缺失即失败闭合：没有它就证明不了范围合法，宁可拒也不交给宿主 clamp。
 * @param {(abs: string, opts: {includeText: boolean}) => Promise<{version: number, isDirty: boolean, eol: 'lf'|'crlf', lineCount: number, textLength: number, byteLength: number, text?: string}>} [host.readDocumentState]
 *        读**文档**（不是磁盘）的状态：`version` 是 VS Code 的 `TextDocument.version`
 *        （每次缓冲区被改动就 +1，**不是**磁盘 mtime、不是内容哈希）。
 *        `text` 只在 `includeText === true` 时给出（全集，绝不许是截断的一段）。
 *        缺失即失败闭合：没有它就没有写入锚点，写入一律拒（T30）。
 * @param {(abs: string, range: {start:{line:number,column:number}, end:{line:number,column:number}}) => Promise<string>} [host.readRangeText]
 *        读**文档**里 0-based range 的当前文本，用于 `expectedRangeText` 逐字比对（T30）。
 *        缺失即失败闭合（只在调用方给了 `expectedRangeText` 时才需要）。
 * @param {(msg: string) => void}                     [host.log]
 * @param {object} [opts]
 * @param {import('../../dsh-vscode-kit/src/grant.js').GrantStore} [opts.grants]
 *        会话授权表（与 connector 共用**同一个实例** —— 另建一份等于另立一套判定）。
 * @param {() => boolean} [opts.isTrusted]  工作区信任（判序在 grant 之前，评审 F7）
 * @param {(method, params, ctx) => void} [opts.grantGate] 自定义绑定门（测试用）
 */
export function createCapabilities(host, opts = {}) {
  const log = host.log ?? (() => {})
  const grants = opts.grants ?? null
  // 信任来源优先取调用方注入（connector 侧无 host），否则用宿主自己那份。
  const isTrusted = opts.isTrusted ?? (typeof host.isTrusted === 'function' ? host.isTrusted : null)

  /**
   * 人工确认的等待上限（§7 #5「独立长超时」）。配错值不 brick 扩展，回落默认值 ——
   * 但**只回落成更保守的那个**（默认 120s 比任何一个"短到会误伤真人"的值都长，
   * 也比任何一个"长到许可实质永久"的值都短）。
   */
  const deleteConfirmTimeoutMs = Number.isInteger(opts.deleteConfirmTimeoutMs)
    && opts.deleteConfirmTimeoutMs > 0
    ? opts.deleteConfirmTimeoutMs
    : DEFAULT_DELETE_CONFIRM_TIMEOUT_MS

  /**
   * 同文件写入串行化（T32 / 评审 T31-B1 建议 ③）：`规范化路径 → promise 链尾`。
   *
   * 解决的是**两个请求之间**的竞争（不是"请求与人之间"的竞争 —— 那个只能靠事务内判定）：
   * 两条同版本的重放在同一个文件上并发时，没有这条链，两个请求的前置检查会读到同一个
   * 旧版本、双双走到写宿主（事务内判定会把第二个拒掉，但"宿主零调用"的便宜就丢了，
   * 而且错误更晚才出现）。
   *
   * 键是**同一文件的稳定身份**（`resolveWorkspaceFile` 证明过的 realpath，再走
   * `serializeKeyFor` 按平台归一；Windows 折小写是因为 NTFS 不区分大小写，其它平台原样）：
   * 同一个文件的不同写法（相对/绝对、段名大小写、8.3 短名）落在同一条链上 —— 否则
   * "串行化"只对写法一致的那一半请求生效，等于没做（T33 实证：大写别名会让同文件进两条链）。
   * **不是全局锁**：不同文件各有一条链，互不排队（写入不同文件本来就该并行）。
   *
   * 释放靠 `tail`（永不 reject 的链尾）：任务失败也必须把锁让出去，否则一条出错的任务
   * 会让后面所有排队者永远挂着。`run` 才是给调用方的 promise —— 它照常带着错误和结果。
   */
  const writeChains = new Map()

  function serializeByPath(key, task) {
    const prev = writeChains.get(key) ?? Promise.resolve()
    const run = prev.then(() => task())
    // 链尾吞掉错误：链上任何一个任务失败都不许传染给排队者（它们各有各的判定）。
    const tail = run.then(() => {}, () => {})
    writeChains.set(key, tail)
    const release = () => { if (writeChains.get(key) === tail) writeChains.delete(key) }
    tail.then(release, release)
    return run
  }

  /**
   * 绑定门（契约 §6.1.1 ②）：**分派进 handler 之前**判一次。
   * 没注入授权表时 fail-closed —— 写入类一律 no-grant，读操作照旧（读不要求授权）。
   */
  const grantGate = opts.grantGate ?? (grants
    ? extensionWriteGate(grants, { isTrusted })
    : (method) => {
        if (isWriteMethod(method)) throw editNotBoundError(method, GRANT_REASONS.NO_GRANT, 1)
      })

  /** 所有能力共用的前置检查：工作区信任。 */
  function assertTrusted(method) {
    if (!host.isTrusted()) {
      throw new BridgeError(ERR.UNTRUSTED_WORKSPACE,
        'workspace is not trusted; refusing to expose editor capabilities', { method })
    }
  }

  /**
   * 事件订阅 broker（E3）—— **推流侧的登记簿与策略中心**。
   *
   * 它只做三件事，都不碰编辑器状态：
   *  ① **登记**：每个订阅记 `{id, link, filter, consumer}`；消费者名字是分区键。
   *  ② **开流**：一条连接一条流（`link.events.openStream`），回执冻结
   *     `{subscriptionId, streamEpoch, startSeq}` —— 这是消费方"只看这之后"的初态屏障。
   *  ③ **推策略**：`policyFor()` 把**所有**消费者合起来算一份联合策略
   *     （roots 取工作区根、types 取并集、files 取 delta 派生的白名单并集、
   *     `textMode = 任何人有 delta 才是 delta`），通过 `configure` 灌给 E2 生产者。
   *
   * 为什么联合而**不是**每条订阅一份生产者：E1 的传输层是"每条连接一条流"
   * （`protocol.js` 的 `eventChannel`，`openStream` 已有 outgoing 就返回 null），
   * 消费者级隔离在**接收侧**做（DSH 的 `createEventSubscriptions` 逐分区过滤+队列）。
   * 推侧只负责"别把不该发的正文发出去"：联合策略是**最宽的合法并集**，
   * 真正的逐消费者裁剪在接收侧 —— 两端都不许悄悄放宽。
   *
   * `roots` 传函数（不是快照）：工作区根会变（加/删文件夹），快照会让正文闸停在开局那一刻。
   */
  const eventBroker = createEventBroker({
    log: (level, msg, extra) => log(level, msg, extra),
    roots: () => (typeof host.workspaceRoots === 'function' ? host.workspaceRoots() : []),
    // ★ T60：订阅回执里的 `filterMatch` 就是靠这条读取的"此刻打开了哪些文件"。
    // 数据的**来源与 `vscode.listOpenEditors` 是同一个** `host.listEditors()`
    // （同一个宿主调用、同一套出口规范化），诊断里的数字才等于消费者真正看到的那份名单。
    // 读失败不影响订阅（`filterMatchFor` 自己吞异常并回 null），这条通道永不因诊断而拒服。
    openFiles: () => (typeof host.listEditors === 'function'
      ? host.listEditors().map((entry) => entry?.file).filter((file) => typeof file === 'string')
      : []),
    // 会话归属只认 grant 表（DSH 侧的授权事实），**不**采信订阅参数里自称的东西。
    sessionLinkOf: (sessionId) => {
      if (!grants || typeof grants.active !== 'function') return null
      let found = null
      for (const record of grants.active()) {
        if (record?.sessionId === sessionId) found = record
      }
      return found?.link ?? null
    },
  })

  /**
   * vscode.openFile
   * params: { path: string, line?: number(1-based), column?: number(1-based), preview?: boolean }
   * result: { opened: true, path: string, mode: 'text'|'external' }
   */
  async function openFile(params) {
    assertTrusted('vscode.openFile')
    const raw = params?.path
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.path must be a non-empty string',
        { method: 'vscode.openFile' })
    }

    const abs = host.resolvePath(raw)
    if (!host.fileExists(abs)) {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`,
        { method: 'vscode.openFile', path: abs })
    }

    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase()
    const line = toZeroBased(params?.line, 0)
    const column = toZeroBased(params?.column, 0)

    // 二进制文件交给系统默认程序：文本编辑器打开会抛 "File seems to be binary"。
    if (BINARY_EXT.has(ext)) {
      await host.openExternalFile(abs)
      log(`openFile: ${abs} opened externally (binary .${ext})`)
      return { opened: true, path: canonicalPath(abs), mode: 'external' }
    }

    await host.openTextDocument(abs, { line, column, preview: params?.preview === true })
    log(`openFile: ${abs} opened at ${line + 1}:${column + 1}`)
    return { opened: true, path: canonicalPath(abs), mode: 'text' }
  }

  /**
   * vscode.getSelection
   * params: {} （未来可加 format）
   * result: { text, file, start:{line,column}, end:{line,column}, isEmpty } —— line/column 为 1-based
   */
  async function getSelection() {
    assertTrusted('vscode.getSelection')
    const sel = host.activeEditor()
    if (!sel) {
      throw new BridgeError(ERR.NOT_FOUND, 'no active editor',
        { method: 'vscode.getSelection' })
    }
    return {
      text: sel.text,
      file: canonicalPath(sel.file),
      start: { line: sel.start.line + 1, column: sel.start.character + 1 },
      end: { line: sel.end.line + 1, column: sel.end.character + 1 },
      isEmpty: sel.isEmpty === true,
    }
  }

  /**
   * vscode.getDiagnostics
   * params: { path?: string, severity?: 'error'|'warning'|'info'|'hint', limit?: number }
   *   不给 path 就取工作区全部（只取有诊断的文件，避免遍历整个工作区）。
   * result: { total, files: [{file, diagnostics: [{severity, line, column, message, source, code}]}] }
   *   line/column 为 1-based；severity 用字符串而不是 VSCode 的数字枚举（跨进程契约不暴露第三方枚举）。
   * 用途：让 DSH 侧知道「我刚改的文件有没有编译错误」，这是编辑闭环里最常问的问题。
   */
  async function getDiagnostics(params) {
    assertTrusted('vscode.getDiagnostics')
    const severity = params?.severity
    const SEV = new Set(['error', 'warning', 'info', 'hint'])
    if (severity !== undefined && !SEV.has(severity)) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        `params.severity must be one of ${[...SEV].join('|')}`, { method: 'vscode.getDiagnostics' })
    }
    const limit = Number.isInteger(params?.limit) && params.limit > 0
      ? Math.min(params.limit, 500)
      : 200

    let target
    if (params?.path !== undefined) {
      if (typeof params.path !== 'string' || params.path.trim() === '') {
        throw new BridgeError(ERR.INVALID_PARAMS, 'params.path must be a non-empty string when given',
          { method: 'vscode.getDiagnostics' })
      }
      target = host.resolvePath(params.path)
      if (!host.fileExists(target)) {
        throw new BridgeError(ERR.NOT_FOUND, `file not found: ${target}`,
          { method: 'vscode.getDiagnostics', path: target })
      }
    }

    // host.collectDiagnostics 返回 [{file, diagnostics:[{severity:'error', line, character, message, source, code}]}]
    // line/character 已是 0-based；本层负责转 1-based 与过滤/截断。
    const raw = host.collectDiagnostics(target ?? null)
    const files = []
    let total = 0
    for (const entry of raw) {
      const picked = []
      for (const d of entry.diagnostics) {
        if (severity !== undefined && d.severity !== severity) continue
        picked.push({
          severity: d.severity,
          line: d.line + 1,
          column: d.character + 1,
          message: d.message,
          ...(d.source === undefined ? {} : { source: d.source }),
          ...(d.code === undefined ? {} : { code: d.code }),
        })
        if (total + picked.length >= limit) break
      }
      if (picked.length === 0) continue
      total += picked.length
      files.push({ file: canonicalPath(entry.file), diagnostics: picked })
      if (total >= limit) break
    }
    log(`getDiagnostics: ${total} diagnostic(s) in ${files.length} file(s)`)
    return { total, files, truncated: total >= limit }
  }

  /**
   * vscode.listOpenEditors
   * params: { limit?: number }
   * result: { editors: [{file, isActive, isDirty, languageId}], total }
   * 用途：让 DSH 侧知道用户眼下开着哪些文件，不用问人。
   */
  async function listOpenEditors(params) {
    assertTrusted('vscode.listOpenEditors')
    const limit = Number.isInteger(params?.limit) && params.limit > 0
      ? Math.min(params.limit, 200)
      : 50
    const all = host.listEditors()
    const editors = all.slice(0, limit).map((e) => ({
      file: canonicalPath(e.file),
      isActive: e.isActive === true,
      isDirty: e.isDirty === true,
      ...(e.languageId === undefined ? {} : { languageId: e.languageId }),
    }))
    return { editors, total: all.length, truncated: all.length > editors.length }
  }

  /**
   * vscode.getDocumentState —— 写入锚点的读侧（T30）。
   *
   * params: { file: string, includeText?: boolean }
   * result: { file, version, incarnation, isDirty, eol: 'lf'|'crlf', lineCount, textLength,
   *           textUnavailable?: true, text?: string }
   *
   * `incarnation`（T34）= 这份**文档实例**的不透明身份（`inc-<hex>`）。它补的是
   * `version` 的盲区：版本是每个实例自己的计数器，关掉重开后新实例又从 1 开始数。
   * 两者一起构成写入锚点：`{ version, incarnation }`。
   *
   * 为什么需要这条能力：`applyEdit` 的 `expectedVersion` 只能从对端读到的
   * `TextDocument.version` 来。没有读侧，写入锚点就成了"猜一个数字"。
   *
   * 三件事刻意不做：
   *  1. **不读磁盘**：`version` / `lineCount` / `text` 全部来自编辑器持有的文档
   *     （缓冲区可能已改未存，按磁盘读到的行数与用户眼前看到的不一致 —— 正是 T4 里
   *     「坐标漂移」的成因之一）。
   *  2. **不截断**：`includeText:true` 且文档超过 `MAX_TEXT_BYTES` 时**整份不给**，
   *     改回 `textUnavailable:true`。截断后当全文是最坏的形态（见 MAX_TEXT_BYTES 注释）。
   *  3. **不写、不保存、不开新窗口**：纯读，因此**不要求** grant（写入才要求）。
   */
  async function getDocumentState(params, ctx) {
    const method = 'vscode.getDocumentState'
    assertTrusted(method)

    const file = params?.file
    if (typeof file !== 'string' || file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
    }
    const rawInclude = params?.includeText
    if (rawInclude !== undefined && typeof rawInclude !== 'boolean') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'params.includeText must be a boolean when provided',
        { method, reason: 'include-text-not-a-boolean', got: { type: typeof rawInclude } })
    }
    const includeText = rawInclude === true

    // 路径守卫与 applyEdit **同一套**（拒链接、拒多根、必须在工作区内）：
    // 读的路径和写的路径必须是同一类证明，否则"读得到但写不了"或反之的错配就是新缺口。
    // 失败码与 openFile 同族：-32602（路径不合法）/ -32003（不存在）。
    const { abs, real } = resolveWorkspaceFile(file, host.workspaceRoots(), { method })

    const state = await readDocumentState(host, real, { includeText }, method)
    // 可选的流位置与订阅回执共用同一 cursor 结构；不自动开流。
    const cursor = eventBroker.cursorFor(ctx?.link)
    const out = {
      ...(cursor ? { cursor } : {}),
      // 与其它能力同一口径：回规范化绝对路径，不回调用方写的那一串。
      file: canonicalPath(abs),
      version: state.version,
      // ★ T34：版本之外再给一个**文档实例身份**。调用方把它原样放进
      //   `applyEdit.expectedIncarnation`，关掉重开（版本数字复用）就瞒不过去。
      //   宿主没给（老适配器）就没有这个键 —— 消费方按"缺 = 没有化身可用"处理。
      ...(typeof state.incarnation === 'string' ? { incarnation: state.incarnation } : {}),
      isDirty: state.isDirty,
      eol: state.eol,
      lineCount: state.lineCount,
      textLength: state.textLength,
    }

    if (!includeText) {
      log(`getDocumentState: ${abs} v${state.version}${state.isDirty ? ' (dirty)' : ''}`)
      return out
    }
    if (state.byteLength > MAX_TEXT_BYTES) {
      // 超限 = 整份不给。**不许**截断后当全文：调用方会拿它算坐标。
      log(`getDocumentState: ${abs} v${state.version} text withheld `
        + `(${state.byteLength} bytes > ${MAX_TEXT_BYTES})`)
      return { ...out, textUnavailable: true }
    }
    if (typeof state.text !== 'string') {
      // 要了全文、体积也没超限，宿主却没给 —— 适配器故障，失败闭合。
      throw new BridgeError(ERR.INTERNAL,
        `host did not return text for ${abs} although it was requested and within ${MAX_TEXT_BYTES} bytes`,
        { method, path: abs, hostField: 'readDocumentState', textLength: state.textLength })
    }
    log(`getDocumentState: ${abs} v${state.version} text=${state.textLength} chars`)
    return { ...out, text: state.text }
  }

  /**
   * vscode.applyEdit —— 协作编辑的第一个写入类能力（契约 §6.1.1）。
   *
   * params: { file: string, range: {start:{line,column}, end:{line,column}}（1-based）,
   *           text: string, **expectedVersion: number（必填，整数 ≥ 0）**,
   *           expectedIncarnation?: string（文档实例身份，见下）,
   *           expectedRangeText?: string, grant: {id, epoch} }
   * result: { applied: boolean, file: string（规范化绝对路径）, saved: false, textLength: number }
   *
   * **不保存**：只改缓冲区（`TextEditor.edit`），落盘是 T4 的事。
   * 返回值里的 `saved:false` 不是装饰 —— 它是给 DSH 侧的业务承诺，`response-contract.js`
   * 会把它当谓词校验（`saved === false`），谁把保存加进来谁就得先改契约。
   *
   * **版本锚点（T30）**：`expectedVersion` 必填，值取 `vscode.getDocumentState` 回的
   * `version`（编辑器的 `TextDocument.version`，缓冲区每次被改动 +1）。
   *  - 缺失 / 非整数 / 负数 → `-32602`（`data.reason` 区分四种：见 `readExpectedVersion`），
   *    **宿主零调用**；
   *  - 与文档实际版本不等 → `-32012`，`data = { file, expected, actual }`。
   *    **前置检查里就不等** → 宿主零调用；**到了写入事务内才不等**（检查之后有人改了
   *    缓冲区）→ 宿主被调用但**零构造 edit**（`builder.replace` 一次都不执行，一个字没写）。
   *    后者才是 B1 的保证，见下面的"判序"。
   * **化身锚点（T34）**：可选 `expectedIncarnation`，值取 `vscode.getDocumentState` 回的
   * `incarnation`（文档**实例**身份）。给了就必须与目标文档实例逐字相等，否则 `-32012`：
   *  - 前置 ③b 就不等 → `data = { file, reason:'incarnation-mismatch', expected, actual }`，
   *    **宿主零写入**（连 `applyEditText` 都没调）；
   *  - 到了 ⑦ 的事务内才不等（读完之后文档被关掉重开）→ **零构造 edit**，同一个 data 形状。
   * 它补的是版本锚点的第二个盲区：`TextDocument.version` 是每个实例自己的计数器，
   * 关掉重开后新实例又是 1 —— 数字相等，只有化身能把"旧视角的坐标"与"新实例"分开。
   * 不传 = 不判化身（老调用方向后兼容）；**这不削弱版本门**，两道门各自独立。
   *
   *  - 可选的 `expectedRangeText`（目标范围当前应有的文本）：给了就必须与
   *    `host.readRangeText` 读到的当前文本**逐字相等**，否则 `-32012`，
   *    `data = { file, expectedVersion, actualVersion, reason:'range-text-mismatch',
   *    expectedTextLength, actualTextLength }`，**宿主零调用**。
   *    它补的是版本锚点的盲区：版本相同但调用方记错了坐标时，只有内容比对能发现。
   *
   * **校验顺序（契约：判序本身就是契约）**：
   *   ① 路径守卫（`resolveWorkspaceFile`）→ ② 锚点形状（-32602）
   *   → ③ 版本等值（前置，-32012）→ ③b 化身等值（前置，给了才判，-32012）
   *   → ④ range 形状/越界（-32602）
   *   → ⑤ `expectedRangeText` 内容比对（-32012）→ ⑥ 授权绑定门（执行前复核）
   *   → ⑦ 写宿主；**宿主在提交那一刻再判一次版本与化身（事务内判定，-32012）**。
   *
   * ⚠️ **前置检查不是保证，事务内判定才是**（T32 / 评审 T31 的 B1）。
   *   ③③b 与 ⑦ 之间隔着 ④ 的 `readDocumentShape`、⑤ 的 `readRangeText` 两个 await ——
   *   用户敲一个字、格式化插件跑一次，都发生在这些让出点里。所以 ③ 只是**便宜的早失败**
   *   （错误更早、宿主零调用、日志更好读），真正"绝不覆盖人工内容"的保证在
   *   `edit-transaction.js`：`TextEditor.edit` 的 callback 里同步读 `document.version`、
   *   比对、构造 edit，中间没有让出点。谁把 ⑦ 挪走、或让 ⑦ 退回
   *   `vscode.workspace.applyEdit`（没有版本 CAS），B1 就地复现。
   *   同一文件的**并发重放**另由 `serializeByPath` 串行化（②之后入队，键=`serializeKeyFor(real)`）。
   *
   * 线性化点（契约 §6.1.1 ④）= `host.applyEditText` 这一次调用：它之前失败 = 零落点，
   * 它之后（含超时/断线）结果未知，按"可能已落点"处理。
   */
  async function applyEdit(params, ctx) {
    const method = 'vscode.applyEdit'
    assertTrusted(method)

    const file = params?.file
    if (typeof file !== 'string' || file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
    }
    const text = params?.text
    if (typeof text !== 'string') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.text must be a string', { method })
    }

    // ── ① 路径守卫 ──
    // 工作区内、真实路径、不是链接（详细规则见 workspace-paths.js）。
    // 排在锚点判定之前：路径不合法时连"这个文档的版本是多少"都不该讨论。
    const { abs, real } = resolveWorkspaceFile(file, host.workspaceRoots(), { method })

    // ── ② 锚点形状（纯参数检查、零 await）──
    // 形状错误（-32602）与排队无关，放锁外：非法请求不必排在别人后面等。
    const expectedVersion = readExpectedVersion(params, method)
    const expectedRangeText = readExpectedRangeText(params, method)
    // ★ T34 / **T35 收紧**：化身锚点**无条件必填** —— 缺失/非字符串/空串在调用
    //   `applyEditText` **之前**就是 -32602（宿主零写入）。见 `readExpectedIncarnation`
    //   的 JSDoc：这是有意的不兼容收紧，理由是没有化身就无法证明"同一个文档实例"。
    const expectedIncarnation = readExpectedIncarnation(params, method)

    // ── 同一文件的写入排队（T32 建议 ③）──
    // 从这里到写宿主**整段串行**：第二个请求是在锁内才读版本的，所以它必然看到第一个
    // 请求 bump 之后的版本、拿到 -32012；而不是两个都拿着旧版本一起摸到写宿主。
    // 键是同一文件的**稳定身份**（见 `serializeKeyFor`）—— 同文件的不同写法落在同一条链上，
    // 不同文件互不排队。这里**不许**退回 `canonicalPath(real)`：那只统一盘符，段名大小写
    // 在 Windows 上会让同一文件进两条链（T33 / 评审 I1）。
    // 展示与错误 data 里的 `file` 仍然走 `canonicalPath(abs)`，锁键不参与对外输出。
    return serializeByPath(serializeKeyFor(real),
      () => writeUnderLock({
        method, abs, real, text, expectedVersion, expectedRangeText, expectedIncarnation, params, ctx,
      }))
  }

  /**
   * 写入主体：判序 ③–⑦（说明见 `applyEdit` 的 JSDoc）。**只在同文件的排队链里执行**，
   * 所以这里可以放心用"读版本 → 用坐标"的写法：同一文件的另一条写入不可能插进来。
   * 但**人工编辑**仍然可以插进来 —— 那只能由 ⑦ 的事务内判定挡住。
   */
  async function writeUnderLock({
    method, abs, real, text, expectedVersion, expectedRangeText, expectedIncarnation, params, ctx,
  }) {
    // ── ③ 版本等值（前置检查：不是保证，见 JSDoc 的 ⚠️）──
    // 这里读到的是"这一刻"的版本；下面的 ④⑤ 都是让出点，人工编辑可以在其中发生。
    const state = await readDocumentState(host, real, { includeText: false }, method)
    assertVersionMatches(state.version, expectedVersion, canonicalPath(abs), method)
    // ── ③b 化身等值（前置检查，T34；T35 起**无条件**）──
    // 与 ③ 同一个理由、同一份 `state`：便宜的早失败（宿主零写入 + 错误更早更清楚）。
    // **不是保证** —— 真正的保证在 ⑦ 的事务内，同一行同步区间里再判一次。
    // T35：去掉了 `expectedIncarnation !== undefined` 这个条件。它曾是 H1 的一半：
    // 省略字段 ⇒ 这里整段跳过 ⇒ 只剩整数版本比较。
    assertIncarnationMatches(state.incarnation, expectedIncarnation, canonicalPath(abs), method)

    // ── ④ 范围形状 / 越界 ──
    const range = readRange(params?.range, method)
    // 范围边界（评审 F8）：越界不许交给宿主自己 clamp —— clamp 之后
    // 「写到第 999 行」会静默变成「写到文件末尾」还报 applied:true。
    // 与路径守卫同层：都是**调用方可以自证**的参数错误（-32602），都在绑定门之前。
    const shape = await readDocumentShape(host, real, [range.start.line, range.end.line], method)
    assertRangeInBounds(shape, range, method)

    // ── ⑤ 范围内容比对（可选，但给了就必须逐字相等） ──
    // 版本只能证明"文档没变"，证明不了"你这组坐标当时取的就是这几个字符"。
    if (expectedRangeText !== undefined) {
      const actualText = await readTargetRangeText(host, real, toApiRange(range), method)
      if (actualText !== expectedRangeText) {
        throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
          'params.expectedRangeText does not match the current text of the target range; '
          + 'nothing was written — re-read the document and re-derive the range',
          {
            method,
            file: canonicalPath(abs),
            expectedVersion,
            actualVersion: state.version,
            reason: 'range-text-mismatch',
            // 只回长度，不回内容：错误 data 会进日志，文档内容不该跟着跑。
            expectedTextLength: expectedRangeText.length,
            actualTextLength: actualText.length,
          })
      }
    }

    if (typeof host.applyEditText !== 'function') {
      // 宿主太老（或测试替身没实现）：说清楚缺哪个字段，别让它变成"静默不生效"。
      throw new BridgeError(ERR.INTERNAL,
        'host does not implement applyEditText; this extension build cannot edit buffers',
        { method, hostField: 'applyEditText' })
    }

    // ── ⑥ 执行前复核（契约 §6.1.1 ②B / ③）：线性化点之前再判一次 ──
    // 分派前的门与这里之间有 await/入队缝隙，凭证可能刚被撤销、连接可能刚被取代；
    // 只看"进门时是好的"是不够的 —— 真正要保证的是"动手那一刻还是好的"。
    grantGate(method, params, ctx)

    // ── 写前重验 + 贴着写（评审 R2-1 ①②） ──
    // 上面 `await readDocumentShape` 是一个真实的让出点（打开文档、可能要等 VS Code
    // 加载文本），目录可以在其间被换成 junction。所以紧贴写宿主再验一次，
    // 并且**把刚验到的那个字符串交给宿主** —— 不许验一个、传另一个。
    // 这一段与下面的 applyEditText 之间没有别的 await：窗口缩到一次同步调用。
    const writeTarget = revalidateWriteTarget({ abs, real }, host.workspaceRoots(), { method })

    // ── ⑦ 写宿主：版本等值的**唯一保证**在这一次调用的内部（T32）──
    // 传下去的是**锚点本身**（`expectedVersion`），不是一个"我已检查过"的布尔值：
    // 宿主/适配器在 `TextEditor.edit` 的同步 callback 里读 `document.version` 再比一次。
    // 上面 ④⑤ 已经跑过几个 await，人工编辑完全可能就发生在其中 —— 所以这一道不是重复劳动，
    // 而是唯一真正挡住 B1 的那一道（`edit-transaction.js`）。
    const outcome = await host.applyEditText(
      writeTarget, toApiRange(range), text, expectedVersion, expectedIncarnation,
    )
    // ── 写后复核（评审 R2-1 ③） ──
    // 写入已经发生，本步阻止不了"落到了被换掉的目录"；它只是在**采样到路径差异/解析失败**
    // 时拒报成功（-32603）。它是采样而不是写入历史：替换持续到此刻才算数，
    // "没采样到差异"不代表没被替换过（换出再换回就看不出来）—— 完整判据在下一行。
    assertTargetUnchanged(writeTarget, { method })
    // ── 写入文档身份（评审 R3-1：这才是"写到底落在哪个文档"的判据） ──
    // 写宿主必须报出它实际编辑的那个文档的规范化路径（`document.uri.fsPath` 之类）；
    // 与写前验过的 `writeTarget` 不一致 → 不报成功（-32602）；报不出来 → 失败闭合（-32603）。
    // 在此之前的所有检查都只能证明"这个路径此刻指向哪"，只有文档身份能证明"写进了哪个文档"。
    assertWrittenDocumentIdentity(outcome, writeTarget, { method })
    const applied = outcome?.applied !== false
    log(`applyEdit: ${abs} ${applied ? 'applied' : 'rejected by host'}`
      + ` ${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`
      + ` (${text.length} chars, buffer only — not saved)`)
    return {
      applied,
      // 回传**规范化后的绝对路径**（与 openFile/getSelection 同一口径），
      // 而不是调用方传进来的那个写法：消费者按字符串比较时才不会静默失败。
      file: canonicalPath(abs),
      saved: false,
      textLength: text.length,
    }
  }

  /**
   * vscode.save —— **Tier 3 落盘**（T39；契约 §6.2.1 的 Tier 3 行）。
   * params:  { file, expectedVersion, expectedIncarnation, expectedDisk: {mtime, size} }
   * result:  { saved: true, file, disk: {mtime, size}, dirtyBefore: boolean }
   *
   * 判序（就是契约 §6.2.1 列的那一串，**顺序即语义**）：
   *   ① 信任（-32006）→ ② 参数形状（`file` / `expectedVersion` / `expectedIncarnation` /
   *   `expectedDisk`，任何一项坏都是 `-32602`，宿主**零调用**）→ ③ 路径守卫（工作区/真路径/
   *   非链接）→ ④ 文档状态：版本不等或化身不等 → `-32012`；`untitled` → `-32602
   *   reason:'untitled-document'` → ⑤ **意图门**：缓冲区脏且 grant 没有 `allowDirtySave`
   *   → `-32012 reason:'buffer-dirty'` → ⑥ **磁盘锚点**：真实 stat 与 `expectedDisk`
   *   不符 → `-32013` → ⑦ 绑定门**执行前**再判一次（`-32010`）→ ⑧ 写前重验路径 →
   *   ⑨ `host.saveDocument`（**无 CAS**）→ ⑩ 写后复核路径/文档身份 → ⑪ 重新 stat 得到
   *   `disk` **真值**（不是回显参数）。
   *
   * 为什么磁盘锚点是**独立的新码**（`-32013`，契约 §6.2.3 / §6.2.7）：`-32012` 的处置是
   * "重读锚点、重发请求"；磁盘冲突**永远不能自动重试** —— 本端不知道磁盘上那份字节是谁
   * 写的，重发等于拿没见过的内容覆盖别人的改动。两条处置相反，就不能共用一个码。
   *
   * ★ **诚实标注（§6.2.6 的硬上限，别把这道门当成它做不到的东西）**：
   *   这是**善意防护**。`TextDocument.save()` 没有 CAS 参数（`vscode.d.ts:160`），
   *   我们能做的只是"在保存之前尽早发现状态不对"。**检查之后被保存参与者改写**
   *   （`editor.formatOnSave` / `files.trimTrailingWhitespace` / `onWillSaveTextDocument`
   *   监听者在保存瞬间插入的编辑）**导致的磁盘字节与本端锚定的缓冲区内容之间的差异，
   *   不在本门的保证范围内**。同理，磁盘在本端 stat 之后、`save()` 真正落盘之前被外部
   *   改写，也拦不住（无 CAS ⇒ 没有"写到我才认的那一版上"这个语义）。本门保证的是
   *   「**保存之前**，我看到的那份缓冲区与那份磁盘字节都还是我以为的那一份」，以及
   *   「**保存之后**，磁盘上现在是什么就是什么（真值回传，不粉饰）」。
   */
  async function save(params, ctx) {
    const method = 'vscode.save'
    assertTrusted(method)

    // ── ② 参数形状（纯同步，零宿主调用）──
    const file = params?.file
    if (typeof file !== 'string' || file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
    }
    const expectedVersion = readExpectedVersion(params, method)
    // 双锚点照旧必填（§6.2.2 / §6.2.3）：缺一即 -32602，宿主零调用。
    const expectedIncarnation = readExpectedIncarnation(params, method)
    // 磁盘锚点必填（§6.2.3）：形状坏 = 参数错，不是"跳过这道门"。
    const expectedDisk = readExpectedDisk(params, method)

    // ── ③ 路径守卫（与 applyEdit 同一套：单根、工作区内、真路径、链上无链接）──
    const { abs, real } = resolveWorkspaceFile(file, host.workspaceRoots(), { method })

    // ── 同文件排队（与 applyEdit 共用同一条链）──
    // 保存与编辑都必须串行：否则"读版本 → 保存"之间可以插进一次 applyEdit，
    // 保存下去的就不是本端锚定的那份缓冲区了。键同样是 `serializeKeyFor(real)`。
    return serializeByPath(serializeKeyFor(real), () => saveUnderLock({
      method, abs, real, params, ctx, expectedVersion, expectedIncarnation, expectedDisk,
    }))
  }

  /** `vscode.save` 的主体：判序 ④–⑪（说明见 `save` 的 JSDoc）。只在该文件的排队链里跑。 */
  async function saveUnderLock({
    method, abs, real, params, ctx, expectedVersion, expectedIncarnation, expectedDisk,
  }) {
    // ── ④ 文档状态：版本 + 化身（便宜且更早的失败；不是保证）──
    const state = await readDocumentState(host, real, { includeText: false }, method)
    // 未落盘文档（untitled）**先报**：它不是"修一下再试"的冲突，而是"根本没有盘可落"，
    // 拿去和版本冲突比先后只会误导下一步动作。§6.2.1 把 ⑭ 排在最后是按"能走到那一步"
    // 的默认路径列的，这里提前是因为判据已经拿到了手（`state.untitled`）。
    if (state.untitled === true) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'the document has never been saved to disk (untitled); this capability only saves '
        + 'documents that already have a file path inside the workspace',
        { method, file: canonicalPath(abs), reason: 'untitled-document' })
    }
    assertVersionMatches(state.version, expectedVersion, canonicalPath(abs), method)
    assertIncarnationMatches(state.incarnation, expectedIncarnation, canonicalPath(abs), method)

    // ── ⑤ 意图门（§6.2.2 的结论）──
    // `isDirty` 是宿主给的**布尔汇总**，分不清"DSH 自己改的"与"人敲的"。所以：
    // 脏 = 缓冲区里有本端不能证明来源的内容，默认**拒**；只有**授权方**在 grant 上
    // 显式给了 `allowDirtySave: true` 才放行。★ 这个位**不许**从 `params` 读 ——
    // 那样等于调用方自己给自己授权，这道门就等于不存在。
    const dirtyBefore = state.isDirty === true
    if (dirtyBefore && !grantAllowsDirtySave(grants, params?.grant)) {
      throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
        'the buffer has unsaved changes that this request is not authorized to write to disk; '
        + 'either save with a grant issued with allowDirtySave:true, or discard/re-read the '
        + 'buffer first (nothing was saved)',
        {
          method,
          file: canonicalPath(abs),
          reason: 'buffer-dirty',
          // 回显版本只用于"我基于哪一版"的对照；不把文本/差异放进来。
          expectedVersion,
          actualVersion: state.version,
          allowDirtySave: false,
        })
    }

    // ── ⑥ 磁盘锚点（§6.2.3）：真实 stat 比 {mtime, size}，不符即 -32013 ──
    // 放在 `save()` 之前是它能起作用的唯一位置 —— 之后就没有"拒绝"这个选项了。
    const diskBefore = await readDiskStatOf(host, real, method)
    assertDiskMatches(diskBefore, expectedDisk, canonicalPath(abs), method)

    if (typeof host.saveDocument !== 'function') {
      throw new BridgeError(ERR.INTERNAL,
        'host does not implement saveDocument; this extension build cannot write to disk',
        { method, hostField: 'saveDocument' })
    }

    // ── ⑦ 执行前复核（§6.1.1 ②B / ③）：动手那一刻凭证还得是好的 ──
    // 与 applyEdit 同位置、同理由：进门时好，不代表现在还好（中间有多个 await）。
    grantGate(method, params, ctx)

    // ── ⑧ 写前重验路径，并把**刚验过的那个字符串**交给宿主 ──
    const writeTarget = revalidateWriteTarget({ abs, real }, host.workspaceRoots(), { method })

    // ── ⑨ 线性化点：`save()`。它没有 CAS，所以这里**不提供**"只写在锚定的那一版上"，
    //    只提供"走到这里之前，两边的锚点都还对得上"。──
    const outcome = await host.saveDocument(writeTarget, { expectedVersion, expectedIncarnation })

    // `save()` 的返回值只可能是布尔（`Thenable<boolean>`）。非布尔 = 适配器坏了 → -32009，
    // 不许把 `undefined` 当成"大概成功了吧"（§5.1「成功外形的错误结果」同一条禁令）。
    if (typeof outcome?.saved !== 'boolean') {
      throw new BridgeError(ERR.INVALID_RESPONSE,
        'host.saveDocument must resolve {saved: boolean}; got '
        + `${outcome?.saved === undefined ? 'undefined' : typeof outcome.saved}`,
        { method, field: 'saved', got: { type: typeof outcome?.saved } })
    }
    if (outcome.saved !== true) {
      // 宿主明确说"没存成"。untitled 单独给形状（§6.2.1 ⑭），其余一律 host-save-failed。
      if (outcome.reason === 'untitled-document') {
        throw new BridgeError(ERR.INVALID_PARAMS,
          'the document has never been saved to disk (untitled); nothing to write to',
          { method, file: canonicalPath(abs), reason: 'untitled-document' })
      }
      throw new BridgeError(ERR.INTERNAL,
        'the editor refused to save the document; the file on disk may be unchanged '
        + '(nothing is reported as saved)',
        {
          method,
          file: canonicalPath(abs),
          reason: 'host-save-failed',
          hostReason: outcome.reason ?? null,
          // `false` 是宿主对"我没写下去"的明确表态（`Thenable<boolean>`），
          // 所以这里可以负责任地说"没应用"；报不出来（非布尔）那条分支才说"未知"。
          mayHaveApplied: false,
        })
    }

    // ── ⑩ 写后复核（与 applyEdit 同一对判据：路径采样 + 文档身份）──
    assertTargetUnchanged(writeTarget, { method })
    assertWrittenDocumentIdentity(outcome, writeTarget, { method })

    // ── ⑪ 重新 stat：`disk` 必须是**保存后的真值**，不是回显 `expectedDisk` ──
    // 回显等于骗人：`formatOnSave` / 保存参与者改过字节、或保存根本没改变文件时，
    // 回显会让调用方以为"磁盘现在就是我给的那个锚点"。
    const disk = await readDiskStatOf(host, real, method)
    if (!disk) {
      // 报了保存成功、磁盘上却 stat 不到 —— 失败闭合：不许返回 `{saved:true}` 配一个瞎编的 disk。
      throw new BridgeError(ERR.INTERNAL,
        `the editor reported a successful save, but ${canonicalPath(abs)} cannot be stat-ed `
        + 'afterwards; refusing to report what cannot be observed',
        {
          method,
          file: canonicalPath(abs),
          reason: 'disk-stat-unavailable',
          // save() 已经调过了，结果无法观测 —— 只能说"可能已写"，不能说"没写"。
          mayHaveApplied: true,
          retryable: false,
        })
    }

    log(`save: ${abs} v${state.version}${dirtyBefore ? ' (dirty, allowDirtySave)' : ''} `
      + `disk ${expectedDisk.mtime}/${expectedDisk.size} -> ${disk.mtime}/${disk.size}`)
    return {
      saved: true,
      file: canonicalPath(abs),
      disk,
      dirtyBefore,
    }
  }

  /**
   * 读**整份**字节（删除备份用）。超限**整份放弃**，绝不截断 —— 半份快照比没有更坏：
   * 它让人误以为手里有恢复材料，而那份材料缺了尾部。
   *
   * ⚠️ 上限用的是 `DELETE_BACKUP_MAX_BYTES`（交付上限），**不是** `DELETE_SNAPSHOT_MAX_BYTES`
   * （读上限）。T42 / 评审 I1 之后这两件事必须一致：读得进来却交不出去，等于白读一遍
   * 然后删掉（旧实现就是这样）。见 `buildSnapshot` 的注释。
   *
   * 失败一律 `-32603`，并且**此时还没删** —— 调用方读到的 `mayHaveApplied:false` 是真的：
   * 读不了（`reason:'snapshot-unavailable'`）或交不出（`reason:'backup-undeliverable'`）。
   */
  async function readSnapshotBytes(host, abs, method) {
    let read
    try {
      read = await host.readFileBytes(abs, { maxBytes: DELETE_BACKUP_MAX_BYTES })
    } catch (err) {
      // 文件已经没了 → 那是 -32003（"没有可删的东西"），不是"快照失败"。
      if (err?.code === ERR.NOT_FOUND) throw err
      throw new BridgeError(ERR.INTERNAL,
        `could not read ${abs} to take a delete snapshot (${err?.message ?? err}); nothing was `
        + 'deleted — without the bytes there is no recovery material',
        {
          method,
          file: canonicalPath(abs),
          reason: 'snapshot-unavailable',
          why: 'unreadable',
          mayHaveApplied: false,
        })
    }
    if (read && read.tooLarge === true) {
      throw new BridgeError(ERR.INTERNAL,
        `${abs} is ${read.size ?? 'more than ' + DELETE_BACKUP_MAX_BYTES} bytes, over the `
        + `${DELETE_BACKUP_MAX_BYTES}-byte deliverable-backup limit; nothing was deleted — `
        + 'a backup that cannot be handed over is not recovery material',
        {
          method,
          file: canonicalPath(abs),
          reason: 'backup-undeliverable',
          why: 'too-large',
          size: Number.isInteger(read.size) ? read.size : null,
          maxBytes: DELETE_BACKUP_MAX_BYTES,
          backup: { delivered: false, reason: 'too-large' },
          mayHaveApplied: false,
        })
    }
    const buffer = read?.buffer
    if (!Buffer.isBuffer(buffer)) {
      throw new BridgeError(ERR.INTERNAL,
        'host.readFileBytes must resolve {buffer: Buffer} or {tooLarge: true}',
        {
          method,
          file: canonicalPath(abs),
          reason: 'snapshot-unavailable',
          why: 'invalid-read',
          got: { type: typeof buffer },
          mayHaveApplied: false,
        })
    }
    if (buffer.length > DELETE_BACKUP_MAX_BYTES) {
      throw new BridgeError(ERR.INTERNAL,
        `host.readFileBytes returned ${buffer.length} bytes, over the `
        + `${DELETE_BACKUP_MAX_BYTES}-byte deliverable-backup limit; nothing was deleted`,
        {
          method,
          file: canonicalPath(abs),
          reason: 'backup-undeliverable',
          why: 'too-large',
          size: buffer.length,
          maxBytes: DELETE_BACKUP_MAX_BYTES,
          backup: { delivered: false, reason: 'too-large' },
          mayHaveApplied: false,
        })
    }
    return buffer
  }

  /**
   * vscode.deleteFile —— **Tier 4 删除**（T40；契约 §6.2.1 的 Tier 4 行）。
   *
   * ⚠️ 这是本项目**第一个不可逆操作**，也是第一条"只靠往工作区里写文件内容就能被驱动"
   * 的不可逆通道（§6.2.5 的 T-B 提示注入：路径守卫挡得住工作区**之外**，挡不住工作区里
   * 一个完全正确的路径）。所以四道闸**同时**在，缺一不可（§6.2.5 `[规定]`：
   * 白名单是必要条件，不是充分条件）：
   *   ① 白名单最高档 `delete`（`whitelist.js`；身份由消费者自报，是 advisory）；
   *   ② 绑定门（`WRITE_METHODS` → `-32010`，与 `applyEdit` / `save` 共用同一套）；
   *   ③ **人工确认**（扩展侧 modal `showWarningMessage`，人点"删除"才继续，否则 `-32002`）；
   *   ④ **内容快照**（删前把字节读进结果；读不到/超限就**不删**）。
   *
   * ★ 诚实标注（不许被后来的文案优化掉）：
   *   - **不保证进回收站**：`workspace.fs.delete(uri,{useTrash:true})` 的契约措辞是
   *     "whenever possible"，扩展侧没有能探测 `Trash` 能力位的 API —— 所以返回体里
   *     `trashed` 的唯一诚实取值是 `'unknown'`（**禁写 `true`**，§6.2.4 ①）。
   *   - **不提供撤销**：`FileSystem` 没有 restore，Explorer 的撤销栈我们也驱动不了。
   *     返回值里不许出现任何"可恢复"措辞 —— 这句话本身就是在防止人误以为能撤销。
   *   - **不支持目录 / 递归**：只删单个已存在的真实文件（空目录档本期不开，§6.2.8 #5）；
   *     目录 → `-32602 reason:'recursive-delete-unsupported'`，symlink/junction 本身 → `'symlink'`。
   *   - **由扩展发起**：删除的 actor 是扩展进程而不是编辑器里那个人，归因上事后**无法区分**
   *     "人自己删的"与"DSH 删的"（T-C）。
   *
   *   - **由扩展发起**：删除的 actor 是扩展进程而不是编辑器里那个人，归因上事后**无法区分**
   *     "人自己删的"与"DSH 删的"（T-C）。
   *
   * ## ★ T44 语义裁决：`vscode.deleteFile` **不删任何字节**，只"移入隔离区，永不删"
   *
   * 名字与档位保留（要求 `grant`、白名单最高档 `delete`、人工确认、整份备份），
   * 但**动作**变了：把目标 rename 进 `<工作区根>/.dsh-quarantine/<UTC 时间戳>-<原名>`，
   * 然后**在隔离体的新位置上重新测量** sha256/长度并如实返回。代码里没有任何
   * `unlink` / `workspace.fs.delete` —— 没有不可逆动作，就没有"删错"这件事。
   *
   * 为什么放弃"隔离后按隔离名删除"（T42 的写法，评审 T43 B1-a 否决）：
   *   1. **open-writer 窗口**：隔离前对原件 `openSync(f,'r+')` 拿到的写句柄不因 rename
   *      失效。验完字节、`unlink` 之前用那个 fd 写同长度新字节，新字节就是被删掉且没有
   *      任何留存的那一份，而旧快照冒充"删掉的就是它"。
   *   2. **provider 消费窗口**：`workspace.fs.delete(uri)` 消费 URI 的那一刻，先 rename
   *      走隔离体、在同一隔离名上写新字节、再删 —— 随机名挡不住"名字还在、内容已换"。
   *   两条都不是"再算一次 hash"能挡的：校验对象与销毁对象之间隔着时间，而 hash 只描述
   *   名称下的字节。**不销毁**才是结构性的解法（T44 裁决）。
   *
   * ## 剩下的唯一判据：被移走的是不是人批准的那个**对象**
   *
   * 归档前取 `(dev, ino)`（`readFileIdentity`），归档后在隔离体上再取一次：
   *   - 相同 ⇒ 同一个 inode ⇒ 完成，随后**重新测量**（结果与确认时不同就
   *     `bytesChanged:true`，两份都不丢：确认时那份在 `snapshot`，现在这份在 `to`）；
   *   - 不同 ⇒ 被人"挪走原件 + 同字节顶名"⇒ 归还隔离体并报 `-32013`
   *     （`reason:'target-replaced-before-quarantine'`，**两份文件都在**）。
   *
   * 判序（Tier 3 全部 + ⑯–㉑）：路径与形态 → 双锚点 → 脏缓冲区意图门 → 磁盘锚点 →
   * 绑定门 → **备份（交不出整份字节就拒，评审 I1）** → **人工确认（独立长超时，超时作废
   * 许可）** → 动手前重验（路径/锚点/字节同一个 sha256）→ 取对象身份 →
   * **rename 进隔离区（线性化点，也是全部动作）** → 归档后认对象、重测字节 → 返回。
   *
   * ⚠️ 快照(⑱)排在确认(⑰)**之前**：确认框要展示预览，没有快照就没有预览。硬按编号顺序
   * 排会让"人看着文件名点删除"，而 §6.2.4 ② 要的正是"人看着**内容**点删除"。
   * （同 `save` 把 `⑭ untitled` 提前的理由：判据已经在手，先报更有用的那个事实。）
   *
   * params: { file: string,
   *           expectedVersion: number, expectedIncarnation: string,   // 双锚点（-32012）
   *           expectedDisk: {mtime, size},                            // 磁盘锚点（-32013）
   *           grant?: {id, epoch} }
   * result: { quarantined: true, file: string,
   *           from: string, to: string,                    // 原名 → 隔离体路径（都不存在删除）
   *           confirmedSha256, confirmedByteLength,        // 人确认时那份（与 backup 同源）
   *           quarantinedSha256, quarantinedByteLength,    // 移动**完成后**在隔离体上实测
   *           bytesChanged: boolean,                       // 两者不同 = 归档后被就地改写
   *           bytesChangedNote?: string,                   // bytesChanged 时如实说明两份都在
   *           snapshot: {sha256, byteLength, encoding, text|base64},  // 完整备份（I1）
   *           backup: { delivered: true, form, byteLength, sha256 },  // 交付形态
   *           quarantine: {path, original, retained: true, restored: false},
   *           nameCollision: boolean }                     // 同名冲突是否用过随机后缀

   */
  async function deleteFile(params, ctx) {
    const method = 'vscode.deleteFile'
    assertTrusted(method)

    if (typeof params?.file !== 'string' || params.file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
    }
    const expectedVersion = readExpectedVersion(params, method)
    const expectedIncarnation = readExpectedIncarnation(params, method)
    const expectedDisk = readExpectedDisk(params, method)

    // ── ⑯ 路径与形态（规则 0 单根 / 规则 2 整链 lstat / 拒绝非普通文件）──
    // 契约 §6.2.4 ④：多根与 symlink 全拒，**不需要新机制** —— 这两条规则对删除恰好
    // 是最没争议的用法（删掉一个链接 = 删掉一个"指向别处"的入口，爆炸半径不可评估）。
    const { abs, real, root } = resolveWorkspaceFile(params.file, host.workspaceRoots(), {
      method,
      nonFileReason: 'recursive-delete-unsupported',
    })

    // 与 applyEdit / save 共用同一条按文件串行化的链：确认期间**持有**这条链是有意的 ——
    // 否则"人看着的那份内容"与"真正要删的那份"之间可以插进一次写。
    return serializeByPath(serializeKeyFor(real), () => deleteUnderLock({
      method, abs, real, root, params, ctx, expectedVersion, expectedIncarnation, expectedDisk,
    }))
  }

  /** `vscode.deleteFile` 的主体：判序见 `deleteFile` 的 JSDoc。只在该文件的排队链里跑。 */
  async function deleteUnderLock({
    method, abs, real, root, params, ctx, expectedVersion, expectedIncarnation, expectedDisk,
  }) {
    // ── 双锚点（Tier 3 的 ⑫ 前半）──
    const state = await readDocumentState(host, real, { includeText: false }, method)
    if (state.untitled === true) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'the document has never been saved to disk (untitled); there is no file to delete',
        { method, file: canonicalPath(abs), reason: 'untitled-document' })
    }
    assertVersionMatches(state.version, expectedVersion, canonicalPath(abs), method)
    assertIncarnationMatches(state.incarnation, expectedIncarnation, canonicalPath(abs), method)

    // ── 意图门（Tier 3 的 ⑪）：脏缓冲区默认拒 ──
    // 删除比 save 更严的地方：save 的出路是"把缓冲区写下去"，delete **没有**这个出路 ——
    // 脏缓冲区意味着"磁盘上那份不是人眼下的全部内容"，快照盖不住未保存的编辑。
    // 仍然只由**授权方**在 grant 上给的 `allowDirtySave` 放行（不许从 `params` 读）。
    const dirtyBefore = state.isDirty === true
    if (dirtyBefore && !grantAllowsDirtySave(grants, params?.grant)) {
      throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
        'the buffer has unsaved changes that are not on disk; the snapshot would not cover them, '
        + 'so nothing was deleted — save/discard first, or delete with a grant issued with '
        + 'allowDirtySave:true',
        {
          method,
          file: canonicalPath(abs),
          reason: 'buffer-dirty',
          expectedVersion,
          actualVersion: state.version,
          allowDirtySave: false,
        })
    }

    // ── 磁盘锚点（Tier 3 的 ⑫ 后半）：真实 stat 比 {mtime, size}，不符即 -32013 ──
    const diskBefore = await readDiskStatOf(host, real, method)
    assertDiskMatches(diskBefore, expectedDisk, canonicalPath(abs), method, { action: 'delete' })

    for (const field of ['readFileBytes', 'confirmDelete', 'quarantineRename',
      'ensureDirectory', 'readFileIdentity']) {
      if (typeof host[field] !== 'function') {
        throw new BridgeError(ERR.INTERNAL,
          `host does not implement ${field}; this extension build cannot archive files`,
          { method, file: canonicalPath(abs), hostField: field })
      }
    }

    // ── 执行前复核 ①：动手那一刻凭证还得是好的（§6.1.1 ②B）。排在人被骚扰之前 ──
    grantGate(method, params, ctx)

    // ── ⑱ 内容备份：**读不到 / 交不出去就不删**（评审 I1）──
    // `buildSnapshot` 只在"整份字节能随响应交出"时才返回（UTF-8 → text；二进制 → base64）；
    // 超 `DELETE_BACKUP_MAX_BYTES` 直接抛 `backup-undeliverable`。旧实现回
    // `textOmitted:'too-large'` 然后照删，那等于没有恢复材料 —— 现在没有第二条路。
    const snapshot = buildSnapshot(await readSnapshotBytes(host, abs, method),
      { method, file: canonicalPath(abs) })

    // ── ⑰ 人工确认（独立长超时；超时**作废**这次许可，迟到的"同意"不生效）──
    await askHumanToDelete({ abs, snapshot, method })

    // ── 动手前重验（确认期间人可能离开了 2 分钟，世界会变）──
    // ① 路径：同一个字符串再解析一次（链接/别名/越界都在这里重新过一遍）
    const deleteTarget = revalidateWriteTarget({ abs, real }, host.workspaceRoots(), {
      method, nonFileReason: 'recursive-delete-unsupported',
    })
    // ② 磁盘锚点：人看到的 {mtime,size} 必须还是现在这份
    const diskNow = await readDiskStatOf(host, real, method)
    assertDiskMatches(diskNow, expectedDisk, canonicalPath(abs), method, { action: 'delete' })
    // ③ 字节：锚点只到"同一时刻且同样大小"，改完再改回来（同 mtime 同 size）它也认不出来。
    //    重读一次比 sha256 —— 这里用 `digestOf`（只要身份，不重复造备份载荷）。
    //    ⚠️ 这一步**不是**原子性来源（评审 B1 已否掉"再算一次 hash"）：它只挡"确认框开着
    //    的时候内容变了"，挡不住"验完之后、按路径删之前被换掉"—— 那件事由 ⑲ 的改名隔离解决。
    const bytesNow = digestOf(await readSnapshotBytes(host, abs, method))
    if (bytesNow.sha256 !== snapshot.sha256 || bytesNow.byteLength !== snapshot.byteLength) {
      throw new BridgeError(ERR.DISK_STATE_CONFLICT,
        'the file bytes changed while the delete confirmation was open; nothing was deleted — '
        + 'what the user approved is not what is on disk now',
        {
          method,
          file: canonicalPath(abs),
          reason: 'bytes-changed',
          expected: { sha256: snapshot.sha256, byteLength: snapshot.byteLength },
          actual: { sha256: bytesNow.sha256, byteLength: bytesNow.byteLength },
        })
    }

    // ── 执行前复核 ②：确认框开着的时候授权可能已经死了（另一条 await）──
    grantGate(method, params, ctx)

    // ── 对象身份（T44 / 评审 B1-a）：**紧贴归档之前**取一次 (dev, ino) ──
    // 为什么不是"再算一次 hash"：hash 只说明"这两个名字下的字节相同"，而 B1 的两条实证
    // （open-writer 写句柄 / provider 消费窗口）换掉的是**对象**，复算看不见。
    // rename 不改 dev+ino，于是"我移走的那个对象"必须与"这一刻的对象"是同一对。
    // 取在 grantGate 之后的最后一刻：中间只剩"建目录 + 挑名字 + rename"三小步。
    const identityBefore = await readFileIdentityOf(host, deleteTarget)
    if (identityBefore === null) {
      throw new BridgeError(ERR.NOT_FOUND,
        'the file disappeared before it could be archived; nothing was deleted or moved',
        { method, file: canonicalPath(abs), reason: 'target-vanished' })
    }

    // ── ⑲ 归档：rename 进 `<root>/.dsh-quarantine/`（T44 的**唯一**动作）──
    //
    // ★ T44 的语义裁决：`vscode.deleteFile` **不删任何字节**，只把目标移进隔离区。
    //   理由在评审 T43 B1-a 的实证里：按路径删除 + 任何"名字/复算"型绑定都挡不住
    //   "验完之后被就地改写"（open-writer 的 fd 写不因 rename 失效）。不删就没有
    //   不可逆动作 —— 剩下的问题只是"移走的对象对不对"，那由 (dev, ino) 判定。
    const quarantineDir = quarantineDirFor(root)
    try {
      await host.ensureDirectory(quarantineDir)
    } catch (err) {
      throw new BridgeError(ERR.INTERNAL,
        `could not create the quarantine directory ${canonicalPath(quarantineDir)} `
        + `(${err?.message ?? err}); nothing was moved`,
        {
          method,
          file: canonicalPath(abs),
          reason: 'quarantine-dir-failed',
          quarantineDir: canonicalPath(quarantineDir),
          mayHaveApplied: false,
          retryable: true,
        })
    }
    const picked = await pickQuarantinePath(host, quarantineDir, deleteTarget,
      { method, file: canonicalPath(abs) })
    const quarantineAbs = picked.path
    const quarantine = quarantineInfo(quarantineAbs, deleteTarget)
    try {
      await host.quarantineRename(deleteTarget, quarantineAbs)
    } catch (err) {
      const hostCode = String(err?.data?.hostCode ?? err?.code ?? 'unknown')
      throw new BridgeError(ERR.INTERNAL,
        `could not move ${baseNameOf(abs)} into the quarantine directory (${hostCode}); `
        + 'nothing was deleted and nothing was moved — the file is still at its original path'
        + (hostCode === 'EXDEV'
          ? ' (the quarantine directory is on another volume; a cross-volume move is refused '
            + 'rather than emulated with copy+delete)'
          : ''),
        {
          method,
          file: canonicalPath(abs),
          reason: 'quarantine-failed',
          hostCode,
          crossVolume: hostCode === 'EXDEV',
          quarantineDir: canonicalPath(quarantineDir),
          quarantine: { ...quarantine, retained: false, reason: 'rename-failed' },
          mayHaveApplied: false,
          retryable: true,
        })
    }

    // ── ㉑ 归档后：先认对象，再认字节 ──
    const identityAfter = await readFileIdentityOf(host, quarantineAbs)
    if (identityAfter === null) {
      throw new BridgeError(ERR.INTERNAL,
        `the move to ${quarantine.path} was not observed; nothing was deleted, but the file is `
        + 'not where we left it — look at `quarantine` before retrying',
        {
          method,
          file: canonicalPath(abs),
          reason: 'quarantine-not-observed',
          quarantine,
          mayHaveApplied: false,
          retryable: true,
        })
    }
    if (!sameFileObject(identityBefore, identityAfter)) {
      // 移过来的**不是**人批准的那个对象（原件被挪走、同字节顶名）。
      // 判据是身份不是字节：字节完全相同也必须拒 —— 人批准的是那个 inode。
      // 归还（原名被占就保留隔离体并报出真实路径），然后按 -32013 报"磁盘状态冲突"。
      const putBack = await restoreQuarantined(host, quarantineAbs, deleteTarget)
      throw new BridgeError(ERR.DISK_STATE_CONFLICT,
        'the file that was moved into quarantine is not the object the user approved (its '
        + '(dev, ino) identity changed between the last pre-check and the move); nothing was '
        + 'deleted — both files are still on disk',
        {
          method,
          file: canonicalPath(abs),
          reason: 'target-replaced-before-quarantine',
          confirmed: { sha256: snapshot.sha256, byteLength: snapshot.byteLength },
          identity: { expected: identityBefore, actual: identityAfter },
          quarantine: putBack,
          mayHaveApplied: false,
          retryable: false,
        })
    }
    // 同一个对象 → 在它**现在的位置**重新测量。这一步产出的才是 quarantined*，
    // 与 confirmed*（人看着点确认的那份）分开报，差异如实写进 `bytesChanged`。
    const measured = await measureQuarantined(
      (target) => readSnapshotBytes(host, target, method), quarantineAbs,
      { method, file: canonicalPath(abs), quarantine })
    const bytesChanged = measured.sha256 !== snapshot.sha256
      || measured.byteLength !== snapshot.byteLength

    log(`quarantine: ${abs} -> ${baseNameOf(quarantineAbs)} bytes=${measured.byteLength} `
      + `sha256=${measured.sha256.slice(0, 12)} confirmed=${snapshot.sha256.slice(0, 12)} `
      + `bytesChanged=${bytesChanged} collided=${picked.collided}`)
    return {
      // ★ T44 的语义：移动 + 永不删。字段名用 `quarantined` 而不是 `deleted` ——
      //   让"没有删除"这件事在返回体里就是字面事实，而不是注释里的承诺。
      quarantined: true,
      file: canonicalPath(abs),
      from: canonicalPath(deleteTarget),
      to: quarantine.path,
      // 人确认时那份字节的身份（与 backup 同源，取自 snapshot）。
      confirmedSha256: snapshot.sha256,
      confirmedByteLength: snapshot.byteLength,
      // ★ 归档**完成之后**在隔离体上实测的那份。绝不复用 confirmed*。
      quarantinedSha256: measured.sha256,
      quarantinedByteLength: measured.byteLength,
      // 两者不同 ⇔ 归档之后隔离体被就地改写过（open-writer 的 fd 写、provider 消费窗口
      // 都是这种情形）。此时**两份都在**：确认时的那份在 `snapshot` 里，现在这份在 `to` 下。
      bytesChanged,
      ...(bytesChanged === true
        ? {
          bytesChangedNote: 'the quarantined bytes differ from the bytes the user confirmed; '
            + 'nothing was deleted — the confirmed bytes are in this response (`snapshot`) and '
            + 'the bytes on disk now are at `to`',
        }
        : {}),
      // 完整字节（utf8 → text；二进制 → base64）。**不是** hash：评审核对过 §6.2.4 ③，
      // "读过一遍"不等于"交出了恢复材料"。
      snapshot,
      backup: {
        delivered: true,
        form: snapshot.encoding === 'binary' ? 'base64' : 'utf8-text',
        byteLength: snapshot.byteLength,
        sha256: snapshot.sha256,
      },
      // 隔离体现在在哪 —— 成功时它**就是要保留**的那一份，`retained:true`。
      quarantine,
      // 同名冲突是否触发过随机后缀（诊断用；不影响任何判据）。
      nameCollision: picked.collided,
    }
  }


  /**
   * 人工确认（§6.2.4 ② / §6.2.5）。**过了这一关才允许有不可逆动作。**
   *
   * 超时语义选的是"**作废许可**"而不是"到期默认同意/默认拒绝后还能被迟到同意翻案"：
   *   - 超时 → `-32004 reason:'confirm-timeout'`（复用既有 TIMEOUT 码，§6.2.7 不许新增码）。
   *   - 超时那一刻起，这次许可**结构上**失效：`Promise.race` 已经把对话框的 promise
   *     丢掉，人在 121 秒点的"删除"不会落到任何 await 上 —— 不是"忽略一个布尔"，是
   *     没有任何代码在等它。**不选 `-32002 declined`**：人并没有拒绝，"超时"和"拒绝"
   *     要能分开（前者该重试/延长，后者重试没有意义），这也是 §7 #5 把"作废"与
   *     "拒绝"分列的原因。
   *
   * ⚠️ 定时器**故意不 unref()**（与铁律 4 的默认相反）：它是"超时作废"语义的唯一载体。
   *    unref 之后，若进程里只剩它在等（单测/一次性脚本里就是这样），事件循环会先退出，
   *    超时永远不发生 = "人可以无限期不回答、许可永久有效"，与 §7 #5 的结论相反。
   *    它在 `finally` 里一定会被清掉，所以不会延长进程寿命（铁律 4 想保的东西没丢）。
   */
  async function askHumanToDelete({ abs, snapshot, method }) {
    // 把对话框规整成一个**永不 reject** 的 promise：① 宿主抛错 = 没得到同意（不是同意）；
    // ② 超时之后才 reject 的 promise 必须有人接住，否则是 unhandledRejection。
    const dialog = Promise.resolve()
      .then(() => host.confirmDelete(abs, { snapshot }))
      .then(
        (answer) => (answer && answer.choice === 'delete'
          ? CONFIRM_ACCEPTED
          : { choice: (answer && answer.choice) || 'dismissed' }),
        (err) => ({ choice: 'error', error: err?.message ?? String(err) }),
      )

    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(CONFIRM_TIMED_OUT), deleteConfirmTimeoutMs)
    })

    let answer
    try {
      answer = await Promise.race([dialog, timeout])
    } finally {
      clearTimeout(timer)
    }

    if (answer === CONFIRM_TIMED_OUT) {
      throw new BridgeError(ERR.TIMEOUT,
        `the delete of ${baseNameOf(abs)} was not confirmed within ${deleteConfirmTimeoutMs}ms; `
        + 'the permission is void and nothing was deleted — a late confirmation will NOT be '
        + 'honoured, ask again if the delete is still wanted',
        {
          method,
          file: canonicalPath(abs),
          reason: 'confirm-timeout',
          timeoutMs: deleteConfirmTimeoutMs,
          mayHaveApplied: false,
          retryable: true,
        })
    }
    if (answer === CONFIRM_ACCEPTED) return

    // 取消 / 关闭 / 宿主抛错 / 不认识的形状 —— 一律"没得到明确的删除同意"。
    throw new BridgeError(ERR.DECLINED,
      `the delete of ${baseNameOf(abs)} was not confirmed; nothing was deleted`,
      {
        method,
        file: canonicalPath(abs),
        choice: answer?.choice ?? null,
        mayHaveApplied: false,
      })
  }


  /**
   * vscode.events.subscribe（E3）
   * params: { type?|types?, files?, textMode?, windowId?, sessionId?, consumer? }
   * result: { ok, subscriptionId, streamEpoch, startSeq, cursor{...}, subscription{...} }
   *
   * 这里再判一次 `assertTrusted` 不是多余：工作区不受信任时，连"哪个文件在什么时刻变了"
   * 都不该说 —— 事件带文件名与正文，比一次显式读取更容易被当成"背景噪音"放过。
   * 它是**观察**能力（不进 `WRITE_METHODS`），所以没有 grant 要求、不走 grantGate。
   */
  async function subscribeEvents(params, ctx) {
    assertTrusted('vscode.events.subscribe')
    return eventBroker.subscribe(params, ctx)
  }

  /**
   * vscode.events.unsubscribe（E3）
   * params: { id: string }
   * result: { ok, unsubscribed:boolean, subscriptionId:string|null, streamClosed:boolean }
   *
   * `unsubscribed:false` 是合法结果（幂等），不是错误：重复退订、或流已经因为缺口被
   * 对端关掉时，再退一次本来就该是"没有可退的"。
   */
  async function unsubscribeEvents(params, ctx) {
    // 只豁免本连接已存在订阅的清理；未知/越权/畸形请求仍走原有 trust 门。
    if (!eventBroker.canRelease(params, ctx)) assertTrusted('vscode.events.unsubscribe')
    return eventBroker.unsubscribe(params, ctx)
  }

  const handlers = {
    'vscode.openFile': openFile,
    'vscode.getSelection': getSelection,
    'vscode.getDiagnostics': getDiagnostics,
    'vscode.listOpenEditors': listOpenEditors,
    'vscode.applyEdit': applyEdit,
    'vscode.getDocumentState': getDocumentState,
    'vscode.save': save,
    'vscode.deleteFile': deleteFile,
    'vscode.events.subscribe': subscribeEvents,
    'vscode.events.unsubscribe': unsubscribeEvents,
  }

  /**
   * 统一分派入口 —— 交给协议层当 onRequest。
   * 未实现的方法回 -32005（不是 -32601）：让 DSH 侧能区分「对端不支持」与「协议层方法不存在」，
   * 前者应降级、后者是编程错误。
   *
   * 三道门的顺序（契约 §6.1 / §6.1.1 ②）：
   *   ① 方法存在与否 → ② 工作区信任（-32006）→ ③ 绑定门（-32010）→ handler。
   * 信任排在建前面：工作区不受信任时连"你的凭证对不对"都不该讨论（一律不暴露能力）。
   * `ctx` 是协议层的消息上下文（含 `link` = 承载这条请求的连接实例），绑定门判的就是它的**对象身份**。
   */
  async function dispatch(method, params, ctx) {
    const handler = handlers[method]
    if (!handler) {
      throw new BridgeError(ERR.UNSUPPORTED, `capability not implemented: ${method}`, { method })
    }
    // unsubscribe 仅撤销本连接的观察；不能因 trust 丢失而阻止资源释放。
    if (method !== 'vscode.events.unsubscribe' || !eventBroker.canRelease(params, ctx)) assertTrusted(method)
    grantGate(method, params, ctx)
    return handler(params, ctx)
  }

  // 事件 broker 的出口（E3）：`vscode` 宿主的 `createDispatcher` 不归本卡改，
  // 所以经 `dispatch` **函数对象**这个既有出口交出去，connector 用
  // `deps.dispatch?.eventBroker` 取。这是唯一既能不动禁区文件、又保持
  // "登记簿只有一本"的通道 —— 另建一个 broker 等于两份判据，迟早漂移。
  dispatch.eventBroker = eventBroker

  return { dispatch, handlers, CAPABILITIES, eventBroker }
}

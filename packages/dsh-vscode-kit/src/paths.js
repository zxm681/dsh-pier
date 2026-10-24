/**
 * 路径形态的**唯一出口**（T60）。
 *
 * ## 为什么要有这个文件
 *
 * 真机验证抓到的缺陷：消费者把 `vscode.listOpenEditors` 返回的 `file` **原样**写进
 * `subscribe({ files })`，然后一条事件都收不到，且没有任何报错。根因是同一个文件在两条
 * 管线上是**两串不同的字节**：
 *
 *  - RPC 出口（`listOpenEditors` / `getSelection` / `getDiagnostics` / `applyEdit` …）
 *    走本文件的 `canonicalPath`（历史上它是 bridge `capabilities.js` 里的一个私有函数）
 *    ⇒ Windows 盘符**大写**：`D:/ws/a.js`；
 *  - 事件管线（`editor-events` 的 `payload.file`）直接取宿主给的 `doc.uri.fsPath`
 *    ⇒ 盘符**小写**：`d:/ws/a.js`；
 *  - 过滤比较是 `Array.prototype.includes` 的**精确字符串比较**（`event-subscriptions.js`
 *    的 `accepts()` / 正文门 `bodyAllowed`）⇒ 静默零命中。
 *
 * 结论：路径形态不能有第二个出口。形态规则只能写在一处（本文件），三处共用：
 *  ① 事件过滤（`filter.files`）与 `payload.file`；
 *  ② RPC 返回值（`listOpenEditors` / `getSelection` / `getDiagnostics` / `applyEdit` 的
 *     `documentPath` 等对外可见路径）；
 *  ③ 窗口注册表的指纹键（`windows.js` 的 `normalizeRoot`）。
 *
 * ## canonical 形态（对外可见 + filter 比较口径）
 *
 *  - `win32`：盘符字母**大写**（`D:` / `C:`）；**其余字节原样保留**（段名大小写、
 *    分隔符都不动）—— 分隔符与段名在两侧本来就来自同一个宿主调用（`host.listEditors`
 *    与 `doc.uri.fsPath`），是同一串字节，不需要也不该被改写；
 *  - 其它平台：**原样返回**（POSIX 没有盘符，且区分大小写）。
 *
 * ## 为什么只统一盘符大小写
 *
 * 盘符是**唯一被两条管线各自改写过的字节**，所以它是失配的根因；只改它，对外输出的变化面
 * 最小（对既有消费者是**纯利好**：以前拿到大小写两种写法的调用方现在只拿到一种）。
 * 「段名大小写」在 NTFS 上是同一文件的不同拼写，但那属于**身份**问题（写锁、去重），
 * 不是**对外形态**问题 —— 那件事由下面的 `pathIdentityKey` 负责。两件事分开命名，
 * 免得哪天有人为了修锁把对外路径整体折成小写（在大小写敏感的卷上那是真的写错文件）。
 */

/** `c:` / `d:` 这类小写盘符前缀（只认 win32 语义）。 */
const LOWERCASE_DRIVE = /^[a-z]:/

/**
 * 对外可见路径的规范形态（见文件头）。幂等：`canonicalPath(canonicalPath(p)) === canonicalPath(p)`。
 *
 * @param {any} p 原始路径（非字符串原样返回，方便直接嵌进 mapper 而不用先判类型）
 * @param {NodeJS.Platform} [platform] 平台口径。**显式参数是为了可测**：只有在 Windows 上
 *   才需要"盘符大写"，测试不该因此变成"只能跑在 Windows 上"。
 * @returns {any}
 */
export function canonicalPath(p, platform = process.platform) {
  if (typeof p !== 'string') return p
  if (platform !== 'win32' || !LOWERCASE_DRIVE.test(p)) return p
  return p[0].toUpperCase() + p.slice(1)
}

/**
 * **身份键**：同一个文件的不同拼写必须落到同一个键（写锁、串行化、去重用）。
 *
 * 与 `canonicalPath` 的区别是语义而不是风格：
 *  - `canonicalPath` 回答「对外该怎么写这个路径」—— 输出里不许多出第二种写法；
 *  - `pathIdentityKey` 回答「这两个字符串是不是同一个文件」—— 允许（并且必须）折叠
 *    那些**不改变文件身份**的差异。
 *
 * 归一策略**按平台**，不许无条件折小写（这是 T33 实测出来的）：
 *  - `win32`：整体 `toLowerCase()`。NTFS 默认不区分大小写，`a.txt` 与 `A.TXT` 本来就是
 *    同一个文件；不折就必然出现两条并发链，双双通过前置版本检查（锁被别名绕过）。
 *  - 其它平台：**原样返回**。ext4/xfs **区分**大小写，`a.txt` 与 `A.TXT` 是两个文件：
 *    无条件下折会把两个本来可以并行写的文件误伤成串行。
 *
 * @param {any} p
 * @param {NodeJS.Platform} [platform]
 * @returns {any}
 */
export function pathIdentityKey(p, platform = process.platform) {
  const canonical = canonicalPath(p, platform)
  if (typeof canonical !== 'string') return canonical
  return platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * 一段已 `trim` 过的路径是否满足 `filter.files` 的形状约束（与形态无关的那部分校验）。
 * 放在这里只是为了让「什么算一个可用的文件白名单条目」也只有一份说法。
 *
 * @param {any} text
 * @param {number} maxChars
 * @returns {boolean}
 */
export function isUsableFilterPath(text, maxChars) {
  return typeof text === 'string'
    && text !== ''
    && text.length <= maxChars
    && !text.includes('\u0000')
}

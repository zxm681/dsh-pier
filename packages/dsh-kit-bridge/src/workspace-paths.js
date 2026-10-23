/**
 * 工作区内**真实**文件路径解析 —— `vscode.applyEdit` 的唯一入口守卫。
 *
 * 为什么单独一个文件：路径安全是写入类能力最容易被绕过的一环，
 * 它必须能被单测穷举（符号链接 / 目录穿越 / 盘符大小写 / 相对路径……），
 * 而 `vscode` API 那半边只能真机验。把纯逻辑抽出来，测试才不是摆设。
 *
 * 规则（契约 §6.1.1 ③ 的配套约束，DSH 侧不重复判）：
 *
 *  0. **单根**：工作区根不是恰好一个 → **拒绝写入**（契约 :288 禁多根写入）。
 *     不搞「匹配到哪个根就写哪个」—— 多根下同一个相对路径可能指向两个窗口里
 *     两个不同的文件，而 grant 只绑一个窗口。
 *  1. 只接受**工作区内**的路径 —— 按**路径段**比较，不做字符串前缀比较
 *     （`/ws-evil` 不能因为 `/ws` 是前缀就过关）。
 *  2. 只接受**真实**路径：从**可信卷根**到目标文件的**整条链**逐段 `lstat`，
 *     任何一段是 symlink / junction（Windows 的 junction 在 Node 眼里也是 symlink）
 *     → **直接拒**（`-32602`）。链包括**工作区根本身与根的所有祖先**：
 *     根是 junction 时，`D:\ws → C:\secret` 会让「工作区内」这个前提本身失效。
 *  3. **`realpath(根)` 不许用来重新定义「允许的物理根」**（评审 F1 的漏洞成因：
 *     `realpath` 把 junction 的目标当成了新根，于是链接根反而一路放行）。
 *     `realpath` 只用于**校验**：规范化之后必须仍在**字面根**之内，且逐段段名
 *     必须与字面段名一致（不一致 = 8.3 短名 / 其它别名玩法 → 拒）。
 *     本函数的 `root` 返回值就是**字面根**（已证明链上无链接），不是 realpath 的产物。
 *  4. 证明不了根安全就**失败闭合**：任何拒绝路径都不得触碰写宿主（由调用方保证
 *     「先 resolve 再 applyEdit」，本函数绝不 `stat` 之外的副作用）。
 *  5. 文件必须存在（不新建 —— 新建是 T4 的活）。
 *
 * ⚠️ **本模块能证明什么、不能证明什么**（评审 R2-1 ③——照实写，别当成已解决）：
 *
 *  - 能证明：**在检查的那一刻**，这个路径确实是工作区内一个真实文件，链上没有任何
 *    reparse point（symlink / junction），且 realpath 与字面路径逐段同名。
 *  - **不能证明**：从检查到写入之间它没被换掉。
 *    `同用户进程在检查与写入之间替换 reparse point 属于本模块无法原子防护的窗口`
 *    —— 目录级的 reparse point 是**按名字**解析的，任何"先看后写"的检查都存在这个
 *    时间差；Node 端口也没有 `FILE_FLAG_OPEN_REPARSE_POINT` / 目录句柄锁定这类
 *    内核级手段可用（即使有，"检查用句柄、写入用路径"照样不是同一个对象）。
 *    **本期按威胁模型排除**：能在这个窗口里动手的是**同用户进程**，而它本来就能
 *    直接写那些文件，不需要借道本通道（它拿到的额外收益只是"让 DSH 替它写一次"）。
 *    威胁模型不覆盖的对手（跨用户、跨机器）也用不到这个窗口。
 *  - 本期的补偿措施（**缩小窗口，不是消除窗口**）：
 *    ① 三件事贴着做 —— 算规范化路径 → 读文档形状 → `applyEditText`，中间不放任何
 *      无关的 await；
 *    ② **写前重验**（`revalidateWriteTarget`）：紧贴写宿主调用之前再验一次，
 *      并且**传给宿主的就是刚验过的那一个字符串**（不允许"验 A 传 B"）；
 *    ③ **写后复核**（`assertTargetUnchanged`）：`applyEdit` 返回后对同一路径再取一次
 *      realpath，与写前验过的不一致 → **不报成功**（`-32603`）。
 *      它是**采样，不是写入历史**：只在"采样那一刻观察到差异 / 解析失败"时拒报成功；
 *      **未观测到差异不代表没有发生过替换**（换出去、写完再换回来的 ABA，采样仍看见原路径）。
 *    ④ **写入文档身份复核**（`assertWrittenDocumentIdentity`，评审 R3-1）：判据不再是文件系统，
 *      而是**编辑器报告的文档身份** —— 写宿主返回它实际编辑的那个文档的规范化路径
 *      （`document.uri.fsPath` 之类）。身份与写前验过的 `real` 不一致 → 不报成功。
 *      理由：缓冲区身份是"写到底落在哪个文档"的唯一真值；`realpath` 只能证明"此刻这个
 *      路径指向哪"，证明不了"刚才那次打开打开的是哪个文件"。
 *  - 明确**不做**的：不引 Windows 句柄/`FILE_FLAG_OPEN_REPARSE_POINT`（Node 端口不可用）；
 *    也绝不改成"直接写磁盘"来换取原子性 —— 那会绕过编辑器缓冲区，违反 `saved:false`
 *    契约（用户会丢掉撤销栈、未保存状态，而且写下去的东西和编辑器里的内容不一致）。
 *
 * 坐标与文本校验不在本文件：本文件只管「这个路径能不能写」。
 */

import fsSync from 'node:fs'
import path from 'node:path'

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'

const WIN = process.platform === 'win32'

/** Windows 路径大小写不敏感；Linux/macOS 按字面比较（macOS 的 HFS+ 不展开讨论）。 */
function sameSegment(a, b) {
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Windows 上 `C:\a` 与 `c:\a` 是同一个位置。 */
function normalizeForCompare(p) {
  return WIN ? p.toLowerCase() : p
}

/**
 * `child` 是否在 `parent` 之内（含相等）。
 * 按路径段比较，所以 `/ws-evil/x` 不在 `/ws` 之内。
 */
export function isInside(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  if (normalizeForCompare(c) === normalizeForCompare(p)) return true
  const rel = path.relative(p, c)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  // 相对路径以 .. 开头 = 跑出去了
  const first = rel.split(path.sep)[0]
  return first !== '..' && !sameSegment(first, '..')
}

function outsideError(method, p, detail) {
  return new BridgeError(ERR.INVALID_PARAMS,
    `path is not a real file inside the workspace: ${p}`, { method, path: p, reason: detail })
}

/**
 * 把路径拆成「卷根 + 段」。
 *
 * 卷根本身不可能是链接（`C:\` / `\\server\share\` 是内核挂载点，不是可替换的链接体），
 * 所以链从卷根**之下**的第一段开始走；卷根这一段由操作系统保证。
 */
function splitAtVolume(target) {
  const abs = path.resolve(target)
  const vol = path.parse(abs).root
  const rel = path.relative(vol, abs)
  return { abs, vol, segments: rel === '' ? [] : rel.split(path.sep) }
}

/**
 * 从 `from` 起逐段 `lstat`（**不跟随**链接），返回链上第一个链接的绝对路径。
 *
 * 用 `lstat` 而不是 `stat`：junction / symlink 在 `stat` 眼里是目标目录，
 * 正是「看起来一切正常」的那种假安全。
 *
 * @returns {string|null} 第一个链接段的绝对路径；全程干净返回 null
 * @throws {BridgeError} -32003 链上有段不存在；-32603 lstat 其它失败
 */
function firstLinkInChain(fs, from, segments, { method, abs, onMissing }) {
  let cursor = from
  for (const seg of segments) {
    cursor = path.join(cursor, seg)
    let st
    try {
      st = fs.lstatSync(cursor)
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        if (onMissing === 'ignore') return null
        throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
      }
      throw new BridgeError(ERR.INTERNAL, `cannot stat ${cursor}: ${err?.message ?? err}`,
        { method, path: abs })
    }
    if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
      // junction 也走这里（Windows 的 junction 在 Node 里就是 symlink）。
      return cursor
    }
  }
  return null
}

/** realpath 的薄包装：失败按「不存在 / 其它」分流。 */
function realpathOf(fs, p, method, abs) {
  try {
    return fs.realpathSync(p)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
    }
    throw new BridgeError(ERR.INTERNAL, `realpath failed for ${abs}: ${err?.message ?? err}`,
      { method, path: abs })
  }
}

/** `\\?\D:\x` → `D:\x`（长路径前缀只为绕过 MAX_PATH，不改变位置）。 */
function stripLongPrefix(p) {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

/**
 * 解析并校验一个可写路径。
 *
 * @param {string} file            调用方给的路径（绝对或以工作区根为锚的相对路径）
 * @param {string[]} roots         工作区根（`vscode.workspace.workspaceFolders`；必须恰好 1 个）
 * @param {object} [opts]
 * @param {typeof fsSync} [opts.fs] 注入 fs（测试用；默认真 fs）
 * @param {string} [opts.method]    报错里带的方法名
 * @returns {{abs: string, real: string, root: string}} abs=规范化后的对外路径，
 *   real=真实路径（已证明与 abs 逐段同名），root=**字面**工作区根（已证明链上无链接）
 * @throws {BridgeError} -32602 路径不合法/越界/是链接/多根；-32003 文件不存在
 */
export function resolveWorkspaceFile(file, roots, opts = {}) {
  const fs = opts.fs ?? fsSync
  const method = opts.method ?? 'vscode.applyEdit'

  if (typeof file !== 'string' || file.trim() === '') {
    throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
  }
  const list = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r !== '') : []
  if (list.length === 0) {
    // 没有工作区就没有「工作区内」可言 —— 不是调用方的错，所以不是 -32602。
    throw new BridgeError(ERR.INTERNAL,
      'no workspace folder is open; refusing to resolve an editable path', { method })
  }
  if (list.length > 1) {
    // 契约 :288「本阶段禁多根写入」。多根下「工作区内」不是唯一区域，
    // 挑一个根写下去等于替用户选文件 —— 失败闭合比猜更安全。
    throw new BridgeError(ERR.INTERNAL,
      `multi-root workspace (${list.length} folders) is not supported for writes; `
        + 'edit grants bind to exactly one window', { method, reason: 'multi-root', roots: list.length })
  }

  const root = path.resolve(list[0])
  const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(root, file)

  // ── ① 先按字面判断在工作区根之内（后面的 lstat 只在这个根之下走） ──
  if (!isInside(abs, root)) {
    throw outsideError(method, abs, 'outside-workspace')
  }

  // ── ② 根链：工作区**自身 + 所有祖先**逐段 lstat（评审 F1 的核心） ──
  //    这里不用 realpath 判：realpath 会把 junction 的目标当成新根，正好把漏洞放行。
  //    链上有任何链接 → 根不安全 → 拒（不得退化成「解析后仍在内就放行」）。
  const rootChain = splitAtVolume(root)
  if (firstLinkInChain(fs, rootChain.vol, rootChain.segments, { method, abs }) !== null) {
    throw outsideError(method, abs, 'link-root')
  }

  // ── ③ 根之下的每一段：任何一段是链接就拒 ──
  const relSegs = path.relative(root, abs) === '' ? [] : path.relative(root, abs).split(path.sep)
  if (firstLinkInChain(fs, root, relSegs, { method, abs }) !== null) {
    throw outsideError(method, abs, 'symlink')
  }

  // ── ④ 别名校验：realpath 只用来**对照**，不用来定义允许范围 ──
  //    链上无链接时 realpath 只做归一化，**不改**段名语义。下面几条是实测（T33 / T31
  //    复审）钉死的、与直觉相反的事实，别照旧版注释想：
  //      ① 8.3 短名：普通 `fs.realpathSync` 在本机**并不展开**（`PROGRA~1` 原样返回，
  //         只有 `realpathSync.native` 才还原成长名）。短名写法仍然写不进来，但拦住它的
  //         不是本段：长根 + 短路径在 ① 的字面根边界就判 `outside-workspace`，根内混写
  //         则由下面的逐段比对判成段名差异；
  //      ② 符号链接 / junction：③ 的逐段 lstat 已经抛 `reason:'symlink'`，到不了这里；
  //      ③ 卷别名 `\\localhost\C$\…` 不是同一条根链，判 `outside-workspace`。
  //    所以本段只回答一件事：realpath 之后的段名与调用方写法对不上 = 别名 → 拒。
  const real = stripLongPrefix(realpathOf(fs, abs, method, abs))
  const realChain = splitAtVolume(real)
  const absChain = splitAtVolume(abs)
  if (realChain.vol !== absChain.vol
    && !sameSegment(realChain.vol, absChain.vol)) {
    throw outsideError(method, abs, 'alias')
  }
  if (realChain.segments.length !== absChain.segments.length) {
    throw outsideError(method, abs, 'alias')
  }
  for (let i = 0; i < absChain.segments.length; i++) {
    if (!sameSegment(absChain.segments[i], realChain.segments[i])) {
      throw outsideError(method, abs, 'alias')
    }
  }

  // ── ⑤ 双保险：真实路径必须仍在**字面根**之内（绝不与 realpath(根) 比） ──
  if (!isInside(real, root)) {
    throw outsideError(method, abs, 'realpath-escaped')
  }

  let st
  try {
    st = fs.statSync(real)
  } catch {
    throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
  }
  if (typeof st.isFile === 'function' && !st.isFile()) {
    throw outsideError(method, abs, 'not-a-file')
  }

  // root 用**字面根**：它已被证明链上无链接，等价于「可信物理根」；
  // 返回 realpath(根) 会让调用方以为「允许范围由解析结果决定」，那正是 F1 的病根。
  return { abs, real, root }
}

/**
 * 同一个位置吗（用于「写前验过的那个字符串」与「写后再取到的 realpath」比较）。
 *
 * Windows 按大小写不敏感比较（`C:\a` 与 `c:\a` 是同一个文件）；其它平台字面比较。
 * 这不是安全检查本身，只是把两个已经规范化的字符串对上号 —— 真正的安全前提是
 * 两次取值都出自本文件的 `resolveWorkspaceFile` / `realpathSync`，没有第三方参与拼接。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/**
 * **写前重验**（评审 R2-1 ②）——紧贴写宿主调用的那一次检查。
 *
 * 为什么还要再验一次：`resolveWorkspaceFile` 之后有一次 `await host.readDocumentShape()`
 * （打开文档、可能等 VS Code 加载文本），那是一个真实的让出点，目录可以在其间被换成
 * junction。所以窗口至少缩到"重验 → applyEdit"之间那一次同步调用。
 *
 * 返回值的语义是**这次的结论**：调用方必须把返回的这个字符串交给写宿主
 * （不许沿用第一次的 `real`，也不许自己再拼一次路径）—— "验一个字符串、传另一个"
 * 是这类修复最常见的退化形式。
 *
 * 不一致时返回什么：拒绝。理由用 `path-changed` 而不是把 `resolveWorkspaceFile` 的
 * 具体原因（symlink / outside-workspace）直接透出 —— 对调用方而言这是"你要写的那个位置
 * 已经不是我们刚验证过的位置了"，而不是"你的参数不合法"。
 *
 * @param {{abs: string, real: string}} checked 第一次 `resolveWorkspaceFile` 的结果
 * @param {string[]} roots 工作区根（原样再传一次）
 * @param {{fs?: typeof fsSync, method?: string}} [opts]
 * @returns {string} **刚刚验过**的规范化路径（交给写宿主的就应该是它）
 * @throws {BridgeError} -32602 路径已不再是原来那个合法目标（含中途变链接）
 */
export function revalidateWriteTarget(checked, roots, opts = {}) {
  const method = opts.method ?? 'vscode.applyEdit'
  let again
  try {
    again = resolveWorkspaceFile(checked.abs, roots, opts)
  } catch (err) {
    // 第一次能过、第二次过不去：几乎只能是"这中间被换了"。原样抛出会报 symlink /
    // outside-workspace —— 那是**现状**的描述，不是"发生了什么"的描述。
    if (err instanceof BridgeError) {
      throw new BridgeError(
        err.code,
        `editable path changed between validation and write: ${checked.abs} `
        + `(${err.message})`,
        { method, reason: 'path-changed', path: checked.abs, previous: checked.real },
      )
    }
    throw err
  }
  if (!samePath(again.real, checked.real)) {
    throw new BridgeError(
      ERR.INVALID_PARAMS,
      `editable path now resolves somewhere else: ${checked.real} → ${again.real}`,
      { method, reason: 'path-changed', path: checked.abs, previous: checked.real, current: again.real },
    )
  }
  return again.real
}

/**
 * **写后复核**（评审 R2-1 ③）——`applyEdit` 返回之后，对**同一个字符串**再取一次 realpath。
 *
 * 这一步不阻止任何事：写入已经发生了（可能已经落在被换掉的目录里）。它做的事只有一件：
 * **采样到差异（或解析失败）就不报成功** —— 报成功等于告诉调用方"内容写进了你验过的那个
 * 文件"，而我们此刻已经无法这样断言。所以宁愿把它变成一个明确的失败（调用方得到"写可能
 * 没落在你以为的地方，请人工核实"）。
 *
 * ⚠️ **它不是完整保证**（评审 R3-1）：这是**采样**，不是写入历史。目录在写入期间被换出去、
 * 写完又换回来（ABA）时，这里看到的仍是原路径 —— 于是"未观察到差异"≠"没被替换过"。
 * 真正决定"写落到哪个文档"的判据是编辑器报告的文档身份（见
 * `assertWrittenDocumentIdentity`）；本函数保留是因为它成本低、且能挡住"替换一直持续到
 * 采样"这类情况。**任何注释/文档都不许再把它写成"不会静默成功"的完整保证。**
 *
 * 为什么用 `-32603` 而不是 `-32602`：`-32602`（INVALID_PARAMS）的语义是**调用方参数
 * 错了，改参数再试**。这里调用方什么都没做错，重试还可能再中一次同一个竞态；正确的
 * 处置是"停下来、报告、别重试"—— 那是内部/环境故障（`-32603`）的语义。注释写在这里，
 * 免得下次有人"顺手统一成 -32602"。
 *
 * @param {string} validatedPath 写前重验返回、并**原样交给了写宿主**的那个字符串
 * @param {{fs?: typeof fsSync, method?: string}} [opts]
 * @returns {string} 复核通过的 realpath（与入参等价）
 * @throws {BridgeError} -32603 路径已变 / 已无法解析（都不许报成功）
 */
export function assertTargetUnchanged(validatedPath, opts = {}) {
  const fs = opts.fs ?? fsSync
  const method = opts.method ?? 'vscode.applyEdit'
  let now
  try {
    now = stripLongPrefix(realpathOf(fs, validatedPath, method, validatedPath))
  } catch (err) {
    // 连 realpath 都拿不到（被删/被换/被锁）：同样不能报成功。原错误只进 message。
    throw new BridgeError(
      ERR.INTERNAL,
      `cannot re-verify the written path after applyEdit: ${validatedPath} `
      + `(${err?.message ?? err})`,
      { method, reason: 'path-changed-after-write', path: validatedPath },
    )
  }
  if (!samePath(now, validatedPath)) {
    throw new BridgeError(
      ERR.INTERNAL,
      `the path that was written is not the path that was verified: `
      + `${validatedPath} → ${now}`,
      { method, reason: 'path-changed-after-write', path: validatedPath, current: now },
    )
  }
  return now
}

/**
 * **写入文档身份复核**（评审 R3-1 换掉的判据）—— 写宿主必须报出它**实际编辑的那个文档**的
 * 规范化路径，本函数把它与"写前验过、并原样交给宿主"的那个 `real` 比对。
 *
 * 为什么换判据：写后 re-realpath（`assertTargetUnchanged`）只能证明"此刻这个路径指向哪"，
 * 证明不了"刚才那次编辑落到哪个文档"。评审的 ABA 复现正是这样把两步都骗过去的 ——
 * 检查时是好的 → 宿主调用瞬间路径是 junction（写到工作区外）→ 立刻换回 →
 * 写后再取 realpath 又看见原路径。**文件系统没有记忆，缓冲区身份有。**
 *
 * 契约（写宿主适配器的义务）：`host.applyEditText()` 返回
 * `{ applied: boolean, documentPath?: string|null }`，其中 `documentPath` 是编辑器对这个
 * 文档的规范化路径（VS Code 里即 `document.uri.fsPath`）。
 *
 *  - 报不出来（字段缺失 / 不是非空字符串）→ **失败闭合**，`-32603`
 *    `document-identity-unavailable`。理由：连"写到哪个文档"都确认不了，就不许报成功；
 *    这时不能说"没写成功"，只能说"结果未知，请人工核实"，所以带 `mayHaveApplied: true`。
 *  - 报出来但与写前验过的不一致 → `-32602` `document-identity-mismatch`（编排者裁决：
 *    这是"你要写的那个位置已经不是验证过的那个文档了"，不是一个可以当成成功的业务结果）。
 *  - 两者都带 `retryable: false`：重试可能再中同一个竞态，正确的处置是停下来报给人。
 *
 * @param {{applied?: boolean, documentPath?: string|null}|null|undefined} outcome 写宿主返回值
 * @param {string} validatedPath 写前重验返回、并原样交给写宿主的那个字符串（`real`）
 * @param {{method?: string}} [opts]
 * @returns {string} 编辑器报告的文档身份（已去长路径前缀）
 * @throws {BridgeError} -32603 拿不到文档身份；-32602 文档身份与验证路径不一致
 */
export function assertWrittenDocumentIdentity(outcome, validatedPath, opts = {}) {
  const method = opts.method ?? 'vscode.applyEdit'
  const reported = outcome?.documentPath
  if (typeof reported !== 'string' || reported.trim() === '') {
    throw new BridgeError(
      ERR.INTERNAL,
      'cannot confirm which document was written: the editor adapter did not report '
      + `a document path for ${validatedPath}; the edit may already be applied — verify by hand`,
      {
        method,
        reason: 'document-identity-unavailable',
        path: validatedPath,
        hostField: 'documentPath',
        mayHaveApplied: true,
        retryable: false,
      },
    )
  }
  const identity = stripLongPrefix(reported)
  if (!samePath(identity, validatedPath)) {
    throw new BridgeError(
      ERR.INVALID_PARAMS,
      `the document that was written is not the path that was verified: `
      + `${validatedPath} → ${identity}`,
      {
        method,
        reason: 'document-identity-mismatch',
        path: validatedPath,
        writtenDocument: identity,
        mayHaveApplied: true,
        retryable: false,
      },
    )
  }
  return identity
}

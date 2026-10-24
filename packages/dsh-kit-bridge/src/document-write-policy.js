/**
 * 逐文件失败闭合的写许可（A2 / T62）：把「来源不明」这一种失败单独拎出来，
 * 并且**只冻结那一个文件**。
 *
 * ## 这份模块存在的理由（先读，再改）
 *
 * A1 的 `change-ledger.js` 是**证据层**：它回答"这次增量是不是我造成的"，回执里带
 * `attribution`。它**故意不判许可** —— 证据只有四种取值，而"该不该让它写"是另一个问题。
 * 本模块就是那个问题的唯一答案处。
 *
 * A2 之前，"缓冲区是脏的"被当成**一种**失败，混在 `-32012 document-version-conflict` 里
 * （`reason:'buffer-dirty'`），靠调用方传 `params.allowDirtySave` 放行。三个问题：
 *
 *  ① **处置错了**。`-32012` 的合同是"重读锚点、用新版本**重发**"；而"缓冲区里有别人的
 *     内容"这件事**重发多少次都还在**。消费者照合同自动重试，等于拿旧镜像反复覆盖人工修改。
 *  ② **许可的位置错了**。`params.allowDirtySave` 是**调用方自己**在业务请求里传的，
 *     等于"我声明我不脏"就真能过 —— 授权表里根本没这条记录。
 *  ③ **粒度错了**。脏缓冲区是**某一个文件**的状态，一个文件脏就停掉整个窗口的写入，
 *     会把不相干的干净文件一起拖下水。
 *
 * 所以本模块给三条硬约定（每条都有用例，见 `test/document-write-policy.test.js`）：
 *
 *  - **逐文件**（per-file）：状态按「真实路径 + 文档实例（incarnation）」记，A 脏不挡 B；
 *  - **只紧不松**（fail-closed）：没有观察能力 → `unknown` → 拒写，**永不包括默认放行**；
 *  - **不可洗白**（monotonic taint）：一旦看到过非桥接增量，**重读锚点、`isDirty` 变 false、
 *    重开文档、机器自动换 grant 都清不掉**，只有人明确交接并**新建 grant 基线**才行。
 *
 * ## 两个门 + 最后一次本地复核（位置就是合同，见 4.7）
 *
 *  - `judge()` 在**同文件写队列内**先判一次（早拒，宿主零调用）；
 *  - `construct()` 由 `edit-transaction.js` 在**构造 builder 的同步区间**里再判一次
 *    —— 那里是唯一"从判定到落笔"之间没有 await 的区间，窗口最小；
 *  - `judge()` 在 `doc.save` **紧前**再判一次（save 没有同步区间可挂，只能缩小窗口，
 *    **不承诺强 CAS**）。
 *
 * 判定顺序即语义：本模块只做**加法**，永远在既有七行 grant 判序、双锚点、白名单档位
 * **之后**判 —— 它绝不放宽任何既有判定。
 */

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'
import { ATTRIBUTION } from './change-ledger.js'

/** `-32011` 的 `data.reason`（五选一，处置各不相同；抄自契约 4.7，别自己加第六个）。 */
export const WRITE_POLICY_REASONS = Object.freeze({
  /** 观察到不是本 grant 写入引起的变更（人 / 别的扩展 / 别的窗口）。 */
  FOREIGN_CHANGE: 'foreign-change',
  /** 本端写入窗口里混进了别人的增量（账本判 mixed）。 */
  MIXED_ORIGIN: 'mixed-origin',
  /** 缓冲区有脏内容，但本端证不出那是自己写的（含实例已换）。 */
  ATTRIBUTION_UNKNOWN: 'attribution-unknown',
  /** 没有同源变更观察器 / 账本被关掉 —— 看不见别人不等于没有别人。 */
  OBSERVATION_GAP: 'observation-gap',
  /** 脏缓冲区在没有 grant 级许可时要求写盘/归档（或归档本身要求干净基线）。 */
  DIRTY_QUARANTINE: 'dirty-quarantine',
})

const REASON_VALUES = Object.freeze(Object.values(WRITE_POLICY_REASONS))

/** 受本门管辖的三个写方法（rename 不在其列：它不是文档写，见 C1/T40）。 */
export const WRITE_POLICY_METHODS = Object.freeze([
  'vscode.applyEdit',
  'vscode.save',
  'vscode.deleteFile',
])

/** 本门唯一产生的错误：`-32011 document-dirty`。数据形状抄自契约 4.7。 */
export function documentDirtyError({
  method, file, reason, isDirty, attribution, version, incarnation, taint = null,
  mayHaveApplied = false,
}) {
  if (!REASON_VALUES.includes(reason)) {
    throw new TypeError(`documentDirtyError: 未知 reason ${String(reason)}`)
  }
  return new BridgeError(
    ERR.DOCUMENT_DIRTY,
    `refusing to write: the buffer of ${file} contains changes this bridge cannot attribute `
      + `(reason: ${reason}). Re-reading the document anchors does not clear this; a human must `
      + `inspect the file and a fresh grant must establish a clean baseline. Nothing was written.`,
    {
      method,
      file,
      reason,
      isDirty: isDirty === true,
      attribution: attribution ?? ATTRIBUTION.UNKNOWN,
      version: version ?? null,
      incarnation: incarnation ?? null,
      retryable: false,
      recovery: 'human-rebase',
      // 本门只在**调用写入宿主之前**拒绝（含 save 紧前的那次复核），所以这条永远是 false；
      // 写后才发现的变化**不许**回头补一个 -32011（见模块头注释与 4.7）。
      mayHaveApplied: mayHaveApplied === true,
      ...(taint ? { taint: { reason: taint.reason, at: taint.at ?? null } } : {}),
    },
  )
}

/** 文件键归一：真实路径 + （可能为空）文档实例。taint 按「真实连接 + 文档实例」记。 */
function keyOf(fileKey, incarnation) {
  const base = String(fileKey ?? '')
  // ★ 归一化**必须**在这里做，而且只有这一处。
  //   能力层判许可时用的是 `serializeKeyFor(real)`（`pathIdentityKey`：折大小写），
  //   而观察器事件里带的是宿主的**原始**路径（可能是另一种大小写、另一种分隔符）。
  //   两边不归一化就会分成两条状态：事件把 taint 打到 A 键上、判定却在 B 键上查到干净的
  //   —— **门等于不存在**。（变异 M6 就是把这里改成恒等，验证 taint 失效、用例变红。）
  //
  //   分隔符也折一次：`pathIdentityKey` 只折大小写，不折 `\` 与 `/`；而"同一个文件被两种
  //   写法指到"在多宿主/多平台实现里是真实存在的。往"更容易命中同一条冻结状态"方向归一
  //   是**收紧**（只会多冻结，不会少冻结），失败闭合的方向永远可以走。
  const identity = pathIdentityKey(base)
  void incarnation
  if (typeof identity !== 'string') return base
  return identity.replace(/\\/g, '/')
}

/**
 * 创建写许可门。
 *
 * @param {object} [opts]
 * @param {(level: string, msg: string) => void} [opts.log] 诊断日志
 * @param {number} [opts.maxFiles] 状态上限（逐文件表不许无限长）
 */
export function createWritePolicy(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const maxFiles = Number.isInteger(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : 512

  /** 文件键 → 状态。**这是本模块唯一的状态**，别在别处再存一份。 */
  const files = new Map()

  const stats = {
    judged: 0, refused: 0, allowed: 0, foreignEvents: 0, staleEvents: 0,
    inflightEvents: 0, taints: 0, evicted: 0, firstSights: 0,
  }

  function stateFor(fileKey) {
    const key = keyOf(fileKey, null)
    let st = files.get(key)
    if (st) {
      // LRU：Map 的插入序当最近使用序（重新 set 会挪到末尾）
      files.delete(key)
      files.set(key, st)
      return st
    }
    st = {
      fileKey: key,
      /** 最近一次已知的文档版本（含本端写入后的版本）。 */
      lastVersion: null,
      /** 最近一次已知的文档实例。实例变了 → 旧证据作废（默认 unknown）。 */
      incarnation: null,
      /**
       * 冻结原因。**一旦设置只有 `clearTaint()` 能清**，而 `clearTaint()` 只在
       * 「新建 grant 干净基线」时被调用（见 capabilities 的 grantBaseline 记录）。
       */
      taint: null,
      /** 进行中的本端写操作数（>0 时观察到的变更**可能**是自己引起的）。 */
      inflight: 0,
      /** 进行中的写方法（诊断用）。 */
      inflightMethod: null,
      /** 本端写窗口内到达的事件数（窗口结束后仍 >0 → 归属不可判，由调用方决定）。 */
      windowEvents: 0,
      /** 本端**已证明**为桥接写入造成的脏内容（这是唯一能让"脏也允许写"的证据）。 */
      dirtyOwned: false,
      /** 干净基线：最近一次被判为干净/自己写的版本，`undefined` 表示还没建立。 */
      baselineVersion: undefined,
      baselineIncarnation: undefined,
      /**
       * 基线当时那份内容的指纹（T65）。**只是证据**：`judge()` 从不读它，
       * 它存在是为了让"人工确认的到底是哪一份内容"这件事可回溯。
       */
      baselineContentHash: undefined,
    }
    files.set(key, st)
    while (files.size > maxFiles) {
      const oldest = files.keys().next().value
      files.delete(oldest)
      stats.evicted += 1
    }
    return st
  }

  function taint(fileKey, reason, extra = {}) {
    const st = stateFor(fileKey)
    if (!st.taint) stats.taints += 1
    // 先到的原因优先保留（foreign-change 比后来的 attribution-unknown 信息更多）；
    // 但**不允许**后来者把已有 taint 清成 null。
    const keep = st.taint && st.taint.reason === WRITE_POLICY_REASONS.FOREIGN_CHANGE
      ? st.taint.reason
      : (st.taint?.reason ?? reason)
    st.taint = {
      reason: keep,
      at: st.taint?.at ?? Date.now(),
      version: extra.version ?? st.lastVersion ?? null,
      incarnation: extra.incarnation ?? st.incarnation ?? null,
      note: st.taint?.note ?? extra.note ?? null,
    }
    st.dirtyOwned = false
    return st.taint
  }

  /**
   * 观察器送来的变更。**这里只累积证据，不判许可**。
   *
   * 归属规则（保守）：
   *  - `version <= lastVersion`：**迟到事件**（本端上一次写入自己的回声）→ 不 taint。
   *    这一条是必需的：VS Code 的事件相对 Promise 可能晚到，晚到的自家事件若被当成
   *    别人的增量，每一个正常的 `applyEdit` 都会把自己的文件冻结掉。
   *  - 有本端写在进行（`inflight > 0`）：**可能**是自己的 → 计数，交给 settle 判归属；
   *    窗口内混进别人的增量由账本判 `mixed`，本模块不抢这个判断。
   *  - **首次旁观**（本端从没见过这个文件的版本，`lastVersion === null`）：只按当次读到的新鲜
   *    锚点落基线，**不**判 `foreign-change`（[2026-10-24 修订]，见下面的长注释）。
   *  - 其余（无进行中写入、版本确实往前走）：**没有在飞的本端写入却能变** → 来源不明 → taint。
   */
  function noteChange(sample) {
    const fileKey = sample?.file ?? sample?.documentPath ?? sample?.fileKey
    if (fileKey === undefined || fileKey === null) return { classified: 'not-a-file' }
    const st = stateFor(fileKey)
    const version = Number.isInteger(sample?.version) ? sample.version : null
    const incarnation = typeof sample?.incarnation === 'string' ? sample.incarnation : null

    // 实例换了：旧证据作废（同 version 不同实例 = 关掉重开，内容来源不可判）。
    if (incarnation && st.incarnation && incarnation !== st.incarnation) {
      taint(fileKey, WRITE_POLICY_REASONS.ATTRIBUTION_UNKNOWN, {
        incarnation, version, note: 'incarnation-changed',
      })
    }
    if (incarnation) st.incarnation = incarnation

    if (st.inflight > 0) {
      st.windowEvents += 1
      stats.inflightEvents += 1
      if (version !== null) st.lastVersion = version
      return { classified: 'inflight' }
    }

    // ★ [2026-10-24 修订] 首次旁观即建基线：**不允许**把"本端没见过这个版本"读成
    //   "没有人写却变了"。冷启动时 `lastVersion` 是 `null`，而 VS Code 里任何既有文档
    //   （`version > 1`）的**第一次**被观察都会被上面那条推断命中 —— 于是整份文件永久冻结，
    //   每次重启 DSH 重新发生一遍。真机三次复现：`work/a2-probe.json`（B-clean.txt
    //   `isDirty:false`/`version:5`/磁盘 sha 未变，仍然 `-32011 foreign-change`；
    //   taint 时间戳比探针首次写入早 7~15 分钟 ⇒ 冻结来自启动后的第一次观察，不是某次写）。
    //
    //   契约前提本来就写着"首次干净基线必须在同源观察器安装后读取"（见 11.5 / 4.7），
    //   只是此前**没有执行点**（`establishBaseline()` 全仓无生产调用）。这里就是那个执行点：
    //   观察器装好之后读到的第一个锚点 = 这份文档在本进程里的干净基线。
    //
    //   ★ 这不放松任何东西：基线**只记锚点**，不放行——
    //     · 脏缓冲区仍然要 `dirtyOwned === true`（账本证明是本端写的），没证明就拒；
    //     · 归档仍然要求干净基线；
    //     · 之后任何"版本往前走但没有在飞的本端写入"照旧 taint（见下面的分支）。
    if (st.lastVersion === null) {
      stats.firstSights += 1
      if (version !== null) {
        st.lastVersion = version
        st.baselineVersion = version
      }
      st.baselineIncarnation = st.incarnation
      return { classified: 'baseline' }
    }

    if (version !== null && st.lastVersion !== null && version <= st.lastVersion) {
      stats.staleEvents += 1
      return { classified: 'stale' }
    }
    if (version !== null) st.lastVersion = version
    stats.foreignEvents += 1
    taint(fileKey, WRITE_POLICY_REASONS.FOREIGN_CHANGE, { version, incarnation })
    log('warn', `write-policy: foreign change observed on ${fileKey} (v=${String(version)}) → frozen`)
    return { classified: 'foreign' }
  }

  /**
   * 明确的"这就是来源不明"标记（由调用方在**直接观测到**别人的增量时用）。
   *
   * 与 `noteChange` 的区别：`noteChange` 是从事件流**推断**归属（所以有迟到事件要忽略），
   * 这里是调用方手里已经拿着"保存后仍然是脏的"这类直接证据 —— 不需要推断，也不许被
   * "版本没变"的迟到规则挡掉（保存不涨版本号）。
   */
  function markForeign(fileKey, info = {}) {
    return taint(fileKey, info.reason ?? WRITE_POLICY_REASONS.FOREIGN_CHANGE, info)
  }

  /** 本端写开始（进入写窗口）。 */
  function beginWrite(fileKey, info = {}) {
    const st = stateFor(fileKey)
    st.inflight += 1
    if (st.inflight === 1) {
      st.inflightMethod = info.method ?? null
      st.windowEvents = 0
    }
    return { fileKey: st.fileKey, inflight: st.inflight }
  }

  /**
   * 本端写结束。把账本的**证据**翻译成写许可需要的两条状态：
   *  - `dirtyOwned`：脏内容是不是我写的（`bridge-correlated` / `self-only` 才算）；
   *  - `taint`：别人掺进来了吗（`mixed` → mixed-origin；其余不可判 → 不 taint，
   *    因为"不可判"已经由 `dirtyOwned=false` 表达成"脏则拒"了，多打一层 taint
   *    会把"只是证据还没到"的正常写入永久冻结）。
   */
  function endWrite(fileKey, info = {}) {
    const st = stateFor(fileKey)
    st.inflight = Math.max(0, st.inflight - 1)
    if (st.inflight > 0) return { settled: false, inflight: st.inflight }
    st.inflightMethod = null

    const verdict = info.verdict ?? null
    const attribution = verdict?.attribution ?? null
    const after = verdict?.after ?? info.after ?? null
    if (after && Number.isInteger(after.version)) st.lastVersion = after.version
    if (after && typeof after.incarnation === 'string' && after.incarnation) {
      st.incarnation = after.incarnation
    }

    const windowEvents = st.windowEvents
    st.windowEvents = 0

    if (attribution === ATTRIBUTION.BRIDGE_CORRELATED || attribution === ATTRIBUTION.SELF_ONLY) {
      // 写入被证明是我们自己的：有脏内容也是自己写的 → 允许后续写入/保存。
      st.dirtyOwned = Boolean(after?.dirty === true) || info.dirtyAfter === true
      st.baselineVersion = after?.version ?? st.lastVersion
      st.baselineIncarnation = st.incarnation
      return { settled: true, attribution, dirtyOwned: st.dirtyOwned, windowEvents }
    }
    if (attribution === ATTRIBUTION.MIXED || info.contaminated === true) {
      st.dirtyOwned = false
      taint(fileKey, WRITE_POLICY_REASONS.MIXED_ORIGIN, {
        version: after?.version ?? st.lastVersion,
        note: verdict?.attributionReason ?? null,
      })
      log('warn', `write-policy: mixed-origin write on ${fileKey} → frozen`)
      return { settled: true, attribution, dirtyOwned: false, windowEvents }
    }
    if (windowEvents > 0) {
      // 窗口里来过事件但我们证不出因果（超时/异常/账本不可判）：**不许**当成自己写的。
      st.dirtyOwned = false
      return { settled: true, attribution, dirtyOwned: false, windowEvents }
    }
    if (attribution === ATTRIBUTION.UNKNOWN) {
      st.dirtyOwned = false
    }
    return { settled: true, attribution, dirtyOwned: st.dirtyOwned, windowEvents }
  }

  /**
   * 基线重建（人工交接）。**唯一**能清 taint 的入口。
   *
   * 两个历史阶段（别把 T65 的修订当成"顺手放宽"）：
   *  - T62 以前：只有"新建 grant"这条路径会调它，实际零调用点 → 脏缓冲永远 `-32011`；
   *  - T65：`vscode.rebaseBaseline`（`kit.editing.rebase`）成为**受控调用点** ——
   *    调用方必须交出四元逐字确认（`file` + `version` + `incarnation` + `contentHash`），
   *    扩展侧实测比对通过后才走到这里。
   *
   * ★ `info.dirtyOwned === true` 是**只有那条控制面**才许传的收养位：人工交接的意思是
   *   "现在缓冲区里这份脏内容是**人确认过的**那一条基线"，所以它从此算"已知来源"，
   *   写路径的第 ⑥ 步（`dirtyOwned !== true` → `attribution-unknown`）不再把它当成
   *   来源不明。别处调用一律不传（缺省 `false`），保证"没人确认过的脏"永远进不来。
   *   注意它**不越过**第 ⑤ 步：grant 上没 `allowDirtySave:true` 时，脏缓冲照样拒。
   *
   * 它**不写盘**，也不改 `isDirty`：基线只是"拿哪一份当起点"的记号。
   */
  function establishBaseline(fileKey, info = {}) {
    const st = stateFor(fileKey)
    st.taint = null
    st.dirtyOwned = info.dirtyOwned === true
    st.windowEvents = 0
    st.baselineVersion = info.version ?? st.lastVersion
    st.baselineIncarnation = info.incarnation ?? st.incarnation
    if (info.incarnation) st.incarnation = info.incarnation
    if (Number.isInteger(info.version)) st.lastVersion = info.version
    // 内容指纹只是**证据**（诊断/复核用），不参与判定：`judge()` 一个字节都不读它。
    if (typeof info.contentHash === 'string' && info.contentHash !== '') {
      st.baselineContentHash = info.contentHash
    }
    return {
      fileKey: st.fileKey,
      baselineVersion: st.baselineVersion,
      baselineIncarnation: st.baselineIncarnation,
    }
  }

  /**
   * 判一次写许可（**唯一实现**；三个调用点都用它）。
   *
   * 判序即语义，且**预授权/参数/路径/双锚点都已在前面判过** —— 本门只做加法。
   *
   * @returns {{allowed: true, attribution: string, reason: null}|{allowed: false, reason: string, attribution: string}}
   */
  function judge(input = {}) {
    const {
      method, fileKey, version = null, incarnation = null, isDirty = false,
      grantAllowsDirty = false, hasEvidenceSource = false, phase = 'queue',
    } = input
    stats.judged += 1
    const st = stateFor(fileKey)

    if (Number.isInteger(version)) st.lastVersion = version
    if (typeof incarnation === 'string' && incarnation) {
      if (st.incarnation && st.incarnation !== incarnation) {
        taint(fileKey, WRITE_POLICY_REASONS.ATTRIBUTION_UNKNOWN, {
          incarnation, version, note: 'incarnation-changed',
        })
      }
      st.incarnation = incarnation
    }

    const refuse = (reason, attribution) => {
      stats.refused += 1
      if (st.taint && st.taint.reason !== reason) {
        // 已有冻结原因时以冻结原因为准（它是更早、更硬的证据）
        return { allowed: false, reason: st.taint.reason, attribution: ATTRIBUTION.UNKNOWN }
      }
      return { allowed: false, reason, attribution }
    }

    // ① 已冻结：**脏缓冲区**与**归档**一律不许，且重读锚点/换 grant 不清它。
    //    [2026-10-24 修订] 干净缓冲区（`isDirty !== true`）不受 taint 管，继续走第 ③ 步：
    //    干净意味着缓冲区内容 == 磁盘，那份"别人写进来"的内容已经不在缓冲区里了（被撤销，
    //    或者它本来就已经落成磁盘现状）。此时仍然要过双锚点，而且"别人保存过"另有码位：
    //      · "别人保存过" → `-32013 disk-state-conflict`（`expectedDisk` 锚点）
    //      · "缓冲区变过" → `-32012 document-version-conflict`（`expectedVersion`/`expectedIncarnation`）
    //    真机反例（`work/a2-probe.json`）：冷启动后干净文件 B-clean.txt（`isDirty:false`、
    //    `version:5`、磁盘 sha 未变）被这条"不分干净/脏"的判据永久冻结。收紧的三处不许动：
    //    脏缓冲区仍拒、`deleteFile` 仍要求干净基线、`hasEvidenceSource !== true` 仍拒。
    if (st.taint && (isDirty === true || method === 'vscode.deleteFile')) {
      const attribution = st.taint.reason === WRITE_POLICY_REASONS.MIXED_ORIGIN
        ? ATTRIBUTION.MIXED
        : ATTRIBUTION.UNKNOWN
      return refuse(st.taint.reason, attribution)
    }

    // ② 没有同源观察能力（老宿主 / `changeLedger:false`）：**连"干净基线"都建立不了**
    //    —— 合同要求"首次干净基线必须在同源观察器安装后读取"（4.7）。既然基线不成立，
    //    写许可就不成立：三种写一律拒（含干净缓冲区）。
    //    ★ 这里**不许**写成"看不到别人就当没别人"（那是默认放行）；代价是明确的：
    //      没有 `onDidChangeTextDocument` 的宿主上，本桥接只读。
    if (hasEvidenceSource !== true) {
      return refuse(WRITE_POLICY_REASONS.OBSERVATION_GAP, ATTRIBUTION.UNKNOWN)
    }

    // ③ 干净缓冲区：没有未保存增量，双锚点（version+incarnation）与磁盘锚点已经足够。
    if (isDirty !== true) {
      if (st.dirtyOwned) st.dirtyOwned = false
      stats.allowed += 1
      return { allowed: true, attribution: ATTRIBUTION.UNKNOWN, reason: null, phase }
    }

    // ④ 脏。归档首版要求干净基线：无论有没有许可都拒（T40 的隔离语义不变，只换码）。
    if (method === 'vscode.deleteFile') {
      return refuse(WRITE_POLICY_REASONS.DIRTY_QUARANTINE, ATTRIBUTION.UNKNOWN)
    }

    // ⑤ 脏但没有 grant 级许可：这才是 v1 里 `params.allowDirtySave` 假冒的那一步。
    //    ★ 这里**只**看授权表里的 grant 记录（`grantAllowsDirty`），
    //      **不看** params —— 调用方在业务请求里写的任何位都不算授权。
    if (grantAllowsDirty !== true) {
      return refuse(WRITE_POLICY_REASONS.DIRTY_QUARANTINE, ATTRIBUTION.UNKNOWN)
    }

    // ⑥ 有许可，但这份脏不是**证明过**的自己写的 → 来源不明 → 拒。
    //    首版**没有逃逸口**（4.7）：许可只说明"这个 grant 被授权碰脏缓冲区"，
    //    说明不了"这些脏内容是我写的"。两者都成立才放行。
    if (st.dirtyOwned !== true) {
      return refuse(WRITE_POLICY_REASONS.ATTRIBUTION_UNKNOWN, ATTRIBUTION.UNKNOWN)
    }

    stats.allowed += 1
    return { allowed: true, attribution: ATTRIBUTION.SELF_ONLY, reason: null, phase }
  }

  /**
   * 两个门共用的"判 + 抛"：判不过就抛 `-32011`，判过返回判定结果。
   * 集中在这里是为了让三个调用点的错误形状**逐字一致**（各拼一份必然漂移）。
   */
  function assertWritable(input = {}) {
    const verdict = judge(input)
    if (verdict.allowed) return verdict
    throw documentDirtyError({
      method: input.method,
      file: input.file ?? input.fileKey,
      reason: verdict.reason,
      isDirty: input.isDirty === true,
      attribution: verdict.attribution,
      version: Number.isInteger(input.version) ? input.version : null,
      incarnation: typeof input.incarnation === 'string' ? input.incarnation : null,
      taint: stateFor(input.fileKey).taint,
    })
  }

  function status() {
    return {
      files: files.size,
      stats: { ...stats },
      tainted: [...files.entries()]
        .filter(([, st]) => st.taint)
        .map(([key, st]) => ({ file: key, reason: st.taint.reason, version: st.taint.version })),
    }
  }

  /** 测试与诊断用：读单个文件的状态（**只读**快照，改不到内部）。 */
  function inspect(fileKey) {
    const st = files.get(keyOf(fileKey, null))
    if (!st) return null
    return {
      fileKey: st.fileKey,
      lastVersion: st.lastVersion,
      incarnation: st.incarnation,
      taint: st.taint ? { ...st.taint } : null,
      inflight: st.inflight,
      windowEvents: st.windowEvents,
      dirtyOwned: st.dirtyOwned,
      baselineVersion: st.baselineVersion,
      baselineIncarnation: st.baselineIncarnation,
      baselineContentHash: st.baselineContentHash,
    }
  }

  return {
    noteChange, markForeign, beginWrite, endWrite, establishBaseline,
    judge, assertWritable, status, inspect,
  }
}

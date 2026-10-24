/**
 * T62 / A2：逐文件失败闭合的写许可（`document-write-policy.js`）的决策表与不可洗白性质。
 *
 * 这份文件只测**纯逻辑**（不启服务、不碰端口、不需要假宿主），因为它要钉的东西全是
 * "什么条件下放行、什么条件下拒"，以及"哪些动作**不能**解除冻结"。真实的门位置
 * （同文件队列内 / 构造 builder 的同步区间 / `doc.save` 紧前 / 人工确认后动手前）
 * 在 `test/document-dirty.test.js`、`test/t39-save.test.js`、`test/t40-delete.test.js`
 * 与 `test/edit-attribution.test.js` 里守 —— 那里才看得见"宿主调用次数为 0"。
 *
 * 合同来源：`work/事件流与归属-实施规划.md` 的 4.7（决策表 / 门的位置 / taint 不可洗白 /
 * `allowDirtySave` 迁移）。每条用例的标题都对着表里的一行写。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ERR, ERR_NAME } from '../../dsh-vscode-kit/src/protocol.js'
import { pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'
import { ATTRIBUTION } from '../src/change-ledger.js'
import {
  WRITE_POLICY_REASONS as R,
  WRITE_POLICY_METHODS,
  createWritePolicy,
  documentDirtyError,
} from '../src/document-write-policy.js'

const FILE_A = pathIdentityKey('C:/ws/a.js')
const FILE_B = pathIdentityKey('C:/ws/b.js')
const INC = 'inc-a'
const APPLY = 'vscode.applyEdit'
const SAVE = 'vscode.save'
const DELETE = 'vscode.deleteFile'

/** 一次"本端写"的完整生命周期：开窗口 → 交账本结论 → 关窗口。 */
function ownWrite(policy, fileKey, { attribution = ATTRIBUTION.BRIDGE_CORRELATED, dirty = true, version = 6 } = {}) {
  policy.beginWrite(fileKey, { method: APPLY })
  return policy.endWrite(fileKey, {
    verdict: { attribution, after: { version, incarnation: INC, dirty } },
  })
}

function judge(policy, over = {}) {
  return policy.judge({
    method: APPLY, fileKey: FILE_A, version: 5, incarnation: INC, isDirty: false,
    grantAllowsDirty: false, hasEvidenceSource: true, ...over,
  })
}

/**
 * 造一条**真正的**外部增量：先让策略看见一次这个文件（`from`，首次旁观 → 落基线），
 * 再来一条版本往前、且没有本端写在飞的变更（`to`）→ taint。
 *
 * ★ [2026-10-24 修订] 以前 `noteChange({version:6})` 一步就能造出 taint —— 那正是冷启动
 *   永久冻结的病灶（"本端没见过"被当成"有人偷偷写了"）。现在必须先有基线，"变了"才有意义。
 *   本函数只改各用例的 **setup**；那些用例的断言（"重读 / 换 grant / 脏态变化都不洗白"）没动。
 */
function foreignChange(policy, file = FILE_A, { from = 5, to = 6 } = {}) {
  const first = policy.noteChange({ file, version: from, incarnation: INC, changes: null })
  assert.equal(first.classified, 'baseline', '前置：第一次观察必须落基线，不能直接冻结')
  const change = policy.noteChange({ file, version: to, incarnation: INC, changes: null })
  assert.equal(change.classified, 'foreign', '前置：基线之后的版本前进必须判成外来改动')
  return change
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 常量与错误形状
// ─────────────────────────────────────────────────────────────────────────────

test('T62 常量：三种写方法都在表里，五个 reason 就是合同里那五个', () => {
  assert.deepEqual([...WRITE_POLICY_METHODS], [APPLY, SAVE, DELETE])
  assert.deepEqual(
    Object.values(R).sort(),
    ['attribution-unknown', 'dirty-quarantine', 'foreign-change', 'mixed-origin', 'observation-gap'].sort(),
    '5 个 reason 必须与 4.7 逐字一致（消费者按它决定怎么恢复）',
  )
})

test('T62 错误形状：-32011 + 结构化 data，`retryable:false` / `mayHaveApplied:false` 默认给足', () => {
  const err = documentDirtyError({
    method: SAVE, file: 'C:/ws/a.js', reason: R.DIRTY_QUARANTINE, isDirty: true,
    attribution: ATTRIBUTION.UNKNOWN, version: 3, incarnation: INC,
  })
  assert.equal(err.code, ERR.DOCUMENT_DIRTY)
  assert.equal(err.code, -32011, '必须是 -32011：-32012 的处置是"重读重发"，与本码相反')
  assert.equal(ERR_NAME[err.code], 'document-dirty', '日志/指标里的名字由 ERR_NAME 给（BridgeError.name 恒为类名）')
  assert.equal(err.data.method, SAVE)
  assert.equal(err.data.reason, R.DIRTY_QUARANTINE)
  assert.equal(err.data.retryable, false, '这不是可自动重试的失败')
  assert.equal(err.data.mayHaveApplied, false, '默认就是"还没碰宿主"')
  assert.equal(err.data.recovery, 'human-rebase')
  assert.equal(err.data.isDirty, true)
  // 文本不进 data：脏态拒绝不带任何正文（免得把用户未保存的内容抄进日志/回执）。
  assert.equal(Object.keys(err.data).includes('text'), false)

  // reason 只能是那五个：写错一个字符串就会让消费者拿到无法识别的恢复建议。
  assert.throws(() => documentDirtyError({ method: SAVE, file: 'x', reason: 'dirty' }), TypeError)
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. 决策表（4.7 逐行）
// ─────────────────────────────────────────────────────────────────────────────

test('T62 决策表第 1 行：干净 + 有证据源 → 三种方法全部放行', () => {
  const policy = createWritePolicy()
  for (const method of WRITE_POLICY_METHODS) {
    const verdict = judge(policy, { method })
    assert.equal(verdict.allowed, true, `${method}: 干净基线 + 观察器在 ⇒ 放行`)
    assert.equal(verdict.reason, null)
  }
  assert.equal(policy.status().stats.allowed, 3)
})

test('T62 决策表第 2 行：脏但**已证明是本端写的** + grant 许可 → applyEdit/save 放行，delete 拒', () => {
  const policy = createWritePolicy()
  ownWrite(policy, FILE_A, { attribution: ATTRIBUTION.BRIDGE_CORRELATED })

  const apply = judge(policy, { method: APPLY, isDirty: true, grantAllowsDirty: true })
  assert.equal(apply.allowed, true, 'self-only 的脏 + 授权 ⇒ 可以继续写（仍逐次过双锚点）')
  assert.equal(apply.attribution, ATTRIBUTION.SELF_ONLY)

  const save = judge(policy, { method: SAVE, isDirty: true, grantAllowsDirty: true })
  assert.equal(save.allowed, true, '保存同理（仍要过 expectedDisk 与紧前复核）')

  const del = judge(policy, { method: DELETE, isDirty: true, grantAllowsDirty: true })
  assert.equal(del.allowed, false, '★ 归档比写更紧：首版要求干净基线，连授权也不放行')
  assert.equal(del.reason, R.DIRTY_QUARANTINE)
})

test('T62 决策表第 3 行：脏（哪怕是本端写的）但 grant 没有许可 → 拒（dirty-quarantine）', () => {
  const policy = createWritePolicy()
  ownWrite(policy, FILE_A)
  for (const method of [APPLY, SAVE]) {
    const verdict = judge(policy, { method, isDirty: true, grantAllowsDirty: false })
    assert.equal(verdict.allowed, false, `${method}: 授权表里没有这条许可 ⇒ 拒`)
    assert.equal(verdict.reason, R.DIRTY_QUARANTINE)
  }
})

test('T62 决策表第 3 行（补）：脏、本端写的、授权了 —— 但归属证不出来（未结算/unknown）→ 拒', () => {
  const policy = createWritePolicy()
  // 写窗口里没等到因果证据（超时 / 事件还没到）：账本给 unknown / self-only-unverifiable。
  ownWrite(policy, FILE_A, { attribution: ATTRIBUTION.UNKNOWN })
  const verdict = judge(policy, { isDirty: true, grantAllowsDirty: true })
  assert.equal(verdict.allowed, false, '首版没有逃逸口：许可只说明"允许碰脏缓冲"，不说明"这是我写的"')
  assert.equal(verdict.reason, R.ATTRIBUTION_UNKNOWN)
  assert.equal(verdict.attribution, ATTRIBUTION.UNKNOWN)
})

test('T62 决策表第 4 行：观察到外部/别的窗口的增量（foreign-change）→ 三种方法全拒', () => {
  const policy = createWritePolicy()
  judge(policy, { version: 5 })
  // 窗口外来了一个 version 6 的变更：没有人正在写，却改了文档 ⇒ 来源不明。
  const change = policy.noteChange({ file: FILE_A, version: 6, incarnation: INC, changes: null })
  assert.equal(change.classified, 'foreign')

  for (const method of WRITE_POLICY_METHODS) {
    const verdict = judge(policy, { method, version: 6, isDirty: true, grantAllowsDirty: true })
    assert.equal(verdict.allowed, false, `${method}: 有 taint ⇒ 一律拒`)
    assert.equal(verdict.reason, R.FOREIGN_CHANGE)
  }
})

test('T62 决策表第 4 行（补）：账本判 mixed（本端窗口里混进别人的增量）→ mixed-origin', () => {
  const policy = createWritePolicy()
  ownWrite(policy, FILE_A, { attribution: ATTRIBUTION.MIXED })
  const verdict = judge(policy, { isDirty: true, grantAllowsDirty: true })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, R.MIXED_ORIGIN)
  assert.equal(verdict.attribution, ATTRIBUTION.MIXED, 'mixed 要如实报 mixed，不许降级成 unknown')
})

test('T62 决策表第 5 行：缺观察器（老宿主 / changeLedger:false）→ 连干净缓冲区也拒', () => {
  const policy = createWritePolicy()
  const verdict = judge(policy, { hasEvidenceSource: false })
  assert.equal(verdict.allowed, false, '★ "看不见别人"绝不等于"没有别人"：默认放行是绝不能有的')
  assert.equal(verdict.reason, R.OBSERVATION_GAP)
  assert.equal(verdict.attribution, ATTRIBUTION.UNKNOWN)
})

test('T62 决策表第 6 行：账本事件被淘汰/失步（窗口里来过事件但证不出因果）→ 不当成自己写的', () => {
  const policy = createWritePolicy()
  policy.beginWrite(FILE_A, { method: APPLY })
  // 窗口内的变更进 windowEvents（可能是我自己的，也可能是别人的）；结算时账本给不出因果。
  policy.noteChange({ file: FILE_A, version: 6, incarnation: INC, changes: null })
  const settled = policy.endWrite(FILE_A, {
    verdict: { attribution: ATTRIBUTION.UNKNOWN, after: { version: 6, incarnation: INC, dirty: true } },
  })
  assert.equal(settled.dirtyOwned, false, '有窗口事件却证不出因果 ⇒ 不许算成自己写的')
  const verdict = judge(policy, { version: 6, isDirty: true, grantAllowsDirty: true })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, R.ATTRIBUTION_UNKNOWN)
})

test('T62 决策表第 7 行：文档实例换过（关闭重开）→ 旧证据作废，按 unknown 拒', () => {
  const policy = createWritePolicy()
  judge(policy, { version: 5, incarnation: INC })
  policy.noteChange({ file: FILE_A, version: 1, incarnation: 'inc-other' })
  // 实例换了 ⇒ 旧证据作废。版本号从 1 重来会让这条事件**看起来**像"迟到的事件"
  // （单看版本会判成 stale），但实例变更本身已经打了 taint —— 门照样拒，这才是要害。
  assert.ok(policy.status().tainted.some((t) => t.file === FILE_A), '实例变更必须留下冻结原因')
  const verdict = judge(policy, { version: 1, incarnation: 'inc-other', isDirty: true, grantAllowsDirty: true })
  assert.equal(verdict.allowed, false, '重开文档不许恢复写许可（否则"关掉重开"就是洗白手段）')
  assert.equal(verdict.reason, R.ATTRIBUTION_UNKNOWN)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 不可洗白（4.7 的硬约束，逐条对应用例）
// ─────────────────────────────────────────────────────────────────────────────

test('T62 ★ 重读最新锚点（version 追上/换新）**不能**消除 taint', () => {
  const policy = createWritePolicy()
  foreignChange(policy, FILE_A, { from: 5, to: 6 })
  for (const version of [6, 7, 99]) {
    const verdict = judge(policy, { version, isDirty: true, grantAllowsDirty: true })
    assert.equal(verdict.allowed, false, `version=${version}: 最新的锚点也不放行（否则就是"重读即洗白"）`)
    assert.equal(verdict.reason, R.FOREIGN_CHANGE)
  }
})

test('T62 ★ [T63 修订] isDirty 变 false：脏缓冲区照旧拒；干净缓冲区不受 taint 管（走第 ③ 步）', () => {
  const policy = createWritePolicy()
  foreignChange(policy, FILE_A, { from: 5, to: 6 })
  // ① 缓冲区仍然脏（有未保存的本地改动）：taint 照旧生效 —— 原断言的核心，一个字没松。
  const dirty = judge(policy, { version: 7, isDirty: true, grantAllowsDirty: true })
  assert.equal(dirty.allowed, false, '★ 脏不脏是"有没有未保存改动"，与"内容是谁写的"是两个问题')
  assert.equal(dirty.reason, R.FOREIGN_CHANGE)
  // ② [2026-10-24 修订] 缓冲区变干净了（那份外部增量已被撤销，或已保存成磁盘现状）：
  //    干净 ⇒ 缓冲区内容 == 磁盘，"别人写的"这件事在内容上已经不存在 ⇒ 放行，改由
  //    `expectedDisk`（-32013）与双锚点（-32012）分别兜"磁盘被人动过 / 缓冲区变过"。
  const clean = judge(policy, { version: 7, isDirty: false, grantAllowsDirty: true })
  assert.equal(clean.allowed, true, '干净写走原第 ③ 步：锚点齐全就放行')
  assert.equal(policy.inspect(FILE_A).taint?.reason, R.FOREIGN_CHANGE,
    '★ 放行 ≠ 洗白：taint 还在，脏写与 deleteFile 仍被拒')
})

test('T62 ★ 机器自动换 grant 不清 taint：只有 establishBaseline（人明确交接后的新授权）才清', () => {
  const policy = createWritePolicy()
  foreignChange(policy, FILE_A, { from: 5, to: 6 })
  // 策略层不认识 grant 身份（写许可另绑 grant.id/epoch，但 taint 记在文件上），
  // 所以"再判一次"从任何角度都还是拒 —— 这就是"换 grant 不洗白"的机制。
  assert.equal(judge(policy, { version: 6, isDirty: true, grantAllowsDirty: true }).allowed, false)

  const baseline = policy.establishBaseline(FILE_A, { version: 6, incarnation: INC })
  assert.equal(baseline.baselineVersion, 6)
  assert.equal(policy.status().tainted.length, 0, 'establishBaseline 是唯一能清 taint 的入口')
  assert.equal(judge(policy, { version: 6, isDirty: false }).allowed, true, '干净基线建立后恢复可写')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 粒度：逐文件（这条是 4.7 里"三件事"的第三件）
// ─────────────────────────────────────────────────────────────────────────────

test('T62 ★ 一个文件被冻结，同一窗口其它干净文件照常可写', () => {
  const policy = createWritePolicy()
  foreignChange(policy, FILE_A, { from: 5, to: 6 })

  const a = judge(policy, { fileKey: FILE_A, version: 6, isDirty: true, grantAllowsDirty: true })
  const b = judge(policy, { fileKey: FILE_B, version: 2, isDirty: false })
  assert.equal(a.allowed, false, 'A 冻结')
  assert.equal(b.allowed, true, '★ B 不受连带影响 —— 否则一个文件脏就停掉整个窗口')
  assert.equal(policy.status().files, 2)
  assert.deepEqual(policy.status().tainted.map((t) => t.file), [FILE_A])
})

test('T62 ★ 冻结按"真实路径"归一：同一文件的另一种写法命中的是同一条状态', () => {
  const policy = createWritePolicy()
  // ★ 这里必须喂**宿主原样**的路径（反斜杠 + 大写盘符），不能先自己 pathIdentityKey 一下：
  //   先归一化等于把被测代码的活儿替它干了 —— 变异（keyOf 改回恒等）就红不了。
  //   第一版这条用例正是这么瞎的，M6 第一次跑"没红"就是证据。
  //   真实来源：观察器事件里带的是宿主原始路径，判许可用的是 normalize 过的绝对路径。
  foreignChange(policy, 'C:\\WS\\A.JS', { from: 5, to: 6 })
  const verdict = judge(policy, { fileKey: FILE_A, version: 6, isDirty: true })
  assert.equal(verdict.allowed, false,
    '★ 归一化只有一处（keyOf）：两处不一致会让 taint 打到另一个键上，门等于不存在')
  assert.equal(policy.status().files, 1, '别名不许另开一条状态')
  // 反向：反斜杠/大小写都不同的一对也必须是同一条（分隔符归一化同样在本模块内）。
  assert.equal(policy.status().tainted.length, 1, '只该有一条冻结记录')
})

test('T62 状态表有上限（逐文件表不许无限长）', () => {
  const policy = createWritePolicy({ maxFiles: 4 })
  for (let i = 0; i < 10; i += 1) judge(policy, { fileKey: pathIdentityKey(`C:/ws/f${i}.js`) })
  assert.equal(policy.status().files, 4, '超过上限按 LRU 淘汰')
  assert.equal(policy.status().stats.evicted, 6)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 旧参数（`params.allowDirtySave`）必须彻底失效
// ─────────────────────────────────────────────────────────────────────────────

test('T62 ★ 源码里不许出现 `allowDirtySave`：调用方参数一律不读（只读授权表）', () => {
  const here = fileURLToPath(new URL('../src/document-write-policy.js', import.meta.url))
  const source = readFileSync(here, 'utf8')
  // 只扫**代码**（先剥块注释、再剥行注释）：注释里提旧名字是在解释"为什么它不算授权"，
  // 提它是必要的；能从代码里读到它才是问题。
  const code = source
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.equal(/allowDirtySave/.test(code), false,
    '策略层只认 `grantAllowsDirty`（由授权表查得）；代码里出现 allowDirtySave 就是又在读调用方参数')
  assert.equal(/\bparams\b/.test(code), false,
    '"忽略旧参数"的最强写法是**根本不接触**请求对象：没有 params 可读，就没有"手滑读一下"的机会')
})

test('T62 ★ 旧参数 `allowDirtySave` 进不了判序：放进判定输入后，结论与**理由**都不变', () => {
  // 行为侧的同一件事（与上面的静态守门分开成两条：静态那条会先抛，会把这条盖住）。
  const policy = createWritePolicy()
  const clean = policy.judge({ method: SAVE, fileKey: FILE_A, version: 5, incarnation: INC, hasEvidenceSource: true })
  const withLegacyParam = policy.judge({
    method: SAVE, fileKey: FILE_A, version: 5, incarnation: INC, hasEvidenceSource: true,
    isDirty: true, allowDirtySave: true, params: { allowDirtySave: true },
  })
  assert.equal(clean.allowed, true)
  assert.equal(withLegacyParam.allowed, false,
    '★ 旧参数进不了判序：脏了还是要靠 grant 许可与归属证据，塞 allowDirtySave 不放行')
  // ★ 连**拒绝理由**都不许变：若旧参数真的被读进判序，它会绕过"没有 grant 许可"那一步，
  //   后面的判序就会给出另一个 reason（`attribution-unknown` 而不是 `dirty-quarantine`）。
  //   只看 allowed 是不够的 —— 两条路都拒，只有 reason 能区分是哪一步拦的。
  assert.equal(withLegacyParam.reason, 'dirty-quarantine',
    '★ 旧参数不许改变"栽在哪一步"：被自己绕过一个判序档位也是被它影响了')
})

test('T62 ★ `assertWritable` 与 `judge` 同一条判序（三个门的错误形状不许漂移）', () => {
  const policy = createWritePolicy()
  foreignChange(policy, FILE_A, { from: 5, to: 6 })
  const verdict = judge(policy, { version: 6, isDirty: true })
  let thrown = null
  try {
    policy.assertWritable({
      method: SAVE, fileKey: FILE_A, version: 6, incarnation: INC, isDirty: true,
      grantAllowsDirty: false, hasEvidenceSource: true,
    })
  } catch (err) { thrown = err }
  assert.equal(thrown?.code, ERR.DOCUMENT_DIRTY)
  assert.equal(thrown.data.reason, verdict.reason, 'throw 与 return 必须给同一个 reason')
  assert.equal(thrown.data.attribution, verdict.attribution)
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 冷启动首次旁观（T63）：本端没见过这个版本 ≠ 别人改过
//
// 真机证据（`D:/code-workspace/work/a2-probe.json`，三次复现）：DSH 冷启动后，
// 任何「启动前就被编辑过」的文件都会被永久冻结 —— 干净文件 `B-clean.txt`
// （`isDirty:false`、`version:5`、磁盘 sha 未变）写请求拿到 `-32011 foreign-change`，
// 重启 DSH 后**立刻**再拒（同一个 `version:5`）。根因是这两条：
//   ① `judge()` 第 ① 步不分干净/脏，一律按 taint 拒；
//   ② 冷启动时 `lastVersion === null`，既有文档第一次被观察就被判成「没人写却变了」。
// ─────────────────────────────────────────────────────────────────────────────

test('T63 ★ 冷启动 + 既有文档 version=5 + 干净（isDirty:false）→ 写必须放行', () => {
  const policy = createWritePolicy()
  // 冷启动第一件事：观察器送来了这份文档的一次变更（人在 DSH 启动前编辑并保存过）。
  const first = policy.noteChange({ file: FILE_A, version: 5, incarnation: INC, changes: null })
  assert.equal(first.classified, 'baseline',
    '★ 首次观察只落基线：`lastVersion` 缺失不是"没有人写却变了"的证据')
  assert.equal(policy.inspect(FILE_A).taint, null, '干净既有文档不许被首次旁观冻结')

  const verdict = judge(policy, { version: 5 })
  assert.equal(verdict.allowed, true,
    '★ 缓冲区内容 == 磁盘（isDirty:false）+ 双锚点 ⇒ 放行；被撤销掉的他人改动已经不在缓冲区里')
  assert.equal(policy.inspect(FILE_A).taint, null, '放行不许顺手造 taint')
})

test('T63 ★ 冷启动后「先写后存」整链不被首次旁观冻结（第 2 条修不动这一条）', () => {
  const policy = createWritePolicy()
  policy.noteChange({ file: FILE_A, version: 5, incarnation: INC, changes: null })
  assert.equal(judge(policy, { version: 5 }).allowed, true)
  // 本端写下去：缓冲区变脏，账本证明这次增量是桥接写的。
  ownWrite(policy, FILE_A, { version: 6, dirty: true })
  const save = judge(policy, { method: SAVE, version: 6, isDirty: true, grantAllowsDirty: true })
  assert.equal(save.allowed, true,
    '★ 只把 taint 收窄到"脏才管"是不够的：首次旁观留下的 taint 会让"刚写完的文件存不下去"')
  assert.equal(save.attribution, ATTRIBUTION.SELF_ONLY)
})

test('T63 ★ taint 只对脏缓冲区与 deleteFile 生效：干净写走原第 ③ 步，脏/归档/无证据源照旧拒', () => {
  const policy = createWritePolicy()
  judge(policy, { version: 5 }) // 先让本端认识这份文件的锚点
  policy.noteChange({ file: FILE_A, version: 6, incarnation: INC, changes: null }) // 别处来的增量
  assert.equal(policy.inspect(FILE_A).taint?.reason, R.FOREIGN_CHANGE, '变更本身仍然要留证据')

  // 干净：缓冲区内容 == 磁盘 ⇒ 那份他人改动已经不在缓冲区里了。
  assert.equal(judge(policy, { version: 6 }).allowed, true, 'applyEdit 干净 ⇒ 放行')
  assert.equal(judge(policy, { method: SAVE, version: 6 }).allowed, true, 'save 干净 ⇒ 放行（仍判 expectedDisk）')

  // ★ 收紧的那三处一处都不许松动：
  const dirty = judge(policy, { version: 6, isDirty: true, grantAllowsDirty: true })
  assert.equal(dirty.allowed, false, '★ 脏缓冲区仍然拒：这是 taint 存在的理由')
  assert.equal(dirty.reason, R.FOREIGN_CHANGE)

  const delClean = judge(policy, { method: DELETE, version: 6 })
  assert.equal(delClean.allowed, false, '★ deleteFile 要求干净基线：不产生新字节、但要搬走整份文件，taint 照旧生效')
  assert.equal(delClean.reason, R.FOREIGN_CHANGE)

  // ★ 这一问必须换一个**没被冻结**的文件：`refuse()` 的优先级是"已有 taint 时以 taint.reason
  //   为准"，在被冻结的文件上问不出 observation-gap（reason 会是 foreign-change）。
  const gap = judge(policy, { fileKey: FILE_B, version: 1, hasEvidenceSource: false })
  assert.equal(gap.allowed, false, '★ 没有同源观察能力仍然整条写路径拒')
  assert.equal(gap.reason, R.OBSERVATION_GAP)

  assert.equal(policy.inspect(FILE_A).taint?.reason, R.FOREIGN_CHANGE,
    '放行一次干净写**不许**顺手把 taint 洗掉（归档与脏写还靠它）')
})

test('T63 ★ 残留风险钉死：真实 taint 下干净写放行后，缓冲区转脏的 save 仍拒', () => {
  const policy = createWritePolicy()
  judge(policy, { version: 5 })
  policy.noteChange({ file: FILE_A, version: 6, incarnation: INC, changes: null })
  // 干净写放行 → 桥接把自己的编辑落进缓冲区 → 缓冲区变脏。
  assert.equal(judge(policy, { version: 6 }).allowed, true)
  ownWrite(policy, FILE_A, { version: 7, dirty: true })
  const save = judge(policy, { method: SAVE, version: 7, isDirty: true, grantAllowsDirty: true })
  assert.equal(save.allowed, false,
    '★ 这是有意保留的：taint 未被写动作洗白（契约 11.5），处置仍是人工 rebase')
  assert.equal(save.reason, R.FOREIGN_CHANGE)
})

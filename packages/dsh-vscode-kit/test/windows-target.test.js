/**
 * W2（多窗口寻址 §3 / §5 / §7 A4–A7）：`request(method, params, { target })` 的路由与拒绝。
 *
 * 整个文件跑**两遍**：一遍 hello 里带 W3 的 `window` 块，一遍**删掉**它（`withWindow=false`）。
 * 这不是为了多跑几条用例，是 W3 的守门测试本身 —— 窗口身份的上报**不参与任何判定**，
 * 所以两组判定结果必须逐条相同。哪天有人把 `window.sessionId` 偷进判定，这一组里
 * "删掉块"的那半边就会变红（= 身份候选被当成判据了）。
 *
 * 判定口径（§3、§5，顺序也是接口）：
 *  - 写路径带 target → `-32014 / target-not-routable`，**在绑定目标之前**、对端零帧；
 *  - 读路径 target 与"绑定读"不是同一条 → `-32014 / target-unauthorized`，**不回退活跃连接**；
 *  - 点不到任何活连接 → `window-not-found`；曾经有过但已关 → `window-closed`；
 *  - 同一号挂在两条活连接上 → `window-ambiguous`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ERR } from '../src/protocol.js'
import { windowBlock, withKit } from './windows-harness.js'

const S1 = 'sess-alpha'
const FILE = '/ws/a.js'
const ALPHA = windowBlock({ sessionId: 'sess-alpha', folder: '/ws/alpha' })
const BETA = windowBlock({ sessionId: 'sess-beta', folder: '/ws/beta' })

/** 写参数（T34 起写必须带双锚点；这里只要它"能过本地形状门"，好在 target 处被拒）。 */
function writeParams() {
  return {
    file: FILE,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
    text: 'hello',
    expectedVersion: 7,
    expectedIncarnation: 'inc-A',
  }
}

/** 断言一个 -32014 及其 reason（顺手断言它没被别的门抢先拒掉）。 */
async function rejectsWindowTarget(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, ERR.WINDOW_TARGET_FAILED, `期望 -32014，实际 ${err.code}（${err.message}）`)
    assert.equal(err.data?.reason, reason)
    assert.equal(err.data?.side, 'dsh')
    return true
  })
}

/**
 * 两条窗口 + 一条"未指定 target 时会去哪"的对照。
 * `withWindow=false` 时 hello 里没有 `window` 块 —— 号退化成 `tmp-<connSeq>`。
 */
async function twoWindows({ withWindow }) {
  const kit = await withKit()
  const block = withWindow ? ALPHA : undefined
  const beta = withWindow ? BETA : undefined
  const A = await kit.open({ label: 'A', window: block })
  const B = await kit.open({ label: 'B', window: beta })
  const rows = kit.list()
  return { kit, A, B, rows, idA: rows[0].windowId, idB: rows[1].windowId, seqA: rows[0].connSeq, seqB: rows[1].connSeq }
}

for (const withWindow of [true, false]) {
  const tag = withWindow ? 'W3 块在' : 'W3 块被删（守门）'

  // ───────────────────────────────────────────────────────────────────────────
  // A4 —— 读路径命中 target；另一条窗口零帧
  // ───────────────────────────────────────────────────────────────────────────

  test(`★ W2 A4：读 {target} 只打到那一条窗口，另一条零帧 —— ${tag}`, async () => {
    const { kit, A, B, seqA } = await twoWindows({ withWindow })
    try {
      // 不指定 target：落在活跃视图（connSeq 最大 = B）—— 这是旧行为的对照。
      const active = await kit.svc.request('vscode.getSelection', {})
      assert.equal(active.file, '/ws/from-B.js')
      assert.equal(B.count('vscode.getSelection'), 1)
      assert.equal(A.count('vscode.getSelection'), 0)

      // 指定 target=#A：帧只去 A。
      const pinned = await kit.svc.request('vscode.getSelection', {}, { target: `#${seqA}` })
      assert.equal(pinned.file, '/ws/from-A.js', 'target 必须真的换目标，而不是"看起来换了"')
      assert.equal(A.count('vscode.getSelection'), 1)
      assert.equal(B.count('vscode.getSelection'), 1, 'B 不许再收一条（A4 的回归点）')
    } finally {
      await kit.cleanup()
    }
  })

  test(`★ W2 A4b：windowId 与 #connSeq 两种写法解析到同一条连接 —— ${tag}`, async () => {
    const { kit, A, B, idA } = await twoWindows({ withWindow })
    try {
      const byId = await kit.svc.request('vscode.getSelection', {}, { target: idA })
      assert.equal(byId.file, '/ws/from-A.js')
      assert.equal(A.count('vscode.getSelection'), 1)
      assert.equal(B.count('vscode.getSelection'), 0)
    } finally {
      await kit.cleanup()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // A5 —— 写路径带 target：一律拒，且对端零帧、grant 不被改写
  // ───────────────────────────────────────────────────────────────────────────

  test(`★ W2 A5：写路径带 target → -32014 target-not-routable、对端零帧、grant 未动 —— ${tag}`, async () => {
    const { kit, A, B, seqA, idA } = await twoWindows({ withWindow })
    try {
      // ★ 关键：**故意不给 grant**。若这道门的位置被挪到 `_bindWriteTarget` 之后，
      //   报的就会是 -32010（no-grant）而不是 -32014 —— 用例在这里变红。
      const grantsBefore = kit.svc.editing.list().length

      await rejectsWindowTarget(
        kit.svc.vscode.applyEdit(writeParams(), { sessionId: S1, target: `#${seqA}` }),
        'target-not-routable',
      )
      await rejectsWindowTarget(
        kit.svc.vscode.applyEdit(writeParams(), { sessionId: S1, target: idA }),
        'target-not-routable',
      )
      // 三个写入口都要拒（§3.2 说的是"写类"，不是"applyEdit"）。
      await rejectsWindowTarget(
        kit.svc.vscode.save(FILE, { expectedVersion: 7, expectedIncarnation: 'inc-A', expectedDisk: { sha256: 'x' }, sessionId: S1, target: `#${seqA}` }),
        'target-not-routable',
      )
      await rejectsWindowTarget(
        kit.svc.vscode.deleteFile(FILE, { expectedVersion: 7, expectedIncarnation: 'inc-A', expectedDisk: { sha256: 'x' }, sessionId: S1, target: `#${seqA}` }),
        'target-not-routable',
      )
      // 万能入口同一条路。
      await rejectsWindowTarget(
        kit.svc.request('vscode.applyEdit', writeParams(), { sessionId: S1, target: `#${seqA}` }),
        'target-not-routable',
      )

      assert.equal(A.count('vscode.applyEdit'), 0, '写类带 target 必须对端零帧')
      assert.equal(B.count('vscode.applyEdit'), 0, '更不许偷偷改投别的窗口')
      assert.equal(A.count('bridge.grant'), 0, '连授权都不该被碰')
      assert.equal(kit.svc.editing.list().length, grantsBefore, 'grant 表不许被这次失败改写')
    } finally {
      await kit.cleanup()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // A6 —— 绑定读 + 冲突 target：拒，且不回退活跃连接
  // ───────────────────────────────────────────────────────────────────────────

  test(`★ W2 A6：绑定读给别的窗口 → -32014 target-unauthorized，不回退 _activeLink() —— ${tag}`, async () => {
    const { kit, A, B, seqA, seqB } = await twoWindows({ withWindow })
    try {
      // 只有 A 在的时候发 grant → 记录里承载连接是 A（与 t5 同一手法）。
      await A.close()
      const A2 = await kit.open({ label: 'A2', window: withWindow ? ALPHA : undefined })
      await kit.svc.editing.grant({ sessionId: S1, windowId: 'win-A' })
      // B 后连 ⇒ 活跃视图是 B。绑定读却必须去 A2。
      const boundOk = await kit.svc.vscode.getDocumentState(FILE, { sessionId: S1 })
      assert.equal(A2.count('vscode.getDocumentState'), 1, '绑定读按 grant 记录走，不按活跃')
      assert.equal(B.count('vscode.getDocumentState'), 0)
      assert.equal(boundOk.file, FILE)

      // 冲突：会话绑定在 A2，target 却指 B（B 的序号在 A 关掉后不变）。
      await rejectsWindowTarget(
        kit.svc.vscode.getDocumentState(FILE, { sessionId: S1, target: `#${seqB}` }),
        'target-unauthorized',
      )
      assert.equal(B.count('vscode.getDocumentState'), 0, '★ 不许回退到活跃连接（A6 的回归点）')
      assert.equal(A2.count('vscode.getDocumentState'), 1, '也不许"反正你绑定的那条也行"地改投 A2')
    } finally {
      await kit.cleanup()
    }
  })

  test(`★ W2 A6b：绑定读给同一条连接 → 放行（不是一刀切拒绝） —— ${tag}`, async () => {
    const kit = await withKit()
    try {
      // grant 在"只有 A"的时候发 ⇒ 记录承载连接 = A；B 后连成为活跃视图。
      const A = await kit.open({ label: 'A', window: withWindow ? ALPHA : undefined })
      await kit.svc.editing.grant({ sessionId: S1, windowId: 'win-A' })
      const B = await kit.open({ label: 'B', window: withWindow ? BETA : undefined })
      const seqA = kit.list()[0].connSeq

      // bind 的读去的就是 A，target 也指 A ⇒ 不是冲突，放行（否则这道门就变成一刀切）。
      const st = await kit.svc.vscode.getDocumentState(FILE, { sessionId: S1, target: `#${seqA}` })
      assert.equal(st.file, FILE)
      assert.equal(A.count('vscode.getDocumentState'), 1)
      assert.equal(B.count('vscode.getDocumentState'), 0, '走了绑定连接，就没活跃视图什么事')
    } finally {
      await kit.cleanup()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // A7 —— 关了 vs 从来不存在
  // ───────────────────────────────────────────────────────────────────────────

  test(`★ W2 A7：已关窗口 → window-closed；从没有过的号 → window-not-found —— ${tag}`, async () => {
    const { kit, A, B, idA, seqA } = await twoWindows({ withWindow })
    try {
      await A.close()
      // 关掉之后，序号和号都留了墓碑：两种写法都要报"关了"，而不是"没有这个窗口"。
      await rejectsWindowTarget(kit.svc.request('vscode.getSelection', {}, { target: `#${seqA}` }), 'window-closed')
      await rejectsWindowTarget(kit.svc.request('vscode.getSelection', {}, { target: idA }), 'window-closed')
      // 从没出现过的号：不许冒充"关掉的"。
      await rejectsWindowTarget(kit.svc.request('vscode.getSelection', {}, { target: '#99' }), 'window-not-found')
      await rejectsWindowTarget(
        kit.svc.request('vscode.getSelection', {}, { target: withWindow ? 'win-99' : 'tmp-99' }),
        'window-not-found',
      )
      // 关掉的窗口一个字节都收不到；活着的 B 也没被顺带踩到。
      assert.equal(A.count('vscode.getSelection'), 0)
      assert.equal(B.count('vscode.getSelection'), 0)
    } finally {
      await kit.cleanup()
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 其余两个 reason（这两条**必须**有 window 块才有意义，故不放进上面的循环）
// ─────────────────────────────────────────────────────────────────────────────

test('★ W2 window-ambiguous：同一个 windowId 挂在两条活连接上 → 拒，两条都零帧', async () => {
  const kit = await withKit()
  try {
    // 同一个窗口指纹（同 sessionId + 同工作区根）落在两条连接上（扩展重载期间会短暂如此）。
    await kit.open({ label: 'A', window: ALPHA })
    await kit.open({ label: 'A2', window: ALPHA })
    const rows = kit.list()
    assert.deepEqual(rows.map((r) => r.windowId), ['win-01', 'win-01'], '两条连接共用一个号')

    await rejectsWindowTarget(
      kit.svc.request('vscode.getSelection', {}, { target: 'win-01' }),
      'window-ambiguous',
    )
    for (const c of kit.clients) assert.equal(c.count('vscode.getSelection'), 0)
  } finally {
    await kit.cleanup()
  }
})

test('★ W2 label 不是 target：拿展示用的 label 去路由 → window-not-found、零帧', async () => {
  const kit = await withKit()
  try {
    await kit.open({ label: 'A', window: ALPHA })
    const label = kit.list()[0].label
    assert.equal(label, 'alpha · win-01')
    // §1.2：target 只接受 `windowId` 与 `#connSeq` 两种写法。label 是给人看的，
    // 让它可路由就等于把"展示格式"变成"接口格式"。
    await rejectsWindowTarget(
      kit.svc.request('vscode.getSelection', {}, { target: label }),
      'window-not-found',
    )
    assert.equal(kit.clients[0].count('vscode.getSelection'), 0)
  } finally {
    await kit.cleanup()
  }
})

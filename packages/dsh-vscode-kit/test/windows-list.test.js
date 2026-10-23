/**
 * W1（多窗口寻址 §1.2 / §2.2 / §7 A1–A3、A9）：kit 侧的**窗口名册**。
 *
 * 这一组只测 `vscode.windows.list()` 这份视图，不测路由（那种在 `windows-target.test.js`）。
 * 视图的三条硬要求（少一条，视图就会开始骗人）：
 *
 *  ① **只含已准入连接**（§4）：裸连一个 socket 什么都不发，它既不在表里、
 *     也解析不到 —— 准入状态不许被视图探出来（A1）。
 *  ② **按 `connSeq` 升序**（§2.2 唯一排序口径），且 `windowId` 与 `connSeq`
 *     是**两个字段、不许互相比**（A2 / A3）。
 *  ③ **降级要看得见**（§1.3）：老扩展不上报 → 号还是有的（`tmp-<connSeq>`），
 *     但 `stable:false` 把"这个号下次可能变"写进数据里（A9）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ERR } from '../src/protocol.js'
import { windowsFilePath } from '../src/windows.js'
import { waitFor, windowBlock, withKit } from './windows-harness.js'

const ALPHA = windowBlock({ sessionId: 'sess-alpha', folder: '/ws/alpha' })
const BETA = windowBlock({ sessionId: 'sess-beta', folder: '/ws/beta' })

// ─────────────────────────────────────────────────────────────────────────────
// A1 —— 表里只有已准入连接；未准入者不在表里，也点不到它
// ─────────────────────────────────────────────────────────────────────────────

test('★ W1 A1：list() 只列已准入连接；未准入的裸 socket 不在表里、target 也解析不到', async () => {
  const kit = await withKit()
  try {
    await kit.open({ label: 'A', window: ALPHA })
    await kit.open({ label: 'B', window: BETA })
    // 第三个：只建 TCP、一个字节都不发 —— 未准入（`server.js` 的 authorize 没升格它）。
    const rogue = await kit.openRogue({ label: 'X' })
    // 客户端 socket 的 'connect' 可能早于 server 的 'connection' 回调 —— 等它真的登记上，
    // 否则下面按 `links` 找"未准入那条"会偶发找不到（这条 waitFor 是被变异测试逼出来的）。
    await waitFor(() => kit.server.links.size >= 3, { label: 'rogue socket registered' })
    const rogueLink = [...kit.server.links].find((l) => !kit.server.trusted.has(l))
    assert.ok(rogueLink, '未准入连接应当存在于 server.links（只是不在 trusted 里）')
    const rogueSeq = rogueLink.connSeq
    assert.equal(typeof rogueSeq, 'number')

    const rows = kit.list()
    assert.equal(rows.length, 2, '表里只该有两条已准入连接')
    assert.ok(rows.every((r) => r.connSeq !== rogueSeq), '未准入连接的 connSeq 不许出现在表里')
    assert.ok(rows.every((r) => r.windowId !== `tmp-${rogueSeq}`))

    // §4：探测不到 ≠ 另立一个错误 —— 与"从来不存在"同码（信息量不许多给）。
    await assert.rejects(
      kit.svc.request('vscode.getSelection', {}, { target: `#${rogueSeq}` }),
      (err) => {
        assert.equal(err.code, ERR.WINDOW_TARGET_FAILED)
        assert.equal(err.data.reason, 'window-not-found')
        return true
      },
    )
    assert.equal(rogue.count('vscode.getSelection'), 0, '未准入连接不该收到任何业务帧')
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// A2 —— 升序（断言 [1,2]，不是"随便有序"）
// ─────────────────────────────────────────────────────────────────────────────

test('★ W1 A2：list() 按 connSeq 升序（[1,2] 而不是 [2,1]），且先连的先出现', async () => {
  const kit = await withKit()
  try {
    await kit.open({ label: 'A', window: ALPHA })
    await kit.open({ label: 'B', window: BETA })

    const rows = kit.list()
    assert.deepEqual(rows.map((r) => r.connSeq), [1, 2])
    assert.deepEqual(rows.map((r) => r.windowId), ['win-01', 'win-02'])
    // label 是展示用的，里面**包含** windowId，但它不是可用 target 的唯一依据。
    assert.equal(rows[0].label, 'alpha · win-01')
    assert.equal(rows[1].label, 'beta · win-02')
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// A3 —— 两个字段各自成立：同窗口重连 windowId 不变、connSeq 变
// ─────────────────────────────────────────────────────────────────────────────

test('★ W1 A3：windowId 与 connSeq 是两个独立字段；同窗口重连 → windowId 不变、connSeq 变', async () => {
  const kit = await withKit()
  try {
    const A = await kit.open({ label: 'A', window: ALPHA })
    const first = kit.list()[0]
    assert.equal(first.windowId, 'win-01')
    assert.equal(first.connSeq, 1)
    // 最要紧的一条：不许把两个字段拼成对方（否则"窗口"和"第几次连接"就混成一个概念）。
    assert.notEqual(first.windowId, String(first.connSeq))

    // 同一个窗口里扩展重载 → 新连接（connSeq 变），指纹命中 → 号还是它。
    await A.close()
    await kit.open({ label: 'A2', window: ALPHA })

    const rows = kit.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].windowId, 'win-01', '同指纹重连必须复用同一个 windowId')
    assert.equal(rows[0].connSeq, 2, 'connSeq 是连接序号，重连当然会变')
    assert.equal(rows[0].stable, true)

    // 签发结果落了盘（`~/.dsh/dsh-vscode-kit/windows.json`）：DSH 自己重启后还要认得出。
    const file = JSON.parse(readFileSync(windowsFilePath(kit.home), 'utf8'))
    assert.equal(file.version, 1)
    assert.deepEqual(file.windows.map((w) => w.windowId), ['win-01'])
    assert.equal(typeof file.windows[0].fingerprint, 'string')
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// A9 —— 老扩展（hello 里没有 window 块）：号有，但标成不再稳
// ─────────────────────────────────────────────────────────────────────────────

test('★ W1 A9：老扩展不上报身份 → windowId=tmp-<connSeq>、stable:false、workspace:null', async () => {
  const kit = await withKit()
  try {
    await kit.open({ label: 'old' }) // 不传 window → hello 里没有这块
    const rows = kit.list()
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.windowId, 'tmp-1', '降级号必须存在且可被 target（§6）')
    assert.equal(row.stable, false, '降级要写进数据里，而不是让调用方猜')
    assert.equal(row.connSeq, 1)
    assert.equal(row.workspace, null)
    assert.equal(row.uiKind, null)
    assert.equal(row.remoteName, null)
    assert.equal(row.label, 'unnamed · tmp-1')
    // 老扩展也是扩展：它的版本仍然要在表里看得见。
    assert.equal(row.extensionVersion, '0.3.1')
    assert.equal(row.protocolVersion, '1')

    // 老扩展的降级号也能被 target 命中（§6：target 仍可用）。
    const sel = await kit.svc.request('vscode.getSelection', {}, { target: 'tmp-1' })
    assert.equal(sel.file, '/ws/from-old.js')
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §1.3 —— DSH 重启：connSeq 从 1 重来，windowId 从 windows.json 恢复
// ─────────────────────────────────────────────────────────────────────────────

test('★ W1 §1.3：DSH 重启后 connSeq 从头数、windowId 从 windows.json 恢复成同一个', async () => {
  const kit1 = await withKit()
  let home = kit1.home
  try {
    await kit1.open({ label: 'A', window: ALPHA })
    await kit1.open({ label: 'B', window: BETA })
    assert.deepEqual(kit1.list().map((r) => r.windowId), ['win-01', 'win-02'])
    await kit1.cleanup({ keepHome: true })

    // 同一个 dshHome、新的 server 进程（connSeq 归零，注册表从文件读）。
    const kit2 = await withKit({ home })
    try {
      await kit2.open({ label: 'B2', window: BETA })
      const rows = kit2.list()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].connSeq, 1, '新进程的连接序号从头数')
      assert.equal(rows[0].windowId, 'win-02', '号从文件恢复：beta 还是 win-02')
      assert.equal(rows[0].stable, true)
    } finally {
      await kit2.cleanup()
    }
  } finally {
    // kit1 的 home 已经 keepHome 交给 kit2 清理；这里只兜住 kit2 之前就失败的路径。
    if (home) { try { readFileSync(windowsFilePath(home)) } catch { /* 已被清理 */ } }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 —— 字段与 active 位
// ─────────────────────────────────────────────────────────────────────────────

test('★ W1 §2.2：每行的字段齐备，active 只标一条（= 活跃视图那条，只是视图）', async () => {
  const kit = await withKit()
  try {
    await kit.open({ label: 'A', window: ALPHA })
    await kit.open({ label: 'B', window: windowBlock({ sessionId: 'sess-beta', folder: '/ws/beta', name: 'beta-ws', uiKind: 2, remoteName: 'ssh-remote' }) })

    const rows = kit.list()
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), [
        'active', 'connSeq', 'extensionVersion', 'focused', 'label', 'protocolVersion',
        'remoteName', 'stable', 'uiKind', 'windowId', 'workspace',
      ])
    }
    assert.deepEqual(rows[1].workspace, { name: 'beta-ws', folders: ['/ws/beta'] })
    assert.equal(rows[1].uiKind, 'web', 'uiKind 2 = web（kit 侧翻译，原始数字留在编辑器里）')
    assert.equal(rows[1].remoteName, 'ssh-remote')
    assert.equal(rows[0].focused, null, '没上报焦点就是 null（不许猜成 false）')

    // active 是"如果现在不指定 target，请求会去哪"的视图 = connSeq 最大那条。
    assert.deepEqual(rows.map((r) => r.active), [false, true])
    assert.equal(rows.filter((r) => r.active).length, 1)
  } finally {
    await kit.cleanup()
  }
})

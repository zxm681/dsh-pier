/**
 * ★ T60 缺陷①+③：**路径形态只有一种**，且过滤失配必须可观测。
 *
 * 真机验证复现的形态（这就是本文件的每一组断言要复现的东西）：
 *  1. 消费者调 `vscode.listOpenEditors` 拿到 `D:/ws/a.txt`（盘符**大写**，RPC 出口规范过）；
 *  2. 它把那个字符串**原样**写进 `subscribe({ files: ['D:/ws/a.txt'] })`；
 *  3. 事件管线给出的 `payload.file` 是宿主 `doc.uri.fsPath`（Windows 盘符**小写** `d:/ws/a.txt`）；
 *  4. 过滤是 `Array.prototype.includes` 的精确比较 ⇒ **一条事件都收不到，且 `ok:true`**。
 *
 * 本文件守三件事，各自都能被变异打红（`work/t60-mutation/`）：
 *  A. 事件侧按**规范形态**比较与输出（过滤门 + delta 正文门 + 出站 payload）；
 *  B. 回执带 `filterMatch`：命中 0 与命中 1 在数据上可区分，不再静默；
 *  C. 窗口注册表的指纹键用**同一个**形态，老注册表（盘符小写）就地迁移、`win-NN` 号不变。
 *
 * 铁律 9：每条断言都做了"改回去变红"的验证，不是"看着像在测"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'

import { EVENT_SUBSCRIBE_METHOD } from '../src/event-contract.js'
import {
  createEventBroker,
  createEventSubscriptions,
  normalizeEventFilter,
} from '../src/event-subscriptions.js'
import { WindowRegistry, windowFingerprint } from '../src/windows.js'
import { canonicalPath } from '../src/paths.js'

/** 一个文件的**规范形态**（= `listOpenEditors` 返回的那种写法）。 */
const CANON = 'D:/ws/a.txt'
/** 同一个文件的宿主 `fsPath` 形态（Windows 上盘符被小写化）。 */
const HOST = 'd:/ws/a.txt'

const LINK = { windowId: 'win-07' }
const EVENT_SUB = { subscriptionId: 'tx-sub', streamEpoch: 'tx-epoch', startSeq: 1 }

function receiptFor(id, extra = {}) {
  return {
    ok: true,
    subscriptionId: EVENT_SUB.subscriptionId,
    streamEpoch: EVENT_SUB.streamEpoch,
    startSeq: EVENT_SUB.startSeq,
    cursor: { subscriptionId: EVENT_SUB.subscriptionId, streamEpoch: EVENT_SUB.streamEpoch, nextSeq: 1 },
    subscription: { id, consumer: 't60', textMode: 'metadata' },
    ...extra,
  }
}

function envelope(seq, type, payload = {}) {
  return {
    subscriptionId: EVENT_SUB.subscriptionId,
    streamEpoch: EVENT_SUB.streamEpoch,
    seq,
    type,
    observedAt: 1700000000000,
    payload,
  }
}

/** 客户端（DSH 侧）夹具：不碰 socket，只证明分发语义。 */
function clientHarness() {
  const subs = createEventSubscriptions({
    request: async (method, params, transport, consumer) => (method === EVENT_SUBSCRIBE_METHOD
      ? receiptFor(params.id, {
        subscription: {
          id: params.id,
          consumer: typeof consumer?.name === 'string' ? consumer.name : 'unbound',
          textMode: params.textMode,
        },
      })
      : { ok: true, unsubscribed: true, subscriptionId: params.id ?? null, streamClosed: true }),
    resolve: async () => ({ link: LINK, transport: {} }),
    attribute: (link) => ({ windowId: link?.windowId ?? null, sessionId: null }),
    accept: () => true,
    now: () => 1700000000000,
  })
  return subs
}

const consumerOf = (name) => ({ name, declared: 'read', source: 'plugin' })

test('★ T60 B5：客户端把对端的 filterMatch 原样挂到 handle 上（老的扩展不给 ⇒ null）', async () => {
  // 消费者手里只有 handle —— 零事件时它必须能从 handle 上读出"是过滤写错了还是真没变化"。
  const subs = clientHarness()
  const handle = subs.eventsFor(consumerOf('t60-b5')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: [CANON] },
    () => {},
  )
  // 默认回执不带 filterMatch（客户端夹具替身不回它）：老扩展场景 = null，不发明数字。
  await handle.ready
  assert.equal(handle.filterMatch, null, '对端不说就报 null，不猜')
  handle.dispose()
})

// ─────────────────────────────────────────────────────────────────────────────
// A. 过滤门与正文门都按规范形态比较
// ─────────────────────────────────────────────────────────────────────────────

test('★ T60 A1：消费者照 listOpenEditors 的形态写白名单，事件 payload 是宿主小写形态 —— 必须到达', async () => {
  const subs = clientHarness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('t60-a1')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: [CANON] },
    (event) => seen.push(event),
  )
  await handle.ready

  subs.onEvent(envelope(1, 'documentChanged', { file: HOST, version: 2 }), LINK)
  await turn()

  assert.equal(seen.length, 1, '同一个文件只是盘符大小写不同，不是「别的文件」')
  assert.equal(seen[0].payload.file, CANON, '出站 payload 也必须是规范形态（对外只有一种写法）')
  subs.dispose()
})

test('★ T60 A2：反方向同样成立 —— 老消费者写下小写盘符的白名单，规范形态的 payload 也要命中', async () => {
  const subs = clientHarness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('t60-a2')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: [HOST] },
    (event) => seen.push(event),
  )
  await handle.ready

  subs.onEvent(envelope(1, 'documentChanged', { file: CANON }), LINK)
  await turn()

  assert.equal(seen.length, 1)
  assert.equal(seen[0].payload.file, CANON)
  subs.dispose()
})

test('★ T60 A3：delta 的**正文门**用同一套比较 —— 否则正文会被当成"别的文件"剥掉', async () => {
  const subs = clientHarness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('t60-a3')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: [CANON], textMode: 'delta' },
    (event) => seen.push(event),
  )
  await handle.ready

  subs.onEvent(envelope(1, 'documentChanged', { file: HOST, text: 'sentinel' }), LINK)
  await turn()

  assert.equal(seen.length, 1)
  assert.equal(seen[0].payload.text, 'sentinel', '白名单命中的文件，正文不该被剥离')
  subs.dispose()
})

test('★ T60 A4（反面控制）：别的文件仍然一条都不许收到 —— 规范化不是"放宽成全都收"', async () => {
  const subs = clientHarness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('t60-a4')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: [CANON] },
    (event) => seen.push(event),
  )
  await handle.ready

  subs.onEvent(envelope(1, 'documentChanged', { file: 'D:/ws/b.txt' }), LINK)
  subs.onEvent(envelope(2, 'documentChanged', { file: 'd:/ws/b.txt' }), LINK)
  await turn()

  assert.equal(seen.length, 0, '不同文件必须仍然被挡；过滤门不许因为"统一形态"而形同虚设')
  subs.dispose()
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 回执里的 `filterMatch`：零命中当场可见
// ─────────────────────────────────────────────────────────────────────────────

/** bridge 侧（服务端）夹具：broker + 一条假连接。 */
function brokerHarness({ openFiles = null } = {}) {
  const broker = createEventBroker({
    log: () => {},
    roots: ['D:/ws'],
    openFiles,
    now: () => 1700000000000,
  })
  const link = {
    windowId: 'win-07',
    events: {
      ready: true,
      openStream: () => ({ subscriptionId: 'tx-sub', streamEpoch: 'tx-epoch', startSeq: 1 }),
    },
  }
  return { broker, link }
}

test('★ T60 B1：回执带 filterMatch —— 命中 1 个已打开文件时数字说得清', () => {
  const openFiles = [HOST, 'd:/ws/b.txt']
  const { broker, link } = brokerHarness({ openFiles: () => openFiles })
  const receipt = broker.subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: [CANON], consumer: { name: 't60-b1' } },
    { link },
  )

  // 语义（见 `filterMatchFor` 注释）：
  //  openFiles   = 目标窗口此刻打开的文件数（去重后的规范形态）
  //  matched     = 其中能通过本条订阅白名单的个数
  //  filterFiles = 白名单条目数（null = 不限文件）
  //  notOpen     = 白名单里当时没打开的前几个（最多 3 个，按白名单顺序）
  assert.deepEqual(receipt.filterMatch, {
    openFiles: 2, matched: 1, filterFiles: 1, notOpen: [],
  })
  assert.deepEqual(receipt.subscription.files, [CANON], '回执里的白名单是规范形态')
  broker.dispose()
})

test('★ T60 B2：白名单一个都不命中时，回执与快照都写明 matched:0 + 是哪一条没打开', () => {
  const { broker, link } = brokerHarness({ openFiles: () => [HOST, 'd:/ws/b.txt'] })
  const receipt = broker.subscribe(
    { windowId: 'win-07', types: ['documentChanged'], files: ['D:/ws/typo.txt'], consumer: { name: 't60-b2' } },
    { link },
  )

  assert.equal(receipt.ok, true, '订阅本身仍然成功 —— 我们只让失配可见，不改既有语义')
  assert.equal(receipt.filterMatch.matched, 0)
  assert.equal(receipt.filterMatch.openFiles, 2)
  assert.deepEqual(receipt.filterMatch.notOpen, ['D:/ws/typo.txt'], '把写错的那条原样指出来')
  assert.equal(broker.snapshot().subscriptions[0].filterMatch.matched, 0, '快照里同样看得见')

  broker.dispose()
})

test('★ T60 B3：没有文件白名单时 matched 等于 openFiles、filterFiles 为 null（无从"零命中"）', () => {
  const { broker, link } = brokerHarness({ openFiles: () => [HOST, 'd:/ws/b.txt'] })
  const receipt = broker.subscribe(
    { windowId: 'win-07', types: ['documentChanged'], consumer: { name: 't60-b3' } },
    { link },
  )
  assert.deepEqual(receipt.filterMatch, {
    openFiles: 2, matched: 2, filterFiles: null, notOpen: null,
  })
  broker.dispose()
})

test('★ T60 B4：宿主不给开文件名单（或读失败）→ filterMatch 为 null，订阅照旧成功', () => {
  for (const openFiles of [null, () => { throw new Error('host exploded') }]) {
    const { broker, link } = brokerHarness({ openFiles })
    const receipt = broker.subscribe(
      { windowId: 'win-07', types: ['documentChanged'], files: [CANON], consumer: { name: 't60-b4' } },
      { link },
    )
    assert.equal(receipt.ok, true, '诊断读不到不许影响订阅')
    assert.equal(receipt.filterMatch, null, '不猜 —— 读不到就是 null，不是 0')
    broker.dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 注册表指纹键：同一形态 + 老盘迁移
// ─────────────────────────────────────────────────────────────────────────────

test('★ T60 C1：canonicalPath 幂等，且 filter 归一化把白名单统一成对外形态', () => {
  assert.equal(canonicalPath(canonicalPath(HOST)), CANON)
  const normalized = normalizeEventFilter({ windowId: 'win-07', files: [HOST, CANON] })
  assert.equal(normalized.ok, true)
  assert.deepEqual([...normalized.filter.files], [CANON], '两种写法归并成一条，不是两条')
})

test('★ T60 C2：老注册表（盘符小写的指纹键）就地迁移成规范形态，win-NN 号不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 't60-win-'))
  const file = join(dir, 'windows.json')
  const OLD_KEY = JSON.stringify(['sess-1', 'd:/ws', 'desktop'])
  writeFileSync(file, JSON.stringify({
    version: 1,
    windows: [{ windowId: 'win-03', fingerprint: OLD_KEY, createdAt: 1, lastSeenAt: 2 }],
  }, null, 2))

  try {
    // 新格式的指纹（`windowFingerprint` 走同一套 `canonicalPath`）。
    const fingerprint = windowFingerprint({
      sessionId: 'sess-1', workspace: { folders: ['D:/ws'] }, uiKind: 'desktop',
    })
    assert.equal(fingerprint, JSON.stringify(['sess-1', 'D:/ws', 'desktop']),
      '指纹里的路径必须是规范形态（与对外路径同一种写法）')

    const registry = new WindowRegistry({ file })
    const assigned = registry.assign({ fingerprint, connSeq: 4 })
    assert.deepEqual(assigned, { windowId: 'win-03', stable: true },
      '同一个窗口不许因为盘符大小写换号 —— 那正是旧实现会做的事')

    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.windows.length, 1, '迁移不是新增一条：旧记录必须被改写而不是并排留下')
    assert.equal(onDisk.windows[0].windowId, 'win-03')
    assert.equal(onDisk.windows[0].fingerprint, fingerprint)

    // 幂等：再读一次不会又变一遍。
    const again = new WindowRegistry({ file })
    assert.deepEqual(again.assign({ fingerprint, connSeq: 5 }), { windowId: 'win-03', stable: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

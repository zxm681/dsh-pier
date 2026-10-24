/**
 * 扩展入口：activate / deactivate。
 *
 * 职责刻意压到最小 —— 读配置、建 output channel、建 dispatcher、起 connector、
 * 注册命令与生命周期。所有业务逻辑都在 capabilities.js / connector.js 里，
 * 那两个文件不 import vscode，可单测。
 */

import * as vscode from 'vscode'
import { existsSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { ERR, ERR_NAME } from '../../dsh-vscode-kit/src/protocol.js'
import { createDispatcher } from './vscode-host.js'
import { createConnector } from './connector.js'

/** @type {{connector: any, output: vscode.OutputChannel|null}} */
const ctx = { connector: null, output: null, instance: null, disposables: [] }

/** 这些配置键改变后必须重建扩展宿主（改 dshHome / 轮询间隔需要新连接器）。 */
const RESTART_KEYS = ['dshHome', 'pollIntervalMs', 'deleteConfirmTimeoutMs']

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('dshKit')
  return {
    enabled: cfg.get('enabled', true),
    dshHome: cfg.get('dshHome', '') || undefined,
    pollIntervalMs: cfg.get('pollIntervalMs', 2000),
    selfTestOnStart: cfg.get('selfTestOnStart', false),
    // T40：删除的人工确认超时（§7 #5 的独立长超时）。0/缺省 = 交给能力层默认 120s。
    deleteConfirmTimeoutMs: cfg.get('deleteConfirmTimeoutMs', 120000),
  }
}

/**
 * 自检：在**真实 VS Code 里**跑一遍能力实现，结果写文件。
 *
 * 为什么需要它：单测用的是假 host，E2E 用的是假 host，两者都证明不了
 * `vscode-host.js` 里那几行真实 API 调用是对的（`showTextDocument` 的参数、
 * `env.openExternal` 的返回值、`activeTextEditor` 的形状）。
 * 这是唯一能在无人值守时验证真适配层的办法。
 *
 * @returns {Promise<object>} 结构化结果，永远不抛
 */
/**
 * T32 版本锚点自检用的夹具内容（**只在这里定义一次**：写盘与"盘上没变"的期望值必须是
 * 同一个字面量，否则两边各写一份，改一处就会静默变成假通过）。
 */
const FIXTURE_TEXT = 'line1\nline2\nline3\n'

async function runSelfTest(dispatch, { grants } = {}) {
  const out = { at: new Date().toISOString(), vscodeVersion: vscode.version, steps: [] }
  const step = async (name, fn) => {
    try {
      out.steps.push({ name, ok: true, result: await fn() })
    } catch (err) {
      out.steps.push({ name, ok: false, error: String(err?.message ?? err), code: err?.code ?? null })
    }
  }

  // 1) 造一个临时文件，用它验 openFile 的真路径
  const target = join(tmpdir(), `dsh-kit-selftest-${process.pid}.txt`)
  try {
    writeFileSync(target, 'line1\nline2\nline3\n', 'utf8')
    out.fixture = target
  } catch (err) {
    out.fixtureError = String(err?.message ?? err)
  }

  await step('openFile:text', async () => {
    const r = await dispatch('vscode.openFile', { path: target, line: 2, column: 1 })
    return r
  })
  await step('getSelection:afterOpen', async () => {
    const r = await dispatch('vscode.getSelection', {})
    return { file: r.file, isEmpty: r.isEmpty, textLen: r.text.length, start: r.start }
  })
  await step('openFile:missing', async () => {
    try {
      await dispatch('vscode.openFile', { path: join(tmpdir(), 'definitely-not-here-xyz.txt') })
      return { unexpected: 'should have thrown' }
    } catch (err) {
      return { expectedCode: err?.code, message: err?.message }
    }
  })
  await step('getSelection:untrustedGuard', async () => ({
    isTrusted: vscode.workspace.isTrusted,
  }))

  // 2) v0.2 新增两个能力：只能靠真机验，因为它们读的是 tabGroups / languages 的真实形状
  await step('listOpenEditors:shape', async () => {
    const r = await dispatch('vscode.listOpenEditors', { limit: 5 })
    return {
      total: r.total,
      returned: r.editors.length,
      truncated: r.truncated,
      // 上一步刚 openFile 过，这里至少应看到 1 个编辑器，且其中一个是 active
      hasFixture: r.editors.some((e) => e.file === target),
      activeCount: r.editors.filter((e) => e.isActive).length,
      first: r.editors[0] ?? null,
    }
  })
  await step('getDiagnostics:workspace', async () => {
    const r = await dispatch('vscode.getDiagnostics', { limit: 20 })
    return { total: r.total, files: r.files.length, truncated: r.truncated }
  })
  await step('getDiagnostics:singleFile', async () => {
    // 纯 txt 无诊断，期望 total===0；验证 path 分支能走通（真调 getDiagnostics(Uri)）
    const r = await dispatch('vscode.getDiagnostics', { path: target, limit: 20 })
    return { total: r.total, files: r.files.length }
  })
  await step('getDiagnostics:missing', async () => {
    try {
      await dispatch('vscode.getDiagnostics', { path: join(tmpdir(), 'definitely-not-here-xyz.txt') })
      return { unexpected: 'should have thrown' }
    } catch (err) {
      return { expectedCode: err?.code, message: err?.message }
    }
  })
  await step('getDiagnostics:badSeverity', async () => {
    try {
      await dispatch('vscode.getDiagnostics', { severity: 'fatal' })
      return { unexpected: 'should have thrown' }
    } catch (err) {
      return { expectedCode: err?.code, message: err?.message }
    }
  })

  // 3) T32：版本锚点的**事务内**判定 —— 这是单测/E2E 证明不了的那半边。
  //    单测里假宿主可以"配合"；这里用的是真实 `TextEditor.edit`（会让真
  //    `document.version` +1，和用户键入同一条路径）与真实 dispatch。
  await step('applyEdit:versionAnchor', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!root) return { skipped: 'no workspace folder open (writes must land inside a trusted root)' }
    if (!vscode.workspace.isTrusted) return { skipped: 'workspace not trusted' }

    const file = join(root, `dsh-selftest-anchor-${process.pid}.txt`)
    writeFileSync(file, FIXTURE_TEXT, 'utf8')
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true })

    // ① 锚点：用消费者会用的那条路（getDocumentState）拿版本
    const state = await dispatch('vscode.getDocumentState', { file })
    const expectedVersion = state.version

    // ② 一次**真实编辑**（走 TextEditor.edit，版本 +1 —— 这就是评审 B1 里"人工插一行"）
    const humanOk = await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'HUMAN '))
    const versionAfterHuman = doc.version

    // ③ 立刻用**旧版本**写：必须 -32012，且一个字都没写进去
    const grant = { id: randomBytes(16).toString('hex'), epoch: randomBytes(16).toString('hex') }
    const link = { name: 'selftest-local-link' }
    grants?.adopt({ id: grant.id, epoch: grant.epoch, link })
    let code = null
    let data = null
    try {
      await dispatch('vscode.applyEdit', {
        file,
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
        text: 'DSH!!',
        expectedVersion,
        // T35 起化身无条件必填：自检也得给，否则它先栽在锚点形状门（-32602），
        // 根本走不到这一刀真正要验的版本冲突。2026-10-22 那次真机 PASS 之后 T35 落地，
        // 这一步就一直红着，本轮 T39 复跑真机才发现。
        expectedIncarnation: state.incarnation,
        grant,
      }, { link })
    } catch (err) {
      code = err?.code ?? null
      data = err?.data ?? null
    }

    const textAfter = doc.getText()
    const evidence = {
      expectedVersion,
      versionAfterHuman,
      humanEditApplied: humanOk === true,
      code,
      data,
      versionUnchangedByRefusedWrite: doc.version === versionAfterHuman,
      humanKept: textAfter.includes('HUMAN '),
      nothingWritten: !textAfter.includes('DSH!!'),
      diskUnchanged: readFileSync(file, 'utf8') === FIXTURE_TEXT,
    }
    // 自检的判据写在这里：不是"跑通了"，是"旧版本写**必须被拒**"。
    if (code !== -32012) {
      throw new Error(`expected -32012 for a stale write, got ${String(code)} (${JSON.stringify(data)})`)
    }
    if (!evidence.nothingWritten) throw new Error('stale write landed: DSH!! is in the buffer')
    if (!evidence.versionUnchangedByRefusedWrite) throw new Error('the refused write still bumped the version')
    return evidence
  })

  // 4) T39：**真实落盘**（`vscode.save`）。这一刀单测和 E2E 都证明不了：
  //    真 `document.save()`、真 `statSync`、真保存参与者。判据是「返回值等于保存后
  //    的真值」而不是「跑通了」，所以两件坏事都会被抓到：
  //      · 返回体回显 `expectedDisk`（而不是重新 stat）→ `returnedDisk !== actualAfter`
  //      · 磁盘锚点门被绕过 → 第二次过期锚点调用**成功**（拿不到 -32013）
  await step('save:diskAnchor', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!root) return { skipped: 'no workspace folder open (writes must land inside a trusted root)' }
    if (!vscode.workspace.isTrusted) return { skipped: 'workspace not trusted' }

    const file = join(root, `dsh-selftest-save-${process.pid}.txt`)
    writeFileSync(file, 'alpha\nbeta\n', 'utf8')
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true })

    // ① 锚点：版本/化身走消费者同一条路（getDocumentState），磁盘锚点走真 stat
    const state = await dispatch('vscode.getDocumentState', { file })
    const st = statSync(file)
    const expectedDisk = { mtime: Math.floor(st.mtimeMs), size: st.size }

    // ② 人工改缓冲区 → 脏（意图门的输入）
    const edited = await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'DSH-SAVED '))
    const versionAfterEdit = doc.version

    // ③ 授权：`allowDirtySave` 只长在 grant 上（放 params 等于自己给自己授权）
    const grant = { id: randomBytes(16).toString('hex'), epoch: randomBytes(16).toString('hex') }
    const link = { name: 'selftest-save-link' }
    grants?.adopt({ id: grant.id, epoch: grant.epoch, link, allowDirtySave: true })

    const res = await dispatch('vscode.save', {
      file,
      expectedVersion: versionAfterEdit,
      expectedIncarnation: state.incarnation,
      expectedDisk,
      grant,
    }, { link })

    const after = statSync(file)
    const actualAfter = { mtime: Math.floor(after.mtimeMs), size: after.size }
    const diskText = readFileSync(file, 'utf8')
    const evidence = {
      expectedDisk,
      returnedDisk: res.disk,
      actualAfter,
      saved: res.saved,
      dirtyBefore: res.dirtyBefore,
      versionBefore: state.version,
      versionAfterEdit,
      bufferEdited: edited === true,
      sizeChanged: actualAfter.size !== expectedDisk.size,
      mtimeChanged: actualAfter.mtime !== expectedDisk.mtime,
      diskTextHasMarker: diskText.includes('DSH-SAVED '),
    }
    if (res.saved !== true) throw new Error(`expected saved:true, got ${String(res.saved)}`)
    if (res.disk?.mtime !== actualAfter.mtime || res.disk?.size !== actualAfter.size) {
      throw new Error(`returned disk is not the post-save stat truth: ${JSON.stringify(res.disk)} vs ${JSON.stringify(actualAfter)}`)
    }
    if (!evidence.sizeChanged) throw new Error('disk size did not change after save')
    if (!evidence.diskTextHasMarker) throw new Error('saved bytes do not contain the edited buffer content')
    if (res.dirtyBefore !== true) throw new Error('dirtyBefore must be true (the buffer was edited before save)')

    // ④ 故意用**过期磁盘锚点**复跑：必须 -32013，且文件一个字节都不许动
    const bytesBefore = readFileSync(file)
    const statBefore = statSync(file)
    let staleCode = null
    let staleData = null
    try {
      await dispatch('vscode.save', {
        file,
        expectedVersion: doc.version,
        expectedIncarnation: state.incarnation,
        expectedDisk,
        grant,
      }, { link })
    } catch (err) {
      staleCode = err?.code ?? null
      staleData = err?.data ?? null
    }
    const bytesAfter = readFileSync(file)
    const statAfter = statSync(file)
    const staleRetry = {
      code: staleCode,
      name: ERR_NAME[staleCode] ?? null,
      reason: staleData?.reason ?? null,
      expected: staleData?.expected ?? null,
      actual: staleData?.actual ?? null,
      mtimeUnchanged: statAfter.mtimeMs === statBefore.mtimeMs,
      sizeUnchanged: statAfter.size === statBefore.size,
      bytesUnchanged: bytesAfter.equals(bytesBefore),
    }
    if (staleCode !== -32013) {
      throw new Error(`expected -32013 for a stale disk anchor, got ${String(staleCode)} (${JSON.stringify(staleData)})`)
    }
    if (!staleRetry.bytesUnchanged) throw new Error('stale save modified the file on disk')
    return { ...evidence, staleRetry }
  })

  // 5) T44：**隔离归档**（`vscode.deleteFile`）。这一格原来按 T40 语义断言
  //    `deleted:true` + 回收站 `trashed:'unknown'`；T44 已裁决"**不删任何字节**，
  //    只把目标 rename 进 `<工作区根>/.dsh-quarantine/<UTC 时间戳>-<原名>`
  //    （跨卷 EXDEV 整个拒、绝不退化 copy+delete）"，所以断言换成隔离语义。
  //    真机才能证明的三件事：① 真确认框真的会拦住人；② 真 rename 真的让原路径消失、
  //    隔离体真的在盘上；③ 隔离体字节与回执里的 `quarantinedSha256` 一致。
  //    ⚠️ 只动本步骤自己刚造出来的 fixture（工作区根下 `dsh-selftest-delete-*`）；
  //       本步骤**一个字节都不销毁**，隔离体留在 `.dsh-quarantine/` 里供人复核。
  await step('delete:confirm', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!root) return { skipped: 'no workspace folder open (deletes must land inside a trusted root)' }
    if (!vscode.workspace.isTrusted) return { skipped: 'workspace not trusted' }

    const file = join(root, `dsh-selftest-delete-accept-${process.pid}.txt`)
    writeFileSync(file, 'delete me\nsecond line\n', 'utf8')
    // 打开它：人要能看见"要删的是这个"才谈得上同意。
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true })

    const state = await dispatch('vscode.getDocumentState', { file })
    const st = statSync(file)
    const expectedDisk = { mtime: Math.floor(st.mtimeMs), size: st.size }
    const grant = { id: randomBytes(16).toString('hex'), epoch: randomBytes(16).toString('hex') }
    const link = { name: 'selftest-delete-link' }
    grants?.adopt({ id: grant.id, epoch: grant.epoch, link })

    // ★ 人在这里点"删除"（模态，超时 120s）。这一行会真的等一个人。
    const startedAt = Date.now()
    let res = null
    let failure = null
    try {
      res = await dispatch('vscode.deleteFile', {
        file,
        expectedVersion: state.version,
        expectedIncarnation: state.incarnation,
        expectedDisk,
        grant,
      }, { link })
    } catch (err) {
      failure = err
    }
    const waitedMs = Date.now() - startedAt
    // ★ 隔离语义的三个可核对面都在盘上量：原路径没了 / 隔离体在 / 隔离体字节真身是多少。
    //   隔离体位置只接受回执里的 `to`（不自己拼路径：拼出来的"对上"证明不了什么）。
    const quarantinePath = typeof res?.to === 'string' ? res.to : null
    const quarantineBytes = quarantinePath && existsSync(quarantinePath)
      ? readFileSync(quarantinePath)
      : null
    const quarantineSha = quarantineBytes === null
      ? null
      : createHash('sha256').update(quarantineBytes).digest('hex')
    const evidence = {
      file,
      waitedMs,
      beforeStat: expectedDisk,
      existsAfter: existsSync(file),
      quarantinedPath: quarantinePath,
      quarantineDir: quarantinePath === null ? null : dirname(quarantinePath),
      quarantinedExists: quarantineBytes !== null,
      quarantinedByteLength: quarantineBytes?.length ?? null,
      quarantinedShaRecomputed: quarantineSha,
      quarantinedShaReported: res?.quarantinedSha256 ?? null,
      bytesChanged: res?.bytesChanged ?? null,
      result: res ?? null,
      error: failure
        ? {
            code: failure.code ?? null,
            name: ERR_NAME[failure.code] ?? null,
            reason: failure.data?.reason ?? null,
            message: failure.message,
          }
        : null,
    }
    if (failure) {
      throw new Error(`real quarantine failed: ${String(failure.code)} `
        + `${String(failure.data?.reason ?? '')} ${failure.message}`)
    }
    // ① 语义：是"隔离"，不是"删除" —— 字段本身就是判据（铁律 11：不许出现 deleted/trashed）。
    if (res.quarantined !== true) {
      throw new Error(`expected quarantined:true, got ${JSON.stringify(res.quarantined)}`)
    }
    const forbidden = ['deleted', 'trashed']
      .filter((k) => Object.prototype.hasOwnProperty.call(res, k))
    if (forbidden.length > 0) {
      throw new Error(`T44 语义下返回体不许出现 ${forbidden.join('/')}（实际：`
        + `${JSON.stringify(forbidden.map((k) => [k, res[k]]))}）`)
    }
    // ② 原路径消失，隔离体真的在盘上。
    if (evidence.existsAfter) throw new Error('the original path still exists after a reported quarantine')
    if (!evidence.quarantinedExists) {
      throw new Error(`the quarantine body is missing at ${String(quarantinePath)}`)
    }
    // ③ 隔离体字节 = 回执里的 `quarantinedSha256`（那一份是移动**之后**在隔离体上实测的）。
    if (quarantineSha !== res.quarantinedSha256) {
      throw new Error(`quarantinedSha256 does not match the bytes on disk: reported `
        + `${String(res.quarantinedSha256)}, recomputed ${String(quarantineSha)}`)
    }
    if (res.quarantine?.retained !== true) {
      throw new Error('quarantine.retained must be true (this body is the one to keep), got '
        + `${JSON.stringify(res.quarantine)}`)
    }
    // ④ 整份备份必须交出来（I1）：交不出恢复材料就不许动别人的文件。
    if (res.backup?.delivered !== true) {
      throw new Error(`backup.delivered must be true, got ${JSON.stringify(res.backup)}`)
    }
    if (typeof res.snapshot?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(res.snapshot.sha256)) {
      throw new Error(`snapshot.sha256 missing/malformed: ${JSON.stringify(res.snapshot)}`)
    }
    // ⑤ `bytesChanged`：**两种取值都算通过** —— false = 归档前后字节一致；true = 归档后
    //    被就地改写过（那是 design：确认时那份在 `snapshot`，盘上这份在 `to`，两份都在）。
    //    唯一的要求是"如实"：它必须等于隔离体实测 vs 人确认时那份的**真实差异**。
    //    这里重算差异再比，断言的是诚实性，不是某个期望值。
    if (typeof res.bytesChanged !== 'boolean') {
      throw new Error(`bytesChanged must be a boolean, got ${JSON.stringify(res.bytesChanged)}`)
    }
    const reallyChanged = quarantineSha !== res.confirmedSha256
      || evidence.quarantinedByteLength !== res.confirmedByteLength
    if (res.bytesChanged !== reallyChanged) {
      throw new Error(`bytesChanged=${String(res.bytesChanged)} is not honest: quarantined vs `
        + `confirmed differ = ${String(reallyChanged)} (confirmed `
        + `${String(res.confirmedSha256)}/${String(res.confirmedByteLength)}, quarantined `
        + `${String(res.quarantinedSha256)}/${String(evidence.quarantinedByteLength)})`)
    }
    return evidence
  })

  // 6) T40：**取消确认**也必须真机走一遍 —— 这是 `-32002` 在项目里第一次真正被抛出，
  //    "人拒绝了所以什么都没发生"只有真文件还在才算证明（假宿主的"还在"是假话）。
  await step('delete:decline', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!root) return { skipped: 'no workspace folder open' }
    if (!vscode.workspace.isTrusted) return { skipped: 'workspace not trusted' }

    const file = join(root, `dsh-selftest-delete-cancel-${process.pid}.txt`)
    const text = 'keep me\nthis one must survive\n'
    writeFileSync(file, text, 'utf8')
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true })

    const state = await dispatch('vscode.getDocumentState', { file })
    const st = statSync(file)
    const expectedDisk = { mtime: Math.floor(st.mtimeMs), size: st.size }
    const grant = { id: randomBytes(16).toString('hex'), epoch: randomBytes(16).toString('hex') }
    const link = { name: 'selftest-delete-decline-link' }
    grants?.adopt({ id: grant.id, epoch: grant.epoch, link })

    // ★ 人在这里点"取消"（或关掉对话框）。
    let code = null
    let detail = null
    try {
      await dispatch('vscode.deleteFile', {
        file,
        expectedVersion: state.version,
        expectedIncarnation: state.incarnation,
        expectedDisk,
        grant,
      }, { link })
    } catch (err) {
      code = err?.code ?? null
      detail = err?.data ?? null
    }
    const stillThere = existsSync(file)
    const textAfter = stillThere ? readFileSync(file, 'utf8') : null
    const evidence = {
      file,
      code,
      name: ERR_NAME[code] ?? null,
      reason: detail?.reason ?? null,
      mayHaveApplied: detail?.mayHaveApplied ?? null,
      stillThere,
      bytesIntact: textAfter === text,
    }
    if (code !== ERR.DECLINED) {
      throw new Error(`expected -32002 declined after cancelling, got ${String(code)} `
        + `(${JSON.stringify(detail)})`)
    }
    if (!stillThere) throw new Error('the declined delete removed the file anyway')
    if (!evidence.bytesIntact) throw new Error('the declined delete changed the file content')
    return evidence
  })

  try {
    const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(), '.dsh', 'dsh-vscode-kit')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `selftest-${process.pid}.json`), JSON.stringify(out, null, 2), 'utf8')
    out.writtenTo = join(dir, `selftest-${process.pid}.json`)
  } catch (err) {
    out.writeError = String(err?.message ?? err)
  }
  return out
}

export function activate(context) {
  if (ctx.instance) return ctx.instance
  const output = vscode.window.createOutputChannel('DSH Kit Bridge')
  ctx.output = output
  const log = (msg, level = 'info') => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`
    try { output.appendLine(line) } catch { /* ignore */ }
  }

  const cfg = readConfig()
  // 授权表与"当前活连接"共享槽都由 dispatcher 建：能力层（执行前复核）与连接层
  // （收 bridge.grant / 断线置失效）**必须共用同一份**，否则判定与状态各说各话。
  const { dispatch, capabilities, grants, linkState, host } = createDispatcher(output, { deleteConfirmTimeoutMs: cfg.deleteConfirmTimeoutMs })
  log(`capabilities: ${capabilities.join(', ')}`)

  /**
   * 事件正文闸的初始策略（E3）。
   *
   * 之前这一行是**缺的** —— `createConnector` 拿不到 `editorEventFilter`，
   * `createEditorEvents` 的 `setPolicy(undefined)` 就落成 `roots: []`，于是
   * `bodyAllowed()` 恒为 false：E2 的 delta 在真机上**永远不跑**（不是"跑得少"，是一次都不跑）。
   *
   * 现在它显式给出三件事，全部按决策 2 的默认口径：
   *  - `roots`：工作区根（正文只在工作区内允许）；
   *  - `textMode: 'metadata'`：**默认不带正文**；
   *  - `files: null`：没有文件白名单 = 不做文件级筛选，但 delta 另有"必须给 files"的门。
   *
   * 这不是"最终策略"：订阅进来后 broker 会用 `policyFor()` 的联合策略覆盖它
   * （`attach({ configure })` → `editorEvents.configure(policy)`），所以真正决定
   * "发不发正文"的是**订阅**，不是这里。这里只保证"没人订阅时也是最小面"。
   */
  const initialEventFilter = {
    roots: Array.isArray(vscode.workspace?.workspaceFolders)
      ? vscode.workspace.workspaceFolders.map((f) => f?.uri?.fsPath).filter((p) => typeof p === 'string' && p !== '')
      : [],
    files: null,
    types: null,
    textMode: 'metadata',
  }

  const connector = createConnector({
    dispatch,
    grants,
    linkState,
    events: true,
    editorEventHost: host.editorEvents,
    editorEventFilter: initialEventFilter,
    // E3：**谁想看**由订阅决定（`vscode.events.subscribe`），不是由扩展自己开一条流。
    // 这里只是把生产者接上；没有订阅 ⇒ `eventBroker.allowsPublish()` 为 false ⇒ 一个字节都不发。
    // 审阅 F7：连接层的绑定门也要先问信任 —— 否则「未信任工作区」这个事实
    // 会随「带不带 grant」变成两种回答（-32010 / -32006），调用方分不清该做什么。
    isTrusted: () => vscode.workspace.isTrusted,
    // ★ W3（多窗口寻址 §6）：**身份候选**，只随 hello 上报，DSH 侧拿它签发 / 匹配 windowId。
    //   本端一个字都不判它（不参与准入、不参与授权、不参与版本门）；
    //   整个字段删掉，两端照常工作，只是窗口号退化成 `tmp-<connSeq>`。
    //   采集必须是纯读 + 无副作用：connector 会把它包在 try/catch 里，抛了只是这块不出现。
    describeWindow: () => {
      const ws = vscode.workspace
      const folders = Array.isArray(ws?.workspaceFolders)
        ? ws.workspaceFolders
          .map((f) => f?.uri?.fsPath)
          .filter((p) => typeof p === 'string' && p !== '')
        : []
      const name = typeof ws?.name === 'string' && ws.name !== '' ? ws.name : null
      return {
        // `env.sessionId` 是 VS Code 给的**窗口**会话标识（一个窗口一个）——
        // 它不是安全凭据，只用来"同一个窗口重连后还认得出自己"。
        sessionId: vscode.env?.sessionId ?? null,
        workspace: (name || folders.length > 0) ? { name, folders } : null,
        uiKind: vscode.env?.uiKind ?? null,
        remoteName: vscode.env?.remoteName ?? null,
      }
    },
    log,
    dshHome: cfg.dshHome,
    pollIntervalMs: cfg.pollIntervalMs,
    onStateChange: (state) => {
      log(`state → ${state.state}${state.port ? ` (port ${state.port})` : ''}`)
    },
  })
  ctx.connector = connector
  if (cfg.enabled) connector.start()
  else { connector.stop(); log('disabled by dshKit.enabled; not connecting') }

  // 自检（默认关）：仅当配置打开时跑，结果落 ~/.dsh/dsh-vscode-kit/selftest-<pid>.json
  if (cfg.selfTestOnStart) {
    const selfTestKey = `selftestRun:${vscode.version}`
    ;(async () => {
      const result = await runSelfTest(dispatch, { grants })
      const pass = result.steps.every((s) => s.ok)
      log(`self-test ${pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(result.steps.map((s) => `${s.name}=${s.ok}`))}`)
      ctx.selfTest = { ...result, key: selfTestKey }
    })()
  }

  const owned = [
    output,
    { dispose: () => connector.stop() },

    vscode.commands.registerCommand('dshKit.showStatus', () => {
      const s = connector.state
      const text = connector.connected
        ? `已连接 DSH（port ${s.port}, pid ${s.pid}, dsh ${s.dshVersion ?? 'unknown'}）`
        : `未连接（状态 ${s.state}，原因 ${s.reason ?? '无'}，尝试 ${connector.attempts} 次）`
      log(`status: ${text}`)
      vscode.window.showInformationMessage(`DSH Kit: ${text}`)
    }),

    vscode.commands.registerCommand('dshKit.reconnect', async () => {
      await connector.reconnect()
      vscode.window.showInformationMessage('DSH Kit: 已尝试重新连接，详见输出面板')
    }),

    vscode.commands.registerCommand('dshKit.revokeTrust', () => {
      // 首版信任模型是「用户主动安装扩展」= 已信任；撤销即禁用扩展。
      vscode.window.showInformationMessage(
        'DSH Kit: 本版本信任模型为「安装即信任」。要撤销请禁用或卸载本扩展。',
      )
    }),

    vscode.commands.registerCommand('dshKit.selfTest', async () => {
      const result = await runSelfTest(dispatch, { grants })
      const pass = result.steps.every((s) => s.ok)
      const text = result.steps.map((s) => `${s.ok ? 'PASS' : 'FAIL'} ${s.name}${s.ok ? '' : ` — ${s.error}`}`).join('\n')
      log(`self-test ${pass ? 'PASS' : 'FAIL'}\n${text}`)
      const pick = await vscode.window.showInformationMessage(
        `DSH Kit 自检：${pass ? '全部通过' : '有失败项'}`,
        { modal: false }, '查看输出',
      )
      if (pick === '查看输出') output.show()
      return result
    }),

    // 配置变化：只有影响连接构建的键才需要重启扩展宿主。
    // 曾经的写法是「任何 dshKit.* 变更都 reloadWindow」，那会在用户只是点开一个
    // 检查框、或自检临时开关时把正在执行的命令连根拔掉（真机自检就是这么被杀的）。
    vscode.workspace.onDidChangeConfiguration((e) => {
      const needsRestart = RESTART_KEYS.some((k) => e.affectsConfiguration(`dshKit.${k}`))
      if (!needsRestart) {
        if (e.affectsConfiguration('dshKit.enabled')) {
          const nowEnabled = readConfig().enabled
          log(`enabled -> ${nowEnabled}; ${nowEnabled ? 'reconnecting' : 'stopping bridge'}`)
          if (nowEnabled) connector.start()
          else connector.stop()
        }
        return
      }
      log('connection config changed; reloading window')
      vscode.commands.executeCommand('workbench.action.reloadWindow')
    }),
  ]
  ctx.disposables = owned.map((disposable) => {
    let disposed = false
    return { dispose() { if (!disposed) { disposed = true; disposable.dispose() } } }
  })
  context.subscriptions.push(...ctx.disposables)
  ctx.instance = { connector }
  log('activated')
  return ctx.instance
}

export function deactivate() {
  for (const disposable of ctx.disposables.splice(0).reverse()) {
    try { disposable.dispose() } catch { /* continue releasing other resources */ }
  }
  ctx.connector = null
  ctx.output = null
  ctx.instance = null
}

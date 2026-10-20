/**
 * 扩展入口：activate / deactivate。
 *
 * 职责刻意压到最小 —— 读配置、建 output channel、建 dispatcher、起 connector、
 * 注册命令与生命周期。所有业务逻辑都在 capabilities.js / connector.js 里，
 * 那两个文件不 import vscode，可单测。
 */

import * as vscode from 'vscode'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDispatcher } from './vscode-host.js'
import { createConnector } from './connector.js'

/** @type {{connector: any, output: vscode.OutputChannel|null}} */
const ctx = { connector: null, output: null }

/** 这些配置键改变后必须重建扩展宿主（改 dshHome / 轮询间隔需要新连接器）。 */
const RESTART_KEYS = ['dshHome', 'pollIntervalMs']

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('dshKit')
  return {
    enabled: cfg.get('enabled', true),
    dshHome: cfg.get('dshHome', '') || undefined,
    pollIntervalMs: cfg.get('pollIntervalMs', 2000),
    selfTestOnStart: cfg.get('selfTestOnStart', false),
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
async function runSelfTest(dispatch) {
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
  const output = vscode.window.createOutputChannel('DSH Kit Bridge')
  ctx.output = output
  const log = (msg, level = 'info') => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`
    try { output.appendLine(line) } catch { /* ignore */ }
  }

  const cfg = readConfig()
  if (!cfg.enabled) {
    log('disabled by dshKit.enabled; not connecting')
    return { disabled: true }
  }

  const { dispatch, capabilities } = createDispatcher(output)
  log(`capabilities: ${capabilities.join(', ')}`)

  const connector = createConnector({
    dispatch,
    log,
    dshHome: cfg.dshHome,
    pollIntervalMs: cfg.pollIntervalMs,
    onStateChange: (state) => {
      log(`state → ${state.state}${state.port ? ` (port ${state.port})` : ''}`)
    },
  })
  ctx.connector = connector
  connector.start()

  // 自检（默认关）：仅当配置打开时跑，结果落 ~/.dsh/dsh-vscode-kit/selftest-<pid>.json
  if (cfg.selfTestOnStart) {
    const selfTestKey = `selftestRun:${vscode.version}`
    ;(async () => {
      const result = await runSelfTest(dispatch)
      const pass = result.steps.every((s) => s.ok)
      log(`self-test ${pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(result.steps.map((s) => `${s.name}=${s.ok}`))}`)
      ctx.selfTest = { ...result, key: selfTestKey }
    })()
  }

  context.subscriptions.push(
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
      const result = await runSelfTest(dispatch)
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
  )

  log('activated')
  return { connector }
}

export function deactivate() {
  try { ctx.connector?.stop() } catch { /* ignore */ }
  ctx.connector = null
}

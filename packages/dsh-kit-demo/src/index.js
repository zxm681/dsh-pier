/**
 * 示例消费者插件：证明「第三方 DSH 插件」接入编辑器能力时的耦合度有多低。
 *
 * 这个文件是整套设计的试金石。它必须做到：
 *  - 只 import 协议库的公开 API，**不知道** TCP / 端口 / 发现文件 / token 的存在；
 *  - 不改 DSH 核心，不 import cordis，不碰 VSCode；
 *  - 拿不到编辑器时优雅降级，而不是崩掉。
 *
 * 提供工具：`editor.readSelection` 与 `editor.openFile`。
 */

export const name = 'dsh-kit-demo'

/**
 * 依赖注入声明：等 dshVscodeKit 服务就绪后本插件才加载。
 * 注意这是**字符串数组**，纯声明，不需要 import cordis（见打样日志 §1.1 实测）。
 */
export const inject = ['dshVscodeKit']

/**
 * @param {object} ctx    cordis 上下文（本插件只用 ctx.get / ctx.provide / ctx.effect）
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const log = config.onLog ?? (() => {})
  const service = ctx.get('dshVscodeKit')
  if (!service) {
    log('dshVscodeKit service unavailable; demo plugin stays idle')
    return
  }

  /**
   * **显式声明身份与档位**（契约 §6.2.8 第 3 条：白名单粒度是「插件名 × 最高档位」）。
   *
   * 两条容易搞反的语义，写在这里当示范：
   *  - `declared` 是**上限声明**，不是许可：本插件只用到只读两能力
   *    （`vscode.getSelection` / `vscode.openFile`），所以声明 `read` 就够；
   *    就算这里写成 `delete`，宿主配置没给也照样拒 —— 生效档位 = min(声明, 配置)。
   *  - 身份由**入口**决定，不是调用时填的：`forPlugin(name)` 就是"我是谁"这一步，
   *    共享的 `kit.vscode.*` 天花板硬编码 `read`（写入必须走已绑定的入口）。
   *
   * 声明得低只影响自己（写类会被拒），声明得高也不提权，所以这里如实写 `read`。
   */
  const kit = typeof service.forPlugin === 'function'
    ? service.forPlugin('dsh-kit-demo', { declared: 'read' })
    // 旧版 kit 没有 forPlugin：退回共享 facade（它同样只能到 read，不静默提权）。
    : service

  /**
   * 读编辑器选区。相对路径/无选区等失败一律转成可读文本，
   * 让上层（AI/用户）看到原因而不是一个裸异常。
   */
  async function readSelection() {
    try {
      const sel = await kit.vscode.getSelection()
      if (sel.isEmpty) return { ok: true, empty: true, file: sel.file, text: '' }
      return { ok: true, ...sel }
    } catch (err) {
      return { ok: false, code: err?.code, message: err?.message ?? String(err) }
    }
  }

  /**
   * 在编辑器里打开文件。path 应尽量传绝对路径 ——
   * 相对路径会按 VSCode 工作区根解析，可能与 DSH 会话的 cwd 不同（踩坑 #32）。
   */
  async function openFile(path, position = {}) {
    try {
      const r = await kit.vscode.openFile({ path, ...position })
      return { ok: true, ...r }
    } catch (err) {
      return { ok: false, code: err?.code, message: err?.message ?? String(err) }
    }
  }

  // 对外暴露成服务，便于别的插件/测试调用（也演示了「不耦合」的接法）。
  const demo = { readSelection, openFile }
  ctx.provide?.('dshKitDemo', demo)

  /**
   * 冒烟探针（默认关）：在**真实 DSH 进程**里经真实桥接调用真实 VSCode，
   * 把结果写到 outFile。这是唯一能证明「四段式链路全通」的验证方式 ——
   * 单测与 E2E 两侧用的都是假宿主，证明不了真编辑器那半边。
   */
  if (config.smoke?.path) {
    ;(async () => {
      const result = { at: new Date().toISOString(), pid: process.pid, steps: [] }
      // 判定要连「业务失败」一起看：demo 的 openFile 把错误吞成 {ok:false}，
      // 只看异常会把「方法不存在」当成通过（真机踩过，smoke 报 PASS 其实是全失败）。
      const step = async (n, fn) => {
        try {
          const value = await fn()
          const businessFail = value && typeof value === 'object' && value.ok === false
          result.steps.push({
            name: n,
            ok: !businessFail,
            result: value,
            ...(businessFail ? { error: value.message ?? 'returned ok:false' } : {}),
          })
        } catch (err) {
          result.steps.push({ name: n, ok: false, code: err?.code ?? null, error: String(err?.message ?? err) })
        }
      }
      await step('kit.waitReady', () => kit.waitReady?.(5000) ?? true)
      // delayMs：验证脚本用来在「编辑器已连上」与「发起请求」之间插入事件
      // （比如挂一条不说话的裸连接，验证它抢不到 active 位）。默认 0。
      if (config.smoke.delayMs > 0) {
        await new Promise((r) => setTimeout(r, config.smoke.delayMs))
      }
      await step('kit.snapshot', async () => kit.snapshot?.() ?? null)
      await step('vscode.openFile', () => openFile(config.smoke.path, { line: 2, column: 1 }))
      await step('vscode.getSelection', () => readSelection())
      result.pass = result.steps.every((s) => s.ok)
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(config.smoke.outFile), { recursive: true })
        writeFileSync(config.smoke.outFile, JSON.stringify(result, null, 2), 'utf8')
        log(`smoke ${result.pass ? 'PASS' : 'FAIL'} -> ${config.smoke.outFile}`)
      } catch (err) {
        log(`smoke write failed: ${String(err?.message ?? err)}`)
      }
    })()
  }

  log(`dsh-kit-demo ready (kit.ready=${kit.ready})`)
  return demo
}

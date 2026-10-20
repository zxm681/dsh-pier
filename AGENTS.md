# dsh-vscode-dev

DSH ↔ VS Code 通用桥接通道。设计文档在 `docs/`，代码在 `packages/`。

## 铁律（都是踩过坑换来的，改动前先读 docs/phase7-经验手册.md）

1. **`ctx.provide` 不许传 check 谓词**。它是 get 时门禁，不是就绪通知；会让消费者永久 pending。
   就绪状态在 facade 方法内部判断，需要等的消费者显式 `waitReady(ms)`。
2. **服务返回的 facade 方法必须稳定存在**。不许在未就绪时返回 `{}` 或 `null`——
   裸 TypeError 是最糟的失败形态，且消费者解构后会永远好不了。
3. **协议库零依赖**，不 import `@deepseek-ai/*`（那是未公开的 loader hook 契约）。
4. **所有定时器 `unref()`**，库不许延长宿主进程寿命。E2E fixture 要自己挂 keepalive。
5. **优雅关闭要显式 `socket.destroy()`**，只 `link.close()` 会让 `server.close()` 挂死。
6. **转义/剥离在边界一次做完**。CRLF 在分帧层剥，1-based→0-based 只在 VSCode API 边界转。
7. **改完立刻跑 import smoke**：`node -e "import('./src/index.js')"`，比全量测试快。

## 验证门槛（声称完成前必须全绿）

```bash
cd packages/dsh-vscode-kit && node --test "test/*.test.js"   # 38
cd packages/dsh-kit-bridge && node --test "test/*.test.js"   # 17
cd packages/dsh-kit-demo   && node --test "test/*.test.js"   # 7
cd packages/dsh-kit-bridge && node scripts/e2e.mjs           # 11
```

涉及真实宿主语义的改动（服务注册、配置监听、VSCode API 调用）**必须真机验证**，
单测和 E2E 都用假宿主，证明不了那半边。步骤见 `docs/phase6-验收报告.md` §6。

## 目录

- `packages/dsh-vscode-kit/` — DSH 侧协议库（零依赖）
- `packages/dsh-kit-bridge/` — VS Code 薄扩展（CJS + esbuild bundle）
- `packages/dsh-kit-demo/` — 示例消费者
- `docs/` — 阶段文档 1–7，改设计前必读 phase2（边界）和 phase7（坑）
- `work/` — 真机验证的 overlay、探针脚本、smoke 产物

## 加新能力的三步

1. `packages/dsh-kit-bridge/src/capabilities.js`：加 `CAPABILITIES` 条目 + handler（不 import 'vscode'，走 host 注入）
2. `packages/dsh-vscode-kit/src/index.js`：`VscodeKit.vscode` 加一行糖衣转发
3. 两侧各加单测；跑 E2E；真机验一次

协议层（`protocol.js` / `server.js`）**不需要改**。如果需要改，说明能力设计有问题，先回来讨论。

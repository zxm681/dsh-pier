# dsh-vscode-dev：DSH ↔ VS Code 通用桥接（打样项目）

把 VS Code 的能力（当前 4 个：打开文件、读选区、读诊断、列已开编辑器）开放给**任意 DSH 插件**，
方式是标准化的通道 + 公开 API，而不是让每个插件各自去写 VSCode 集成。

## 现状

**打样完成，六条验收标准全过。** 四段式链路已在真机（真 DSH 进程 + 真 VS Code）跑通。

| 阶段 | 产物 | 状态 |
|---|---|---|
| 1 盘点 | `phase1-盘点报告.md` | ✅ |
| 2 需求 | `phase2-需求文档.md` | ✅ |
| 3 可行性 | `phase3-可行性分析.md` | ✅ GO |
| 4 架构 | `phase4-架构草图.md` | ✅ |
| 5 打样 | `phase5-打样日志.md` + `packages/` | ✅ |
| 6 验收 | `phase6-验收报告.md` | ✅ 6/6 |
| 7 经验 | `phase7-经验手册.md` | ✅ |
| 8 手册指导开发 | 加了 `getDiagnostics` / `listOpenEditors` | ✅ 抓到出口路径 bug |

## 结构与链路

```
消费者 DSH 插件 (dsh-kit-demo)
      ↓ 只用公开 API：kit.vscode.openFile / getSelection
协议库 (dsh-vscode-kit)          ← 零依赖、传输无关
      ↓ loopback TCP + ndjson + token
VS Code 薄扩展 (dsh-kit-bridge)  ← 只 import 'vscode'
      ↓ 官方 API
VS Code
```

## 三个包

| 包 | 作用 | 测试 |
|---|---|---|
| `packages/dsh-vscode-kit` | DSH 侧协议库 + TCP server + 发现文件 + 插件入口 | 38 ✅ |
| `packages/dsh-kit-bridge` | VS Code 侧薄扩展（vsix 可装） | 17 ✅ + E2E 11 ✅ |
| `packages/dsh-kit-demo` | 示例消费者，证明零耦合接入 | 7 ✅ |

## 快速开始

```bash
# 装 VS Code 扩展
code --install-extension packages/dsh-kit-bridge/dsh-kit-bridge-0.1.0.vsix

# 把库放进共享 node_modules（DSH 的 bare import 从 profiles/node_modules 解析）
cp -r packages/dsh-vscode-kit  ~/.dsh/profiles/node_modules/
cp -r packages/dsh-kit-demo    ~/.dsh/profiles/node_modules/

# 起 DSH（overlay 注入，不改 profile 文件）
dsh --profile web --patch ./work/realtest-overlay.yml --port 3099 --no-open
```

消费者插件这么用：

```js
export const name = 'my-plugin'
export const inject = ['dshVscodeKit']

export function apply(ctx) {
  const kit = ctx.get('dshVscodeKit')
  // 一行调用，不知道 TCP / 端口 / token / 发现文件的存在
  await kit.vscode.openFile({ path: 'D:/x/y.txt', line: 2, column: 1 })
  const sel = await kit.vscode.getSelection()
}
```

## 跑测试

```bash
cd packages/dsh-vscode-kit   && node --test "test/*.test.js"   # 38
cd packages/dsh-kit-bridge   && node --test "test/*.test.js"   # 17
cd packages/dsh-kit-demo     && node --test "test/*.test.js"   # 7
cd packages/dsh-kit-bridge   && node scripts/e2e.mjs           # 11 跨进程
```

## 能力面（首版刻意做小）

| 能力 | 参数 | 返回 |
|---|---|---|
| `vscode.openFile` | `{path, line?, column?, preview?}` | `{opened, path, mode:'text'\|'external'}` |
| `vscode.getSelection` | — | `{text, file, start:{line,column}, end, isEmpty}`（1-based） |

错误码：`-32001` 未授权 / `-32002` 拒绝 / `-32003` 未找到 / `-32004` 超时 /
`-32005` 不支持（应降级）/ `-32006` 工作区未信任 / `-32007` 编辑器未连接。

## 明确不做

编辑器内容注入、逐能力授权白名单、多 VSCode 仲裁、Remote/WSL 反向、
Marketplace 发布、面板 UI。详见 `phase2-需求文档.md` 的 out-of-scope。

## 已知未验证

多窗口仲裁行为、macOS/Linux、VS Code 1.91–1.141、长期运行稳定性。
详见 `phase7-经验手册.md` §8。

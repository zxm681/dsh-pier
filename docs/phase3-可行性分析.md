# 阶段 3 可行性分析：VSCode ↔ DSH 桥接协议库（打样范围）

> 状态：完成，结论 = **可行（GO）**。进入阶段 4 架构草图。
> 日期：2026-10-21。依据：phase1-盘点报告.md + phase2-需求文档.md。

---

## 一、结论先行

**可行。** 目标不要求任何未验证的新技术：通道、发现文件、协议模式均有 MIT 先例可套（dsh-vscode-bridge / dsh-acp-door）；唯一「新」的部分——协议泛化（namespace + 能力注册 + 多消费者）——是成熟设计模式，不涉技术赌注。最大风险不在能不能做，而在 DSH 内部 API 的版本稳定性，已用「握手报版本 + 能力降级」化解。

## 二、逐项可行性

| 项 | 依据 | 结论 |
|---|---|---|
| 外部进程能否驱动已运行 DSH | dsh-acp-door、dsh-vscode-bridge(EPCN-fla) 已量产 | ✅ |
| DSH 侧开 loopback TCP 服务 | deepseek-harness-win-desktop(8765 REST)、dsh-vsceditor(webServer) 官方姿势 | ✅ |
| 外部进程调用 vscode API | 必须薄扩展转发（issue #213521 官方不放开）——已有 dsh-lite-vscode 等 8+ 扩展为证 | ✅（四段式即可） |
| 发现文件 + 端口扫描 + token | 两方案均有完整实现细节可抄（0600 原子写/死 pid 清扫） | ✅ |
| 协议泛化（namespace/多消费者） | JSON-RPC 2.0 + 命名空间是成熟模式 | ✅ |
| 授权确认（首次握手弹窗） | VSCode 扩展标准能力（showInformationMessage + context.globalState 记住） | ✅ |
| openFile/读选区 | vscode.window.showTextDocument / activeTextEditor 官方 API，无坑 | ✅ |
| 零依赖打包 DSH client 插件 | 本机 dsh-vscode-bridge@0.4.3 已验证（函数式 cordis + __ModuleLoader__） | ✅ |
| Workspace Trust | 扩展 API 文档标准模式 | ✅ |

## 三、风险与化解（按优先级）

| # | 风险 | 概率 | 影响 | 化解 |
|---|---|---|---|---|
| 1 | DSH 内部 API（__ModuleLoader__ / cordis service）0.2.x 线变更导致插件失效 | 中 | 高 | ① 握手报 dshVersion+capabilities；② 插件入口只依赖「函数式 cordis 插件」这一最稳定契约；③ 版本走廊探测写进协议库自检；④ 钉版：不依赖 rc 间未承诺行为 |
| 2 | 端口/发现文件与已装的 Fengze233 桥（同目录 ~/.dsh/vscode-bridge/）冲突 | 中 | 中 | 用独立目录名（如 ~/.dsh/dsh-kit/<pid>.json）+ 独立端口区间（如 7410–7419），互不踩 |
| 3 | 真机 E2E 时 DSH/VSCode 版本组合不匹配 | 低 | 中 | 本机单版本实测（DSH 0.2.1-rc.2 + VSCode 稳定版），测试矩阵不进打样范围 |
| 4 | 需求蔓延（想做注入/面板） | 中 | 中 | phase2 已画死 in/out scope，每个 go/no-go 门对照验收清单 |
| 5 | 白饭预算（Pro 档贵） | 高 | 中 | 打样编码放 Flash 档跑；本会话已触发提醒，见交付时备注 |

## 四、不可行/不做的事（诚实声明）

- ❌ **跳过 VSCode 薄扩展**：不可能。外部进程拿不到 vscode API 是官方硬边界（issue #213521）。
- ❌ **复用 ACP-over-stdio 直连已开 GUI**：不可能。stdio 只能在进程启动时挂接。
- ❌ **首版就做编辑器注入**：不可取。踩坑 9（静默注入红线）要求交互设计先行，进 out of scope 是正确决定而非偷懒。
- ❌ **Remote/WSL 反向连通**：首版不做，明确降级声明（本机 loopback 单向能力）。

## 五、工作量估算（打样范围）

| 块 | 内容 | 估算 |
|---|---|---|
| 协议核心库（DSH 侧 npm 包） | JSON-RPC ndjson、配对/超时/错误、发现文件、TCP 服务、能力注册 | 0.5–1 天 |
| VSCode 薄扩展 | 连接、鉴权、握手确认、openFile/getSelection 转发、Trust 检查 | 0.5 天 |
| 示例消费者插件 | 一个 DSH 插件调 vscode.openFile/getSelection | 0.25 天 |
| 最小测试 | 协议单测 + 真机 E2E 一轮 | 0.5 天 |
| **合计** | | **≈ 2 天（Flash 档可压缩）** |

## 六、go/no-go 判定

**GO**，条件：阶段 4 架构草图须先把「协议库公开 API 面」定死（那是解耦的命根子），再进阶段 5 打样。

# PM 恢复检查点：DSH Pier

## 当前事实（只读核实）

- 项目：`D:/code-workspace/projects/dsh-vscode-dev`；任务板：`D:/code-workspace/.expert-taskboards/dsh-pier.json`。
- Git 工作树有且仅有已知 T1 文档改动：`README.md`、`docs/README.md`、`packages/dsh-vscode-kit/src/protocol.js` 均显示 modified。它们属于 T1 已完成成果，禁止清理、覆盖或回滚；本报告不触碰这些文件。
- 任务板 revision 31：T1 `done`；T2 `ready`；T3 `running`；T4/T5/T6/T7/T9/T10 `pending`；T8 `failed`。计数为 done=1、failed=1、pending=6、ready=1、running=1。
- T3 最新检查点（2026-10-21 23:27:52）：审计方已完成三次最小抽样，GET/WS dispatched=0；携带正确测试 token 的 HTTP POST dispatched=1；错误 token 后连接仍 open，随后同连接正确消息可 dispatched。已核源码、先例、Node v24.20.0 inspector 与 Windows chmod 官方文档；原三文件哈希/diff 哈希未变；报告尚未落盘。明确禁止重跑安全实验。
- `taskboard.py --help` 可用命令包括 `create/list/show/claim/approve/reject/done/vote/fail/retry/progress/heartbeat/watchdog/metrics/recover/deps/status/boards/archive/reassign/set_dependencies/verify/own/budget/replay` 等；没有 `cancel` 或编辑任务描述命令。官方终态限制：`fail` 仅适用于 running，`reject` 仅适用于 draft。当前重复项是 pending，不能安全地伪造终态，也不能 claim 后 fail 来规避限制；本次不得改板。
- 教学文档已有第 1–3 课及各自答疑（含第 3 课第二轮答疑），课表列第 4–6 课尚待补齐。项目 `AGENTS.md` 要求涉及安全/鉴权/协议先例核对、修改后全套测试；宿主语义须真机验证。当前 T6 的批准范围仅 Windows，不承诺 macOS/Linux。

## 已知产出与重复项处置

1. **T1 已完成**：`protocol.js` 注释区分 request 自动附带 token 与 notify/respond 默认不带；README 安全模型补充错误响应无 token 通道是已知限制，且不得向未认证者的 -32001 附送凭据。上述三份文件仍有未提交改动，须保留。
2. **T3 是唯一有效威胁面审计条目**；其检查点只是有限抽样证据，不足以断言恶意网页可利用，也不证明攻击者能取得 token。T3 报告待交付，须把每个结论绑定源文件行号/既有实验结果，并明示证据边界及未验证项。
3. **T8 是重复审计项**：已 failed，失败原因记录为“与 T3 重复（T3 保留为唯一威胁面审计条目）”，无需重做。
4. **T9 重复/扩展 T5**：两者都等待 T1、T3 并修改根 README 与 `docs/README.md`；T9 另要求新增 `docs/威胁模型-通道可达面.md`。若两者都执行，会争用相同 README 文件，且可能重复写入安全章节。
5. **T10 重复 T7**：都写同一个教学文件的第 4–6 课，且 T10 依赖 T9、T7 依赖 T5。不可并行写该文件。
6. 由于官方 CLI 无 pending→cancel/reject 的安全入口，建议暂时保留 T9/T10 为 pending 并在派工前标注重复风险；不要假装已清理。请项目负责人裁决保留哪组作为规范条目，或待有官方迁移/取消能力后再处置。未经裁决，不要同时派发 T5 与 T9，也不要同时派发 T7 与 T10。不能擅自 claim/fail pending 项目来制造“已处置”状态。

## 建议剩余顺序与冲突控制

- **并行起点**：T2 已 ready，可开始 links/trusted 拆分；T3 继续只读审计并落报告。它们改动范围不同，但 T3 仍应避免写入 T1 的三份文件。
- **实现门禁**：T2 完成后进入 T4 独立 review；T4 通过后才做 T6 Windows 长尾验证。T6 至少覆盖双窗口仲裁/重连/关窗清位，以及 1.91–1.141 区间下界和一个中间版本；macOS/Linux 明确标为未验证。
- **文档顺序**：T3 报告完成后，先按项目负责人裁决选定 T5 或 T9 中一个 README 写入者。若选 T9，则同一任务应交付威胁模型文档与 README 两份一致更新；若选 T5，则确认威胁模型独立文档是否另有获批任务承接，不能默认为已完成。任何时点仅一个写任务改 README。
- **课程顺序**：选定 T7 或 T10 中一个作为第 4–6 课唯一写入者，等对应 README/安全文档任务完成后再做，避免同文件并发覆盖。
- **提交前**：按 `AGENTS.md` 的既定测试门槛全跑（kit、bridge、demo、E2E）；安全相关回归需做变异测试；涉及 VS Code/DSH 宿主真实语义时做真机验证。只陈述实际跑过的证据，不把计划当作验证结果。

## 风险与边界

- T3 的少量实验只能说明该具体测试路径下各请求的分派观察，不能推广为“浏览器整体不可达”“所有浏览器 API 均不可能触达”或“DNS rebinding 绝对不成立”；结论必须由架构/协议证据支持，或标记未验证。
- T3 检查点中的“错误 token 后连接仍开”也不等于未授权操作成功；需要区分连接存活、鉴权结果与后续正确 token 消息。
- README 写入存在 T5/T9 冲突；教学文件存在 T7/T10 冲突。当前没有合法 CLI 途径清理 pending 重复卡，避免不透明手工改板。
- 本报告范围仅恢复检查点；不运行安全实验、不修改源代码、不修改任务板、不提交/推送。仅新增本文件并按要求发 bus。

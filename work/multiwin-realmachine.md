# T53 真机双窗口验收记录

## 结论与边界

**未完成真机验收，不把静态检查、单测或 CLI 启动成功充作 A10–A13 通过。** 本次只修改 `packages/dsh-vscode-kit/src/server.js` 的行尾，并新建本报告。没有 commit/push，没有执行 git checkout/restore，没有执行删除类命令。四门只在最后各跑一次（结果见末节）。

用户要求同时满足「不在中途汇报」和「改其他文件前先说明理由」，因此扫描发现的其他 CRLF 文件、过期扩展构建产物均未擅自改动。若要继续真机验收，首先需要放行构建产物/隔离运行时文件，不能静默扩写本次两文件范围。

## 1. 行尾：原始扫描、实际处理与内容证明

环境：Git for Windows Bash；工作区 `D:/code-workspace/projects/dsh-vscode-dev`。普通 `grep -c $'\r'` 在本机文本模式会剥 CR，第一次出现假阴性；使用 `-U` 保留原始字节后取得下面结果。`git ls-files --eol` 同时交叉核验。

实际命令：

```bash
git ls-files -z -- '*.js' '*.mjs' '*.cjs' '*.json' '*.md' '*.yml' '*.yaml' '*.ts' |
  xargs -0 grep -Uc $'\r' | awk -F: '$NF != 0'
```

转换前输出（计数为含 CR 的行数）：

```text
docs/phase5-打样日志.md:346
docs/phase6-验收报告.md:175
packages/dsh-kit-bridge/scripts/e2e.mjs:348
packages/dsh-kit-bridge/test/connector.test.js:229
packages/dsh-kit-bridge/test/document-version.test.js:480
packages/dsh-kit-bridge/test/edit-attribution.test.js:340
packages/dsh-kit-bridge/test/edit-transaction.test.js:655
packages/dsh-kit-bridge/test/t34-incarnation.test.js:355
packages/dsh-kit-bridge/test/t35-incarnation-mandatory.test.js:361
packages/dsh-kit-bridge/test/t5-negative-lifecycle.test.js:411
packages/dsh-kit-demo/package.json:34
packages/dsh-vscode-kit/src/grant.js:813
packages/dsh-vscode-kit/src/server.js:403
packages/dsh-vscode-kit/test/document-version.test.js:271
work/realtest-overlay.yml:20
work/安全负例-T5-多窗口与生命周期.md:246
work/评审-T16-兼容门.md:162
work/评审探针-T16-兼容门.mjs:153
```

**不是只有 server.js 含 CRLF。** 其余 17 个文件超出用户最后列出的允许写路径，保持原状；全仓 LF 统一未完成。扫描范围是 Git 已跟踪、上述后缀的文本文件，不宣称覆盖依赖或二进制。

仅对 server.js 做 403 次 `CRLF → LF` 字面替换。通用 edit 工具第一次声称成功但保留了 CRLF；随后改用逐字节保留的文件替换工具完成一次真正转换，没有修改源代码内容。

转换后原始输出：

```text
$ git ls-files --eol packages/dsh-vscode-kit/src/server.js
i/lf    w/lf    attr/                 packages/dsh-vscode-kit/src/server.js
$ git diff --stat
<空>
$ git diff --numstat
<空>
{"file":"packages/dsh-vscode-kit/src/server.js","CR":0,"LF":403,"identicalToHEAD":true,"sha256":"d20d453013b6996ad10f0fa07c6c2cd13f2099a98b236e767248b7f04907b107"}
```

核对方式：读工作树原始 Buffer，与 `git show HEAD:packages/dsh-vscode-kit/src/server.js` 的 Buffer 做 `equals()`；结果 true。Git 中已是 LF，因此只修工作树行尾后 server.js 在 diff 中 **0 增 / 0 删**，没有整文件重写。转换前 SHA-256：`0d4b131a78e6bb1ad4211c58e20933c9dc0627881a494b454458d821dbc48628`，17970 bytes；转换后 17567 bytes，正好减少 403 个 CR。import smoke 退出 0。

## 2. 真机环境与实际加载路径

选择：**`--extensionDevelopmentPath`**，没有安装 VSIX。读取的扩展 manifest 的 `main` 是 `./out/extension.cjs`，开发路径不会自动把源码当入口，也不会自动构建。

```text
$ code --version
1.143.1
e646868227c3e3a9e3f24277c8c7220be42c0be7
x64
$ dsh --version
/usr/bin/bash: line 1: dsh: command not found
[exit code: 127]
```

实际执行的两条启动命令（每条一次）：

```bash
code --new-window --extensionDevelopmentPath='D:/code-workspace/projects/dsh-vscode-dev/packages/dsh-kit-bridge' 'D:/code-workspace/projects/dsh-vscode-dev/work/win-a'
# window-A-launch-exit=0
code --new-window --extensionDevelopmentPath='D:/code-workspace/projects/dsh-vscode-dev/packages/dsh-kit-bridge' 'D:/code-workspace/projects/dsh-vscode-dev/work/win-b'
# window-B-launch-exit=0
```

**退出 0 不等于两个指定窗口真的出现。** Win32/UIA 后验仍只见先前的三个开发宿主，未见 win-a/win-b 这两个指定目录的新窗口：

```json
[
  {"nativeWindowHandle":396412,"processId":4068,"name":"[扩展开发宿主] dsh-selftest-delete-accept-9184.txt - t40-realtest3-qxrrmw - Visual Studio Code","isEnabled":false},
  {"nativeWindowHandle":199894,"processId":4068,"name":"[扩展开发宿主] dsh-selftest-delete-cancel-24840.txt - t49-fixture-clean - Visual Studio Code","isEnabled":true},
  {"nativeWindowHandle":68788,"processId":4068,"name":"[扩展开发宿主] dsh-selftest-delete-cancel-23624.txt - t49-fixture - Visual Studio Code","isEnabled":true}
]
```

同时出现了既有开发宿主的删除确认模态框（本次未点击删除，也未点击取消或改动其 fixture）：

```json
{
  "nativeWindowHandle":134418,
  "processId":4068,
  "name":"Visual Studio Code",
  "UIA.MainInstruction":"DSH 请求删除文件：dsh-selftest-delete-accept-9184.txt",
  "UIA.ContentText":"c:\\Users\\zxm\\AppData\\Local\\Temp\\t40-realtest3-qxrrmw\\dsh-selftest-delete-accept-9184.txt\n\n内容预览（共 22 字符，下面是最多前 400 个）：\ndelete me\nsecond line\n\n\nsha256: 0a9fd06e70d58f8c7053d4700d0a20918628a96beec5b49a09f42595f0572128\n\n删除后没有撤销，也不保证进入回收站。",
  "buttons":["删除","取消"]
}
```

UIA 此次返回 `truncated:false`、9 个节点，截图与上面的模态框文字一致。不能把既有自检宿主当成本轮受控双窗口，更不能为了过验收去确认删除。

构建产物静态核验：对实际入口 `packages/dsh-kit-bridge/out/extension.cjs` 查找 `describeWindow|sessionId: vscode|readWindowBlock|vscode.windows.list`，**无匹配**。源码 `src/extension.js` 的 515–530 行却包含 `describeWindow` 与 `vscode.env.sessionId`。所以当前已有 bundle 不包含 W3 的窗口上报实现；包版本同为 0.3.1 不能证明代码相同。未运行构建脚本：该脚本会先删除 out 目录再写产物，既超两文件范围，又含用户禁止的删除操作。没有再尝试不同 profile、安装目录或用户数据目录。

已有控制探针也未在其既定端口运行：

```text
GET http://127.0.0.1:3097/health -> ECONNREFUSED
GET http://127.0.0.1:3098/health -> ECONNREFUSED
GET http://127.0.0.1:3099/health -> ECONNREFUSED
GET http://127.0.0.1:3100/health -> ECONNREFUSED
```

上述四口探测仅用于核实现有环境，不代表穷举整机端口。默认发现目录的 glob 只返回历史 selftest/trashprobe JSON，没有数字 PID 的活动桥发现文件。没有改现有 DSH profile、没有重启当前 DSH，也没有伪造发现文件或窗口 hello。

## 3. A10–A13 与本轮附加要求逐格验收

| 项 | 结果 | 原始材料 / 卡点 |
|---|---|---|
| 两个指定目录、均加载当前扩展 | **未验证** | 上述两次 CLI 均 0，但后验未见指定窗口；已有宿主出现删除确认框，实际 bundle 又缺 W3。没有把已有三个宿主冒充本次两个窗口。 |
| A10：`vscode.windows.list()` 两条、label 可区分、windowId 不同 | **未验证** | 没有本轮受控 DSH 桥与双窗口的返回，**未取得 windows.list JSON**，条数、windowId、stable、connSeq 均不填猜测值。 |
| 同一读请求通过 `{target}` 各自命中 | **未验证** | 未建立上述受控连接，未发送；没有请求/响应摘录。 |
| A11：openFile 在 2 号窗口打开、1 号不变 | **未验证** | 无本轮受控 1/2 号窗口；未发送 openFile。 |
| A12：grant 给 1 号后 target #2 的 applyEdit 被拒且 1 号不变 | **未验证** | 未发 grant/写请求；没有真机 `-32014` 错误原文，不能用源码或单测替代。 |
| 写路径 target → `-32014 target-not-routable` 且对端零帧 | **未验证** | 没有真机请求，未装帧计数探针；不能把「没发请求」说成拒绝路径的零帧证明。 |
| A13：关 2 号后 #2 报 window-closed、1 号仍正常 | **未验证** | 无受控编号映射，不关闭用户已有窗口；没有真机响应。 |
| 两个真实窗口 `vscode.env.sessionId` 是否不同 | **未验证** | bundle 缺候选上报；未取得两个真实 sessionId，不填相同/不同。 |
| windowId 跨重启复用 | **未验证** | 本轮没有重启实验；即使日后证明同一时刻两窗口 sessionId 不同，也不能单凭这一点推导跨 VS Code 重启不变。 |

## 4. 设计稿中的事实边界（不冒充真机结论）

源码指纹由 `sessionId + workspace 根 + uiKind` 组成，`stable:true` 注释口径是跨**重连**稳定。两个窗口的 sessionId 不同只足以支持同时区分窗口，不足以证明跨 VS Code 重启复用旧 windowId。设计稿 §1.3 本就把关窗重开列为待核。本次没有观察值，因此不改设计稿、不改 §1 结论。

此外，源码并不是只要两个窗口 sessionId 相同就必然退化 tmp：工作区根也在指纹内；不同目录仍可能得到不同指纹。这是静态事实，不是本轮实测 sessionId 的替代品。

## 5. 最后一次四门

本次唯一一轮，开始于 `2026-10-23T18:02:16.937Z`，均使用当前 Node 执行；四条各执行一次，退出码均 0。没有重跑全量。原始汇总如下：

```text
===== kit | 2026-10-23T18:02:16.937Z | node --test test/*.test.js | cwd=packages/dsh-vscode-kit =====
EXIT=0; SIGNAL=null; ERROR=none
ℹ tests 213
ℹ suites 0
ℹ pass 213
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1320.325

===== bridge | 2026-10-23T18:02:18.314Z | node --test test/*.test.js | cwd=packages/dsh-kit-bridge =====
EXIT=0; SIGNAL=null; ERROR=none
ℹ tests 156
ℹ suites 0
ℹ pass 156
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2213.4745

===== demo | 2026-10-23T18:02:20.583Z | node --test test/*.test.js | cwd=packages/dsh-kit-demo =====
EXIT=0; SIGNAL=null; ERROR=none
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67.001

===== E2E | 2026-10-23T18:02:20.704Z | node scripts/e2e.mjs | cwd=packages/dsh-kit-bridge =====
EXIT=0; SIGNAL=null; ERROR=none
=== 22/22 passed ===
```

这些单测/E2E 使用假编辑器宿主，**不构成 A10–A13 真机通过证据**。报告不修改 AGENTS.md 中的历史条数（超本轮允许路径）。

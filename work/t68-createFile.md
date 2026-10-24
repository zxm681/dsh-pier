# T68 createFile：前置核实与待裁决冲突

## 状态

暂停源码修改，等待协调者裁决；没有实现 createFile，没有修改 packages/、契约或 README，没有 commit/push/重启。

## 已核实事实

- 命令：`pwd && git status --porcelain && git log --oneline -1`。
- 输出：工作目录 `/d/code-workspace/projects/dsh-vscode-dev`；porcelain 无输出；HEAD 为 `ac13f41 docs: 收尾五件——门槛与部署事实、windowId 指纹勘误、契约 6.3 调用方须知`。
- 已读取任务书指定的 capabilities、workspace-paths、vscode-host、whitelist、grant 与契约 §6.2；另读取项目经验手册与静态守门测试。
- [vscode-host.js:615](../packages/dsh-kit-bridge/src/vscode-host.js#L615) 的 quarantineRename 为本地 rename 原语先例。
- [t40-host-surface.test.js:98–115](../packages/dsh-kit-bridge/test/t40-host-surface.test.js#L98-L115) 明确禁止删除调用。

## 必须裁决的冲突

任务同时要求：
1. `open(path,'wx')` 后 write + close，任何异常 close 后抛出，且不留半截文件。
2. 不得引入删除原语，不得先写临时文件再 rename。

`close()` 仅关闭句柄，不撤销成功的目录项创建，也不回滚已经写入的字节。不能用“已 close”代替“没有半截文件”。未擅自添加删除、截断、清理或失败残件归档策略。

### 实测

在 work/ 下以 wx 排他创建诊断文件，写入 `partial` 后抛出 `injected-write-failure`，finally 中 await close；随后 stat/readFile：

```text
error injected-write-failure
{"file":"work/t68-createFile-close-probe.txt","exists":true,"size":7,"text":"partial"}
```

命令退出 0。该探针证明“成功写入前缀后异常 + close”会留下 7 字节文件；未模拟操作系统真实 ENOSPC/EIO（未验证）。诊断文件保留原位，不自行清理。

## 请求协调者裁决

建议明确允许：失败后关闭句柄，将新建的失败残件 rename 到隔离区并报告其路径；这是失败后的归档，不是“临时写入后 rename 发布”。隔离失败时必须如实报告可能留有残件，不能承诺任意 I/O 故障下绝对清理成功。若不允许该分支，需要调整“不留半截文件”的保证或放行专门的失败清理原语。

## 尚未执行

- 实现、两侧新增测试、四门、import smoke、README diff：未执行。
- M1 wx→w：未执行，无前后 diff、无红原文。
- M2 放行 expectedDisk 对象：未执行，无前后 diff、无红原文。
- M3 去掉 1 MiB 上限：未执行，无前后 diff、无红原文。
- M4 父目录缺失时 mkdir：未执行，无前后 diff、无红原文。
- 任务板已落 1 条真实进展检查点；没有伪造 3 条完成检查点。

— backend-engineer（attempt t68-createfile-v1）

---

## 本轮续作：按唯一窄口裁决实现（覆盖上文暂停状态，不删除上一轮冲突记录）

### 文件:行号与实测输出

| 证据位置 | 本轮实测 / 已实现内容 |
|---|---|
| [vscode-host.js:23–41](<../packages/dsh-kit-bridge/src/vscode-host.js#L23-L41>) | 唯一私有清理函数；lstat bigint `(dev,ino)` 与创建时身份全等才 unlink；不等返回 `identity-changed` |
| [vscode-host.js:538–584](<../packages/dsh-kit-bridge/src/vscode-host.js#L538-L584>) | 真正 `open(wx)` → fstat → 短写循环 → fsync → close → lstat 实测；open 后所有失败先尝试 close，再进入清理；已存在/父目录缺失分别映射 -32013/-32602 |
| [capabilities.js:2654](<../packages/dsh-kit-bridge/src/capabilities.js#L2654>) | createFile handler；复用同文件队列、路径守卫与 grantGate；没有打开文档、没有脏态门、没有 mkdir |
| [workspace-paths.js:121–279](<../packages/dsh-kit-bridge/src/workspace-paths.js#L121-L279>) | 只加 forCreate 分支允许末段缺失；根链/逐段 lstat/realpath 段名/根内判定仍复用既有实现 |
| [create-file.js:6–33](<../packages/dsh-vscode-kit/src/create-file.js#L6-L33>) | 两端共享 null 锚点、字符串、代理项无损编码与 UTF-8 字节上限判定 |
| [kit 日志](<t68-kit.log>) / [bridge 日志](<t68-bridge.log>) / [demo 日志](<t68-demo.log>) / [E2E 日志](<t68-e2e.log>) | `tests/pass/fail = 299/299/0`、`295/295/0`、`9/9/0`；`=== 22/22 passed ===`，四门命令均退出 0 |
| [新增测试合跑](<t68-new-tests.log>) | `tests 33 / pass 33 / fail 0`（bridge 功能 22、bridge 静态 2、kit 9；含嵌套 subtest） |
| [README diff](<t68-readme.diff>) / [最终检查](<t68-final-checks.log>) | `diff -u README.md docs/README.md` 无输出，退出 0；`git diff --check` 退出 0；import smoke `exports 30` |
| [编译日志](<t68-build-final.log>) | esbuild `write:false` 编译最终源码：`build OK bytes 262181`；有 1 条既有 import.meta/CJS warning（未修，见限制） |

### 结论与文件改动原因

`vscode.createFile` 已留在工作树；未 commit、未 push、未重启在线 DSH、未安装/重载 VS Code。上一轮的诊断残件仍保留。原 deleteFile 隔离归档、judgeGrant 七行判序与既有 -32010/-32011/-32012/-32013 语义未改；新建遇存在对象复用 -32013 `exists`，无自动重试。

- [capabilities.js](<../packages/dsh-kit-bridge/src/capabilities.js>)：能力表、handler 与分派接线；无授权表的默认拒绝分支仅给新能力补 `missing:'grant'` 诊断。
- [vscode-host.js](<../packages/dsh-kit-bridge/src/vscode-host.js>)：真实本地排他创建原语与唯一失败清理窄口，并登记宿主返回面；不用 provider 覆盖式写入。
- [workspace-paths.js](<../packages/dsh-kit-bridge/src/workspace-paths.js>)：保留既有默认行为，仅允许新能力缺失末段，父目录缺失拒绝。
- [create-file.js](<../packages/dsh-vscode-kit/src/create-file.js>)（新增）：参数判据两端共用，防止编码/体积/null 锚点漂移。
- [index.js:581、779、2205、2439](<../packages/dsh-vscode-kit/src/index.js#L581>)：三个稳定糖衣入口；raw request 与糖衣共用发送前参数门；新对象不虚构文档化身，仍由 grant 的 link 选写目标。
- [grant.js:115](<../packages/dsh-vscode-kit/src/grant.js#L115>)、[whitelist.js:99](<../packages/dsh-vscode-kit/src/whitelist.js#L99>)、[response-contract.js:310](<../packages/dsh-vscode-kit/src/response-contract.js#L310>)：WRITE_METHODS、disk-write 与响应字段/一致性登记；notify/broadcast 因表项自动拒绝。
- [bridge 功能测试](<../packages/dsh-kit-bridge/test/t68-create-file.test.js>)（新增，22 条）、[静态守门](<../packages/dsh-kit-bridge/test/t68-unlink-surface.test.js>)（新增，2 条）、[kit TCP 测试](<../packages/dsh-vscode-kit/test/t68-create-file.test.js>)（新增，9 条）。
- [t40-host-surface.test.js:113](<../packages/dsh-kit-bridge/test/t40-host-surface.test.js#L113>)：仅排除私有清理函数体，余下删除禁令原样；跨包唯一性及双身份判据交给新静态门。原有测试未删条数。
- [t5-negative-lifecycle.test.js:414](<../packages/dsh-kit-bridge/test/t5-negative-lifecycle.test.js#L414>)、[editing-grant.test.js:351](<../packages/dsh-vscode-kit/test/editing-grant.test.js#L351>)：只在整表 deepEqual 里追加新能力，不降低断言强度。
- [AGENTS.md:40](<../AGENTS.md#L40>)：铁律 11 的唯一例外及三个前提；同步四门实跑数。
- [契约 §3](<../docs/协作编辑-钩子契约.md#L95>)、[§6.2.9](<../docs/协作编辑-钩子契约.md#L829>)、[§9.2](<../docs/协作编辑-钩子契约.md#L1095>)：登记线性化点、null 锚点、新建/失败清理/威胁模型与工作树状态；历史快照保留并加当前状态引注。
- [README](<../README.md>) 与 [docs README](<../docs/README.md>)：逐字一致地补能力表/错误码，去掉当前仍不做新建的表述，门槛同步为 603 单测 + 22 E2E；已 diff 验证。

### 必配回归逐项证据（全部通过）

1. [bridge:62](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L62>)：已存在 → -32013 exists，创建前后原文件 sha256 严格相等。
2. [bridge:70、78](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L70>)：路径守卫与真实宿主均拒 parent-missing，父目录确实未创建；路径拒绝时写宿主计数 0。
3. [bridge:85](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L85>) / [kit:132](<../packages/dsh-vscode-kit/test/t68-create-file.test.js#L132>)：1 MiB 正好通过，+1 字节拒绝；文本类型错误、孤立代理项拒；写宿主 0 / 额外业务帧 0；空串与合法代理对可用。
4. [bridge:117、129、139](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L117>)：真 Windows junction（Node 视为 symlink）、链接末段、根 junction、根外/UNC/多根均拒；realpath 段名差异用注入验证 alias。
5. [kit:89](<../packages/dsh-vscode-kit/test/t68-create-file.test.js#L89>)：read 档拒绝，执行端业务帧 0（因而写宿主没有机会执行）。
6. [bridge:154](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L154>) / [kit:102](<../packages/dsh-vscode-kit/test/t68-create-file.test.js#L102>)：缺 grant → -32010，missing 严格等于 grant；包括桥端未传授权表的默认拒绝路径；写宿主/业务帧 0。
7. [bridge:47](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L47>) / [kit:75](<../packages/dsh-vscode-kit/test/t68-create-file.test.js#L75>)：真实 fs 与 TCP 两侧正向成功、字段齐全、实测 disk.size===bytes；不自动打开文档；响应门拒绝伪 overwritten/replaced 字段。
8. [bridge:177 起](<../packages/dsh-kit-bridge/test/t68-create-file.test.js#L177>)：注入真实句柄写部分字节后抛错，验证先 close 后 lstat 清理，文件不存在；close 时 rename 旧对象再 wx 写替换对象 → identity-changed，不删替换对象；dev/ino 单独变化均不删；sync/close/fstat/清理 lstat 失败均有显式结果；短写与并发仅一成功亦覆盖。

另：[kit:114、149、158](<../packages/dsh-vscode-kit/test/t68-create-file.test.js#L114>) 覆盖 null 锚点缺/非 null 在 raw 与糖衣均拒、notify/broadcast 入口拒、grant 绑定到先连窗口后再连第二窗口仍只发第一窗口、带 target 仍拒。

### 五条变异：全部为行为断言真红（不是语法错误），每次 cp + MD5 回滚

备份命令：`cp packages/dsh-kit-bridge/src/vscode-host.js work/t68-host.snapshot`；`cp packages/dsh-vscode-kit/src/create-file.js work/t68-params.snapshot`。每次红后立即 cp 回源码，再 `md5sum` 与 `diff -q`；五次 diff 均退出 0，未用 git 恢复/暂存/清理。

- host 源码与 [host 快照](<t68-host.snapshot>) MD5 均 `2aaf909229ed19391dd5815df3817cab`。
- 参数门源码与 [参数快照](<t68-params.snapshot>) MD5 均 `c681bbe41ae23b20f67a645ad2eb5152`。
- 还原后新增测试合跑 33/33，四门全部复跑；未遗留变异源码。

**M1** `wx → w`；命令 `node --test --test-name-pattern="已存在不覆盖" packages/dsh-kit-bridge/test/t68-create-file.test.js`；退出 1，[原文](<t68-M1.log>)：
```text
✖ T68 已存在不覆盖：原文件 sha256 不变（wx 不是 w）
AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ tests 1
ℹ pass 0
ℹ fail 1
```
**M2** 把非 null 判据改成允许对象；pattern `expectedDisk 缺失`；退出 1，[原文](<t68-M2.log>)：
```text
✖ T68 expectedDisk 缺失与非 null 一律拒，宿主零调用
AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ tests 1
ℹ pass 0
ℹ fail 1
```
**M3** 摘掉 1 MiB 上限（条件改 false）；pattern `1 MiB UTF-8`；退出 1，[原文](<t68-M3.log>)：
```text
✖ T68 1 MiB UTF-8 正好通过，+1 字节拒且宿主零调用
AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ tests 1
ℹ pass 0
ℹ fail 1
```
**M4** 宿主 open 前加 recursive mkdir；pattern `宿主也绝不 mkdir`；退出 1，[原文](<t68-M4.log>)：
```text
✖ T68 宿主也绝不 mkdir：直接缺父目录 → parent-missing、无目录残件
AssertionError [ERR_ASSERTION]: Missing expected rejection.
ℹ tests 1
ℹ pass 0
ℹ fail 1
```
**M5** 清理函数去掉 dev/ino 校验（条件改 false）；pattern `身份被替换不删`；退出 1，[原文](<t68-M5.log>)：
```text
✖ T68 身份被替换不删：dev/ino 任何一个变化 → identity-changed
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
actual: { removed: true },
expected: { removed: false, reason: 'identity-changed' },
operator: 'deepStrictEqual'
```

### 静态门、失败修正与残余边界

- 新静态门递归扫描 packages/*/src，unlink 调用点严格等于 **1**、严格在私有函数中，要求 lstat bigint、dev **与** ino 的拒绝式校验及 `identity-changed` 必须在 unlink 之前；清理只有一个调用点且在 createFileExclusive catch 内、close 之后；createFile 原语不许 mkdir/provider writeFile。原 T40 的其余删除禁令保留。
- 初次新静态门额外禁止全部 rmSync 时，命中**本来就存在**的 [discovery.js:54、62、97、104](<../packages/dsh-vscode-kit/src/discovery.js#L54-L104>)（发现元数据管理，不是本卡新引入）。没有改这个非本任务文件；新静态门冻结其既有 4 个 rmSync 调用点，只准它们保持基线，其他包不得增加。故可断言生产源码 unlink 只有一个调用点，**不能宣称全仓历史上一切删除原语都不存在**。
- 第一轮全量门各有一条整表枚举红（新增能力未写进旧 expected 数组），已只追加新条目修正，未删测试。最终四门为全绿计数，不以“预期失败”充绿。
- 初次执行 M3 编辑时观察策略发现 cp 已改变文件，拒绝编辑；按提示重新 read 后执行，未绕过策略。
- 行尾跟随现状；`git ls-files --eol` 显示原四个 CRLF 工作树文件仍 w/crlf，其余改动文件 w/lf，没有整篇转换。Git 的 CRLF→LF 提示是未来 index 规范化警告；diff --check 当前退出 0。
- 构建脚本本身含清理 out 的 rmSync，因此**没有执行该清理脚本**、没有动现有 out；直接用同配置 esbuild `write:false` 编译最终源码。编译成功但有 1 条现存 warning：`src/version.js:44:31` 的 import.meta 在 CJS 中为空。未修该非任务问题，也未把编译成功当成真机部署证明。较早的探测 bundle [t68-extension.cjs](<t68-extension.cjs>) 留作诊断，不是发布包。
- `dsh --version` 退出 127（当前 PATH 无 dsh）；`command -v` 已复核不可用，宿主 CLI 版本未验证。Node 实测 v24.20.0；未改权限/插件配置、未寻找替代服务启动方式。
- **未验证**：真实 VS Code 安装后的新能力、真实磁盘 ENOSPC/EIO、真实 8.3 短名的新建路径（alias 分支用注入验证）、Linux/macOS、长期稳定性。E2E 的 22 项是既有子进程夹具，不是在线 DSH/VS Code 真机的 createFile 验收。
- 创建与清理的父目录检查及 lstat→unlink 仍有同用户进程竞态窗口；身份校验是采样，不是条件删除原子系统调用。沿用既有威胁模型边界，宁可留残件，不承诺任何 I/O 故障下都能清理。
- 所有新 fixture 留在 [t68-fixtures](<t68-fixtures/>)（含失败残件与变异实验结果），没有清理非任务数据。上一轮 [close 探针残件](<t68-createFile-close-probe.txt>) 保留。

### 检查点

本轮已按 attempt t68-createfile-v1 落三条 progress（板 revision 347、348、349）：五处核实/实现接线；四门与 33 条回归通过/开始变异；报告落盘、五变异真红且还原、最终四门复跑通过。未擅自将协调者已 claim 的卡重新认领或标记 done。

— backend-engineer（attempt t68-createfile-v1）

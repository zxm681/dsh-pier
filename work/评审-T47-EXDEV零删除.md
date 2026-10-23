# T47 EXDEV 零删除终轮窄判

**结论：pass。must-fix：无。** 仅复核 T45 B45-1 与指定三条，不重开其他裁决。

跨卷/权限失败路径下删除与复制调用均为 0，隔离归档满足零删除不变量。

## 阻断项 / 重要项

无。

## 三条判据及证据

1. **跨卷零删除通过。** [宿主:9](<../packages/dsh-kit-bridge/src/vscode-host.js#L9>) 导入 Node promises；[宿主:650–656](<../packages/dsh-kit-bridge/src/vscode-host.js#L650-L656>) 直接 await `fsp.rename`，无 provider 调用、无降级；[能力层:1917–1937](<../packages/dsh-kit-bridge/src/capabilities.js#L1917-L1937>) 将 EXDEV 映射为 `-32603 / quarantine-failed / hostCode:EXDEV / crossVolume:true / mayHaveApplied:false`。
   独立新写的 [探针](<t47-probes/narrow.mjs>) 在真实、未改写宿主的 `fs.promises.rename` 对象方法上注入 EXDEV；确认命中 **1 次**，旧 provider 命中 **0 次**。同时拦截并计数 Node callback/sync/promises 的 unlink/rm/rmdir/copyFile/cp，以及 VS Code delete/copy。断言删除 **0**、复制 **0**、原件正文与 dev/ino 均不变，目标不存在。[输出:2](<t47-probes/output.log#L2>)。
2. **权限/同名失败通过。** 在新原语注入 EEXIST、EPERM，模拟预检后目标被占：目标写入独立占位字节，再抛对应错误。两条均命中新原语 **1 次**，返回 `-32603 / quarantine-failed`、分别保留 hostCode、crossVolume=false；原件正文及 dev/ino 不变，占位字节未覆盖，删除/复制均 **0**。[输出:3–4](<t47-probes/output.log#L3-L4>)。
   另以真实已存在目标走 [lstat 预检:639–648](<../packages/dsh-kit-bridge/src/vscode-host.js#L639-L648>)：EEXIST、rename 命中 **0 次**，两份正文保留，删除/复制 **0**。[输出:5](<t47-probes/output.log#L5>)。正常路径控制组成功调用真实 Node rename **1 次**，归档字节无损、provider/delete/copy 均 **0**，避免全部提前拒绝导致假通过。[输出:6](<t47-probes/output.log#L6>)。
3. **静态面通过。** bridge/src 全部 **6 个**源文件中 unlink/rm/rmdir/copyFile/cp（含 Sync）调用表达式 **0**，搜索甚至未排除注释；宽搜确认相关词仅在说明注释。宿主 [返回面:662–695](<../packages/dsh-kit-bridge/src/vscode-host.js#L662-L695>) 不暴露 deleteFile；独立探针逐场景检查该字段不在 host 中。[静态记录](<t47-probes/static.log>)。

实测边界：这是在新 Node 原语上的受控错误注入，覆盖真实宿主与能力层；未声称跨物理卷或真实 ACL GUI 验收。探针自身不执行删除或复制，fixture 全部留存。

## 四门完整复跑

| 门 | 实跑通过数 | exit |
|---|---:|---:|
| kit | 193/193 | 0 |
| bridge | 153/153 | 0 |
| demo | 9/9 | 0 |
| E2E | 22/22 | 0 |

前三门 fail/cancelled/skipped 均 0。[kit:194–201](<t47-probes/kit.log#L194-L201>) / [bridge:154–161](<t47-probes/bridge.log#L154-L161>) / [demo:10–17](<t47-probes/demo.log#L10-L17>) / [E2E:68](<t47-probes/e2e.log#L68>) / [退出码](<t47-probes/gate-exits.log>)。

## 只读与源文件完整性

- [进场 git status --short](<t47-probes/status-before.log>) 与 [终场 git status --short](<t47-probes/status-after.log>)：原有 M/?? 保留，仅增加本报告与探针目录。
- 对所有 packages 下已跟踪与未跟踪、非忽略文件建立 [进场 SHA256](<t47-probes/source-before.sha256>)，终场逐项复核全部 OK、exit 0：[完整性证据](<t47-probes/source-integrity.log>)。
- 未修改仓库源文件；未执行 checkout/restore/commit；未删真实文件，也未清理 fixture。仅新增本报告及 [t47-probes](<t47-probes/>) 的探针、日志与临时 fixture。

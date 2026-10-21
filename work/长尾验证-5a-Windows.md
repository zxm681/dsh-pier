# 长尾验证 5a —— Windows 真机（qa-test-engineer）

> 只做 Windows 上**能真验**的部分。所有结论分三类：**通过**（附命令与输出）／**失败**（复现步骤 + 真实报错）／**未验证**（写明为什么不能验）。
> 全程未修改任何产品代码（`packages/*/src/` 零改动），未 commit / push。

## 0. 环境与验证台

| 项 | 值 |
|---|---|
| OS | Windows 10 专业版 build 19045，`LongPathsEnabled=1` |
| 编辑器 | VS Code **1.142.0**（`/d/vscode/Microsoft VS Code/bin/code`），扩展 `dsh-kit-dev.dsh-kit-bridge-0.2.0` |
| DSH CLI | 0.2.1-rc.2（`dsh.cmd --profile web ...`） |
| Node / Python | v24.20.0 / 3.13.0 |
| 被测源码 | 工作树 `packages/dsh-vscode-kit/src`、`packages/dsh-kit-bridge/src`（**overlay 用 `file://` 直指工作树**，见下） |

### 关键前置：为什么必须用 overlay 直指工作树

`~/.dsh/profiles/node_modules/dsh-vscode-kit` 是 **links/trusted 拆分之前**的旧拷贝（`_activeLink` 仍是 `[...links].filter(l => l.authorized).at(-1)`，没有 `trusted`、没有 `connSeq`）。
若直接用 profile 里的库，验的是旧代码，结论无意义。因此验证台用 patch overlay 把两条 insert 的 `name` 写成 `file://` 工作树路径：

```yaml
# work/realtest-t6-overlay.yml（节选）
- insert:
    - id: dsh-vscode-kit
      name: file:///D:/code-workspace/projects/dsh-vscode-dev/packages/dsh-vscode-kit/src/index.js
      config: { connectWaitMs: 1500 }
    - id: realtetharness
      name: file:///D:/code-workspace/projects/dsh-vscode-dev/work/realtest-harness/src/index.js
      config: { port: 3097 }
```

启动（注意：`dsh web --patch` 不认 `--patch`，必须 `--profile web --patch`）：

```bash
dsh --profile web --patch work/realtest-t6-overlay.yml --port 3099 --no-open
# 实例 A：pid 17456，kit 监听 127.0.0.1:7410，名片 ~/.dsh/dsh-vscode-kit/17456.json
# 实例 B：pid 14752，kit 监听 127.0.0.1:7411（同 DSH_HOME，验证多实例）
# 实例 C：pid  7660，kit 监听 127.0.0.1:7412（不同 DSH_HOME，验证名片落点）
```

`work/realtest-harness` 是消费者插件（`inject: ['dshVscodeKit']`），在 127.0.0.1:3097 起 HTTP 控制口，`POST /call` 直接转发 `ctx.dshVscodeKit.request()` —— 因此**每条探针都走被验证的 `_activeLink()` 仲裁路径**，而不是绕过它。

窗口指纹（哪个窗口在应答，看返回的 `file` 即知）：`work/win-a/A.md`、`work/win-b/B.md`、`work/win-c/C.md`、`work/win-d/D.md`、`work/win-e/E.md`、`work/win-f/F.md`。

---

## 一、多窗口仲裁（本次重点）——**通过**

### 1.1 两条连接都进 `trusted`

两个窗口（同一 `Code.exe` 主进程 pid 12056 内的两个窗口，各带一个扩展宿主进程 16420 / 24680）：

```
[dsh-vscode-kit] editor connected (remote port 6865)   ← 窗口 A
[dsh-vscode-kit] editor authorized (token accepted)
[dsh-vscode-kit] editor connected (remote port 6949)   ← 窗口 B
[dsh-vscode-kit] editor authorized (token accepted)
```
`authorized` 行来自 `trusted.add` 事件 —— 两条连接**都过了 token 准入**，`GET /snapshot` 同时报 `connections: 2`。

### 1.2 `_activeLink()` 只选一个，且选的是 `connSeq` 最大的

此刻窗口 A 的活动编辑器是 `A.md`、窗口 B 是 `B.md`。连续 3 次 `vscode.getSelection`：

```
baseline[0] file=...\work\win-b\B.md (61ms)
baseline[1] file=...\work\win-b\B.md (10ms)
baseline[2] file=...\work\win-b\B.md (1ms)
```
→ 落在**最新那条连接（B）**上，且**不漂移**（不是一次一个窗口）。再开窗口 C 后目标立刻切到 `C.md`，仍是最新 `connSeq`。

### 1.3 关键问题：关掉「当前目标窗口」之后

`work/t6-close-probe.py`：对目标窗口 HWND 发 `WM_CLOSE`（等同点右上角 ×，优雅关闭 → 扩展宿主走关停流程、底层 socket 才会收到 FIN），随后每 80ms 打一次 `/call`，逐条记录「距关闭毫秒数 / 是否成功 / 返回文件」。

基线 = 目标窗口 D（`D.md`，另一个窗口是 `B.md`）：

```
== 1) 关闭前基线 ==
  baseline[0] file=...\work\win-d\D.md (61ms)
  baseline[2] file=...\work\win-d\D.md (1ms)
== 2) WM_CLOSE -> HWND 332364 ==
  PostMessageW posted=1 err=0
== 3) 关闭后连续探针 ==
  +    1ms  file=...\work\win-d\D.md  (1ms)      ← 关停中仍在应答
  +   92ms  file=...\work\win-b\B.md  (11ms)     ← 已自动落到另一个活窗口
  +  174ms  file=...\work\win-b\B.md  (1ms)
  ...（其余全部 B.md）
```

**结论：不会落到已销毁的 socket，也不报错。** 目标窗口关闭后 **< 92ms** 就自动落到还活着的另一个窗口；整轮 64 次探针 **0 次失败**（`grep -c "FAIL\|probe-error" work/t6-close-probe-d.log` = 0）。

再补一次「非目标窗口关闭」的对照：关窗口 A（当时目标是 B）→ `connections` 2→1，后续调用立即返回 `B.md`、耗时 1ms，无报错。

### 1.4 更狠的一刀：粗暴杀掉目标窗口的扩展宿主（RST，无优雅关闭）

`work/t6-kill-probe.py`（`Stop-Process -Force` 目标窗口扩展宿主 3616，基线目标 = `F.md`，另一个窗口 = `E.md`）：

```
== 关闭前基线 ==
   ...\work\win-f\F.md
   ...\work\win-f\F.md
== Stop-Process -Force 3616 ==
  +  642ms ...\work\win-e\E.md     ← 已回落到 E
  + 2401ms ...\work\win-e\E.md
  + 2506ms ...\work\win-f\F.md     ← VS Code 自动重启该扩展宿主、重连成功，目标回到 F
  ...
== 共 70 次，失败 0 次 ==
  指纹集合: ['...work\\win-e\\E.md', '...work\\win-f\\F.md']
```

两种死法（优雅关窗 / 进程被 RST 杀掉）都**没有出现 -32007 未连接、没有超时、没有写坏 socket**，全都自动回落到仍存活的窗口。

### 1.5 语义提醒（不是 bug，但用户会感知到）

1. **优雅关窗后最多约 90ms 内仍可能由正在关停的那个窗口应答**（`+1ms` 那次返回的还是 `D.md`）。这是优雅关闭必然的过渡期，不是仲裁失效。
2. **扩展宿主被 VS Code 自动重启后**，它会以**新的 `connSeq`** 重连，于是目标「跳回」该窗口（1.4 里 +2506ms）。这与 `connSeq = 连接先后` 的既有口径一致（AGENTS.md 铁律 8），但从用户视角看像「刚关掉的窗口又抢回去了」——只有扩展宿主崩后自动重启才会出现。

### 1.6 未验证（本节）

- **`link.socket.destroyed` 竞态的正面打击**：`_activeLink()` 里有 `if (link.socket?.destroyed) continue`，但我**没能在真机上构造出「link 仍在 `trusted`、socket 已 destroyed」的窗口期** —— 两种死法都是 socket 先 `close`、link 随之被移除，走不到那个分支。该分支目前只能靠单测守（本次未新增测试）。
- **3 个以上窗口同时连同一个实例**：只做到「同一实例 2 窗口 + 另一实例 2 窗口」，未验证 N≥3。

---

## 二、同机两个 DSH 实例 ——**通过（附一条限制说明）**

### 2.1 端口不抢（7410-7419 顺序探测）

```
实例 A: [dsh-vscode-kit] listening on 127.0.0.1:7410
实例 B: [dsh-vscode-kit] listening on 127.0.0.1:7411
实例 C: [dsh-vscode-kit] listening on 127.0.0.1:7412
```
三个实例同时在线，端口依次后移，无冲突。

### 2.2 名片互不覆盖（`<pid>.json`）

同 DSH_HOME（`C:\Users\zxm\.dsh\dsh-vscode-kit\`）下并存两份：

```
14752.json  {port: 7411, token: <64 chars>, pid: 14752, startedAt: 1792607626417, protocolVersion: 1}
17456.json  {port: 7410, token: <64 chars>, pid: 17456, startedAt: 1792607406747, protocolVersion: 1}
```
文件名即 pid，**token 各自独立**，互不覆盖。实例 B 启动日志也确认它看得到两个活实例：`live bridges under C:\Users\zxm\.dsh: 2`。

### 2.3 编辑器连的是 `startedAt` 最新的那个（不是随机一个）

新开窗口 E（`E.md`，扩展宿主 30140）：

```
TCP 127.0.0.1:7679 -> 127.0.0.1:7411  ESTABLISHED  ← 连到实例 B
实例 A(3097) connections=1（仍是原来那个 B.md 窗口）
实例 B(3098) connections=1 + 日志 "editor connected (remote port 7679)" + "authorized"
```
B 的 `startedAt`（1792607626417）比 A（1792607406747）新 → 编辑器选了 B。与 `connector.js:178-182`（`listLiveBridges()` 按 `startedAt` 降序取第一个，注释写着「多实例仲裁：连 startedAt 最新的」）一致。

### 2.4 两实例互不串

```
实例 A(3097) vscode.getSelection -> ...\win-b\B.md
实例 B(3098) vscode.getSelection -> ...\win-e\E.md
```
各自只服务自己那份 `trusted` 连接，不互相串台。

### 2.5 限制说明（值得写进文档，不是本次要修的 bug）

换 **DSH_HOME** 起实例时，名片写到**那个 HOME 下**，而扩展侧 `connector.js:178` 的 `discoveryDir(dshHome)` 解析的是默认 `~/.dsh`：

```
实例 C（DSH_HOME=D:\...\work\dshhome-c）: listening 7412,
  discovery: D:\...\work\dshhome-c\dsh-vscode-kit\7660.json
  → 默认目录仍只有 14752.json / 17456.json 两张，编辑器侧看不到 C
```
即：**同机第二实例若换 DSH_HOME，VS Code 扩展永远发现不了它**（除非给 VS Code 进程也设同名 `DSH_HOME`）。这是发现协议的既有契约，建议在 `docs/` 里明写一句。

> 说明：实例 C 的验证控制口（3099）与实例 A 的 `dsh web --port 3099` 撞端口，日志 `[harness] control server error: listen EADDRINUSE 127.0.0.1:3099`，所以我没采到 C 的 `connections` 读数——**这是我验证台的端口规划失误，不是产品问题**（C 的 kit 本身在 7412 上正常工作）。

---

## 三、VSCode 版本区间（`^1.91.0`）——**静态通过，动态未验证**

### 3.1 静态核对方法与证据

以**官方 `vscode.d.ts` 原文**为判据（不是博客）：按 tag 拉取，比较 API 是否存在。

```bash
for t in 1.66.0 1.67.0; do curl -sSL https://raw.githubusercontent.com/microsoft/vscode/$t/src/vscode-dts/vscode.d.ts -o dts-$t.d.ts; done
for t in 1.66.0 1.67.0; do echo "--- $t"; for p in "interface TabGroup " "TabInputText" "isTrusted" "visibleTextEditors" "showTextDocument" "openTextDocument" "getDiagnostics" "openExternal"; do printf "  %-22s %s\n" "$p" "$(grep -c "$p" dts-$t.d.ts)"; done; done
```

结果：

| API | 1.66.0 | 1.67.0 | 引入版本判定 |
|---|---|---|---|
| `interface TabGroup` / `window.tabGroups.all` | 0 | 1 | **1.67** |
| `TabInputText` | 0 | 3 | **1.67** |
| `tab.isDirty` | 0（`dts-1.66.0` 无该接口） | 1（`dts-1.67.0:12584`） | **1.67** |
| `workspace.isTrusted` | 2 | 2 | ≤1.66（文档记 1.57） |
| `window.visibleTextEditors` / `showTextDocument` / `workspace.openTextDocument` / `languages.getDiagnostics` / `env.openExternal` | 4 / 6 / 10 / 2 / 5 | 同 | 远早于 1.66 |

`packages/dsh-kit-bridge/src/vscode-host.js:109-118` 实际用的最新一族是：

```js
return (vscode.window.tabGroups?.all ?? [])
  .flatMap((g) => g.tabs)
  .filter((t) => t.input instanceof vscode.TabInputText)
  .map((t) => { ... isDirty: t.isDirty === true, ... })
```

**判定：实际用到的最晚 API 是 1.67，声明下界 `^1.91.0`（≥1.91.0）成立，且有 24 个 minor 的余量。** 另外 `tabGroups?.` 用了可选链，宿主更旧时退化为 `[]`，不会抛异常（列表能力降级为空，其余能力不受影响）。

### 3.2 顺手纠正任务书里的一处事实

任务书要求核对 `workspace.textDocuments` —— **`packages/*/src/` 里根本没有用到它**（`grep -rn "textDocuments" packages/*/src` 无命中）。真正用到的就是上表那些。

### 3.3 未验证（本节）

机制上的硬约束：本机只装了 1.142.0，且**不允许降级/卸载用户的 VS Code**，所以 **1.91 – 1.141 的运行时行为一律未验证**。静态只能证明「API 在这些版本里存在」，证明不了「我们的断言在这些版本里成立」（例如不同版本 `tabGroups` 的排序或 `isDirty` 语义差异）。
如后续要补：VS Code 支持**并行装别的版本**（下载 portable/zip 版，用独立 `--user-data-dir` + `--extensions-dir` 跑，不动用户安装），这是唯一不违反约束的补验路径。

---

## 四、Windows 特有的三件事 ——**全部通过**

### 4.1 路径盘符大小写（历史 bug：`uri.fsPath` 会把 `C:` 小写成 `c:`）

`work/t6-winpath-probe.py`（对实例 B / 窗口 E）：

```
== A) 小写盘符 ==
  送入路径: d:\code-workspace\...\work\win-e\E.md
  openFile: OK elapsed=5ms   → {"opened":true,"path":"D:\\...\\E.md","mode":"text"}
  getSelection: OK file=D:\...\win-e\E.md
  返回盘符大小写: 大写（已归一） -> D:
```
`canonicalPath()`（`capabilities.js` 的 `/^[a-z]:/` 首字母大写）**双向都生效**：入参 `d:` 被归一，回参也是 `D:`。**通过。**

### 4.2 `chmod 0600` 在 Windows 上不是强制约束

```
$ stat -c '%a %n' ~/.dsh/dsh-vscode-kit/*.json
644 /c/Users/zxm/.dsh/dsh-vscode-kit/14752.json
644 /c/Users/zxm/.dsh/dsh-vscode-kit/17456.json
```
代码确实调了 `chmodSync(0600)`，Windows 上落成 `644`（历史上实测过 `666`，本次是 `644`）。**确认文档已如实记录该限制，按要求不"修好"它。通过（= 与文档一致）。**

### 4.3 中文路径 / 空格路径 / 长路径（>260 字符）

```
== B) 中文 + 空格 ==
  送入: D:\...\work\win-e\中文 目录\测试 文件.md
  openFile: OK (27ms)
  getSelection: file=D:\...\中文 目录\测试 文件.md   与送入路径一致: True

== C) 长路径 ==
  路径长度: 304  存在: True
  openFile: OK (43ms)
  getSelection: ...\deep.md          与送入路径一致: True
```
三项全部可开可回读，路径原样往返（中文不转义、空格不丢、长路径不被截断）。**通过。**

> 前提说明：本机 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`，这是 304 字符路径能通过的**环境前提**；在未开启该项的 Windows 上，长路径可能失败（该分支本机无法验，属未验证）。

---

## 五、四门回归（验证后重跑，全绿）

```
packages/dsh-vscode-kit   node --test "test/*.test.js"   → pass 56  fail 0
packages/dsh-kit-bridge   node --test "test/*.test.js"   → pass 23  fail 0
packages/dsh-kit-demo     node --test "test/*.test.js"   → pass 7   fail 0
packages/dsh-kit-bridge   node scripts/e2e.mjs           → 13/13 passed
```
与验证前基线一致；产品源码零改动，符合预期。

---

## 六、新增文件（全部可重跑，均在 `work/`，未触碰产品代码）

| 文件 | 作用 |
|---|---|
| `work/realtest-harness/src/index.js`、`package.json` | 消费者插件：`POST /call` 转发 `ctx.dshVscodeKit.request()`，`GET /snapshot` |
| `work/realtest-t6-overlay.yml`（及 `-b`、`-c` 变体） | 把 kit + harness 指向工作树源码的 patch overlay（不同 harness 端口） |
| `work/t6-close-probe.py` | 对指定 HWND 发 WM_CLOSE，前后逐条探针、输出「距关闭毫秒/成功失败/目标文件」 |
| `work/t6-kill-probe.py` | `Stop-Process -Force` 目标窗口扩展宿主，同样逐条探针（RST 场景） |
| `work/t6-winpath-probe.py` | 小写盘符 / 中文+空格 / >260 长路径 的 `openFile`+`getSelection` 归一化核对 |
| `work/win-{a..f}/*.md`、`work/long/…/deep.md` | 窗口指纹文件与长路径目标 |
| `work/t6-dsh-{a,b,c}.log`、`work/t6-close-probe-d.log`、`work/t6-kill-probe.log`、`work/t6-winpath.log` | 原始证据日志 |

清理已做：我开的 6 个 VS Code 窗口全部关闭（`Code.exe` 已无残留进程），三个 dsh 实例（17456 / 14752 / 7660）已停，自建名片与下载的 `vscode.d.ts` 已删。

---

## 七、需要修的缺口

**没有发现需要改 `src` 的缺口** —— 多窗口仲裁的「关掉目标窗口后自动回落」这个最关键的行为，两种死法都干净通过。

值得记一笔的三条（都不改代码，写成文档/后续测试项）：

1. **`_activeLink()` 的 `socket?.destroyed` 分支没有真机覆盖**（真机构造不出该竞态），目前只有单测守；若后续重构这个函数，务必保留该防御。
2. **扩展宿主自动重启后会「抢回」目标**（新 `connSeq`）。语义正确、用户可感知，建议在文档里说明一句。
3. **第二实例换 DSH_HOME 则编辑器不可见**（发现协议按 HOME 隔离）。建议写进 `docs/`，避免「我起了两个实例但编辑器只认一个」的困惑。

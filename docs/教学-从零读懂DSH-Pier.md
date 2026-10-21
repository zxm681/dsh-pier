# 从零读懂「DSH Pier」—— 小白版技术课

> 目标读者：不懂技术要点，但想真正看懂这个项目的人。
> 节奏：一次一课，每课末尾一道练习题。答不上来就说明讲砸了，换个说法重讲。

## 课表

| 课 | 主题 | 一句话 | 状态 |
|---|---|---|---|
| 1 | 为什么需要"桥" | 两个进程为什么不能直接调用 | ✅ 已完成 |
| 2 | 消息怎么"说话" | JSON-RPC、id、通知、错误码 | ✅ 已完成 |
| 3 | 怎么"找到对方" | 发现文件、端口、token、loopback | ✅ 已完成 |
| 4 | DSH 插件系统 | cordis 的 provide / inject / effect | ✅ 本次补齐 |
| 5 | VS Code 扩展模型 | 扩展宿主、activate、为什么不能直接 import | ✅ 本次补齐 |
| 6 | 分层与解耦 | 零依赖、传输无关、消费者透明 | ✅ 本次补齐 |

> 进度：第 1–3 课（含三次答疑）此前已写完；**第 4、5、6 课于 2026-10-22 补齐**。
> 第 4 课的 cordis 探针脚本是临时解包 DSH 发行包后跑的（未入库），输出原样贴在课里；
> 第 5、6 课的 `node -e` / `npm view` / `node --test` / `node scripts/e2e.mjs` 输出都是当场跑的原样结果。

---

# 第 1 课：为什么需要一座"桥"

## 1.1 原始问题

假设你在 DSH 里跟 agent 说："帮我打开 `package.json`"。

agent 想让 VS Code 打开这个文件，它脑中冒出来的代码是：

```js
import * as vscode from 'vscode'
vscode.workspace.openTextDocument('/path/package.json')
```

**这行代码一定会失败。** 而且会遇到两个不同的错误。

## 1.2 核心事实：`vscode` 不在 npm 上

这是最容易误解的地方。平时写代码，`import` 一个包，它总在 `node_modules` 里躺着。
但 `vscode` **不是**。

`vscode` 是 **VS Code 在加载你的扩展时，临时注入给扩展的一个对象**。
可以这样想：VS Code 打开门，说"这张通行证只在这个房间里有效"，然后递给你。

- 在 VS Code 的扩展宿主进程里：`import vscode from 'vscode'` ✅
- 在 DSH 的 Node 进程里：`Cannot find package 'vscode'` ❌

我们在阶段 1 拆解现有项目时，撞见过同一类错误：

```
Cannot find package '@deepseek-ai/cordis'
```

那条注释写得很清楚：VS Code 扩展宿主 spawn 出来的 dsh 进程，拿不到模块加载 hook。
说的就是这件事 —— **跨了进程，那套注入就没了。**

## 1.3 核心事实二：进程之间没有共享内存

更底层的原因是**进程隔离**。

两个进程，各自一块内存，各自一套变量。甲进程里的函数，在乙进程里**不存在**。
你能传过去的只有字节（一串 0 和 1）。

所以没有任何办法让 DSH 直接"调用" VS Code 里的一个函数。只能：

1. 把"我想打开这个文件"**编码成一段字节**
2. 通过操作系统提供的通道**送过去**
3. 对面**解码**、执行、把结果编码回来
4. 这边解码

这套动作叫 **IPC（Inter-Process Communication，进程间通信）**。
我们做的"桥"，本质就是这套编解码 + 通道的封装。

**能用的通道**（就这几种，没别的）：

| 通道 | 我们为什么不选 |
|---|---|
| 管道（stdin/stdout） | 要求父子进程关系；VS Code 不是 DSH 的父进程 |
| Unix socket / 命名管道 | Windows 上支持但跨平台细节多 |
| **loopback TCP** | ✅ 选了。三平台一致，Node 与 VS Code 都原生支持 |
| 共享文件轮询 | 延迟高，不适合请求-响应 |

## 1.4 我们的三段式结构

```
┌─────────────────────── DSH 进程 ───────────────────────┐
│                                                        │
│  dsh-kit-demo（消费者插件）                             │
│        │ ctx.dshVscodeKit                              │
│        ▼                                               │
│  dsh-vscode-kit（协议库）← 在这一层听 127.0.0.1:7410    │
│        │                                               │
└────────┼───────────────────────────────────────────────┘
         │  ① 写发现文件 ~/.dsh/dsh-vscode-kit/<pid>.json
         │  ② TCP 连接 + ndjson 消息
         ▼
┌──────────────────── VS Code 进程 ──────────────────────┐
│                                                        │
│  dsh-kit-bridge（薄扩展）                               │
│        │ import vscode from 'vscode'  ← 只有这里有！    │
│        ▼                                               │
│  VS Code 官方 API → 真的把文件打开了                    │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## 1.5 一个反直觉的设计点

**谁当服务端？** 直觉上会以为编辑器是"服务端"（它是被大家围着的那个中心）。

但我们是 **DSH 当服务端（listen），VS Code 当客户端（connect）**。

原因：DSH 是那个"长期的、掌管数据的一方"，而且**一个 DSH 可以同时接好几个 VS Code 窗口**
（1 对 N）。让资源的所有者当服务端，token 也由它签发，逻辑最顺。
反过来如果 VS Code 当服务端，DSH 就得反过来去轮询 VS Code 的发现文件，还不好支持多窗口。

这也和官方 ACP 的做法相反 —— ACP 是"父进程 spawn 子进程，走 stdio"。
两条路都能通，我们选了**对等发现**这条，因为它能在"VS Code 和 DSH 各自独立启动"的场景下工作。

---

## 第 1 课练习题

不用查资料，凭刚才的讲解回答：

> **问：我在 DSH 的插件里写 `import * as vscode from 'vscode'`，会发生什么？为什么？**

提示：分两层回答。第一层是"报什么错"，第二层是"为什么是这个错"，后者才是重点。

---

## 第 1 课答疑：主人原答案 vs 精确答案

### 主人原答案（2026-10-21）

> 新对话里我搞懂了 npm 是 js 的包管理器，但本身不在 npm 里，只能在 vscode 里临时扩展出一个对象来用 npm，但不能在 npm 里用 vscode。所以第一个报错是 npm 找不到 "deepseek" 这个包，第二个报错是因为这是跨进程调用，需要走协议或者管道通信，但我没做。

### 判定：**方向对了一半，但把三个角色混成了一个**

答案里最重要的那句话 ——「跨进程调用需要走协议」—— 是对的，它正是本项目的存在理由。
但具体到这两个报错，**两个都不是"没做协议"造成的**。它们俩是同一个类型的错：**模块找不到**。

### 下面逐条纠偏

#### 纠偏 1：`vscode` 这个包，npm 上**有**，但那不是我们 `import` 的那个

主人说「本身不在 npm 里」，这句话成立的前提要说清楚。实测（2026-10-21）：

| 查的东西 | 结果 |
|---|---|
| npm 上有 `vscode` 这个包吗 | **有**，`vscode@1.1.37`，128 个历史版本 |
| 它是什么 | 已废弃（Deprecated）。README 原文：`use @types/vscode and vscode-test instead` |
| 它能提供运行时对象吗 | **不能**。`package.json` 里 `main: undefined`，`bin` 只有 `vscode-install` |
| 包里是什么 | 12 个文件，里面只有 `vscode.d.ts`（类型声明）和两个测试运行脚本 |

关键：**类型声明（`.d.ts`）只在写代码时给编辑器看，运行时不存在。**
所以 `npm install vscode` 装进来的东西，`import` 进来拿到的是 `undefined`，不是那个能打开文件的 API。

正确说法是：

> `vscode` **在 npm 上有一个同名的废弃包**，但它不含运行时实现。
> 真正能被 `import` 的那个 `vscode` 对象，**任何 npm 包都装不出来** ——
> 它只由 VS Code 在加载扩展时现场注入。

实测证据：在普通 Node 里 `import('vscode')` →

```
code = ERR_MODULE_NOT_FOUND
message = Cannot find package 'vscode'
```

**更狠的一个实验**：把 npm 上那个 `vscode@1.1.37` 真的装进 `node_modules`，再 `require('vscode')` —— 依然失败：

```
require 失败 code = MODULE_NOT_FOUND
   Cannot find module 'vscode'
```

原因在它的 `package.json`：

```
main     = undefined
exports  = undefined
types    = undefined
index.js 不存在
```

Node 找包入口的三步全落空（`main` → `exports` → `index.js`），所以「装了等于没装」。
**这个实验最有说服力**：它证明了「npm 上有这个包」和「你能 import 到运行时对象」是两件毫不相干的事。

在 VS Code 扩展里同样的写法 → 正常（第 1 课 1.2 已讲）。

#### 纠偏 2：不是「在 vscode 里扩展出一个对象来用 npm」，是「VS Code 注入一个模块」

主人这句话把因果说反了。真实顺序是：

1. **npm 在安装时**把扩展文件放到磁盘上 → 它的工作到这儿就结束了
2. **VS Code 加载扩展时**，往扩展宿主的模块解析器里塞进一条规则：
   「有扩展问 `vscode` 这个名字，别去 `node_modules` 找，用我这个内置对象的」
3. 扩展代码运行时 `import 'vscode'` → 命中这条规则 → 拿到真对象

全程 **npm 已经下班了**。这是「VS Code 内建了一个模块」，不是「借 npm 装了个东西」。

#### 纠偏 3：两个报错都是「模块找不到」，不是「没做协议」

这是本课最该记住的一条。主人的答案把第二个错归因成「没走协议」，但实际：

| 报错 | 真实类别 | 真实原因 |
|---|---|---|
| `Cannot find package 'vscode'` | 模块解析失败 | 这个模块**只存在于 VS Code 扩展宿主进程**。DSH 是另一个进程，那儿没人注入 |
| `Cannot find package '@deepseek-ai/cordis'` | 模块解析失败 | **进程启动方式**变了。VS Code spawn 的 dsh 拿不到模块加载 hook，裸 import 就退回普通 ESM 规则，从 cordis-plugin-loader 自己的位置往上找，够不到装在内层的包 |

两个错都是同一个字面形态：`Cannot find package 'xxx'`。
读错误信息时，**先看错误码，再看你以为是的原因** —— 这是排障纪律。

#### 纠偏 4：「协议」这个词，要留给真正的跨进程通信

- 模块找不到 → **不是协议问题**，是「这段代码在哪儿、它能不能看见那个包」的问题
- 「让 A 进程里的函数在 B 进程执行」 → **这才是协议问题**

两个概念的区别：
前者靠**改代码结构**解决（零依赖、函数式插件）；后者靠**加通道和编解码**解决（TCP + ndjson）。
我们在项目里两件事都做了，但它们解决的是不同层面的问题。

### 三个角色的分工表（贴墙用）

| 角色 | 什么时候干活 | 干什么 | 干不上活的后果 |
|---|---|---|---|
| **npm** | 安装时 | 把包从仓库放到磁盘 `node_modules` | 包不在磁盘，后面全崩 |
| **Node** | 运行时 | 从当前文件所在目录开始，**一层层往上找 `node_modules`** | `MODULE_NOT_FOUND` |
| **VS Code** | 加载扩展时 | 往模块解析器注入 `vscode` 这条规则 | 扩展里 `import 'vscode'` 报错 |

Node 的查找路径实测（在 `resolv/a` 目录里找 `fake-pkg`）：

```
C:\...\resolv\a\node_modules      ← 先看自己这层
C:\...\resolv\node_modules        ← 再看上一层
C:\...\Temp\node_modules
C:\...\AppData\Local\node_modules
C:\...\AppData\node_modules
C:\Users\zxm\node_modules         ← 一直找到盘符根
```

同一个包，在 `resolv/a` 里能 `require` 到，在兄弟目录 `resolv/b` 里就 `MODULE_NOT_FOUND`。
**「在哪个目录」决定「能不能找到」** —— 这就是 `@deepseek-ai/cordis` 那个错的全部真相。

### 本课要带走的四句话

1. `vscode` 不是从 npm 装的，是 VS Code 现场注入的模块。
2. npm 只管安装，Node 负责运行时找包，两个角色别混。
3. `Cannot find package 'X'` 是解析问题，先查「代码在哪、包在哪」，别急着查协议。
4. 真正的跨进程调用才需要协议；协议解决的是「函数在别的进程里」。

---

# 第 2 课：消息怎么"说话"

> 本课全部结论都有实测脚本：`work/scripts/lesson2-demo.mjs`
> 跑法：`cd projects/dsh-vscode-dev && node work/scripts/lesson2-demo.mjs`

## 2.1 为什么不用自己发明的格式

进程之间只能传字节。那我们要传的是「打开这个文件」这种带结构的话。
最朴素的办法是自己拼字符串：`openFile|D:/a.txt|2|1`
但这样会掉进一堆坑：路径里有 `|` 怎么办？中文怎么编码？对面传了个畸形串我怎么报错？

**JSON-RPC 2.0** 是一个已经把这些都解决了的约定。它定死了三件事：
①消息长什么样 ②怎么配对请求和响应 ③错误怎么表达。

我们不重造轮子，只在它上面加自己的方法名。

## 2.2 一条请求长什么样

```json
{"jsonrpc":"2.0","id":1,"method":"vscode.openFile","params":{"path":"D:/a.txt","line":2},"token":"abc123"}
```

四个字段各有分工：

| 字段 | 干什么 | 我们项目里的实例 |
|---|---|---|
| `jsonrpc` | 说明「我遵守 2.0 版约定」 | 永远是 `"2.0"` |
| `id` | **配对用的号码牌** | 从 1 开始自增，每个请求唯一 |
| `method` | 要干什么 | `vscode.openFile` / `vscode.getSelection` |
| `params` | 参数 | 每个方法自己定 |
| `token` | **我们自己加的**，鉴权用 | 64 位十六进制串 |

## 2.3 `id` 到底解决什么问题：乱序

这是本课第一个硬概念。**响应回来的顺序，和请求发出去的顺序，不一定一样。**

实测（演示 2）：同时发 `slow`（要 80ms）和 `fast`（立刻回）：

```
  fast 先回来： {"who":"fast"}
  slow 后回来： {"who":"slow"}
  → 两个结果没串位，因为每个请求带唯一 id，回包按 id 认领
```

如果没有 `id`，两个响应长这样：`{"result":{"who":"fast"}}` 和 `{"result":{"who":"slow"}}`。
你能靠内容猜，但一旦两个响应内容一样（比如都是 `{"ok":true}`），就彻底分不清了。

**`id` 是号码牌，不是序号。** 它只用来配对，不表示先后。

> 我们的 `protocol.js` 里有一张 `pending` Map：`id → {resolve, reject, timer}`。
> 发请求时把 Promise 的开关存进去，收到回包时按 `id` 取出来拨一下。

## 2.4 三种消息形态

JSON-RPC 只有三种形态，记住这张表就够用：

| 形态 | 有 `id` 吗 | 有 `method` 吗 | 要回包吗 | 我们的例子 |
|---|---|---|---|---|
| **请求** | ✅ | ✅ | ✅ 必须回 | `vscode.openFile` |
| **响应** | ✅ | ❌ | 不回（它就是回包） | `{"id":1,"result":{...}}` |
| **通知** | ❌ | ✅ | **不回** | `bridge.hello` |

实测（演示 3）：发一条没有 `id` 的消息，对面处理了，但**不会产生任何回包**：

```
  收到的通知： {"method":"bridge.hello","params":{"x":1}}
  → 处理完了，但因为没 id，不产生任何回包
```

**为什么要「通知」这种东西？** 因为有些事不需要回执。
比如 DSH 连上后主动告诉编辑器「我支持这些能力」，编辑器知道了就行，不用回答。
用通知能省一次往返（一个来回就是一次等待）。

## 2.5 怎么保证一条消息不被切两半

TCP 是**字节流**，不是消息流。你 write 了两次，对面可能一次收到，也可能分五次收到。
这在术语上叫**粘包**（两次写的粘一起）和**拆包**（一次写的被拆开）。

解决办法：**定一个「消息结束标记」，收到标记才认为一条消息完整。**

我们选的方案叫 **ndjson**（newline-delimited JSON，换行分隔的 JSON）：
每条消息单独一行，用 `\n` 当结束标记。

但这有个前提：**JSON 内容里不能出现真的换行**。实测（演示 1）：

```
  原文里有真换行吗？       true
  JSON.stringify 之后：     {"text":"第一行\n第二行"}
  序列化后还有真换行吗？   false
```

`JSON.stringify` 会把字符串里的真换行转义成两个字符 `\` 和 `n`（**不是**换行本身）。
所以序列化之后的 JSON **一定不含真换行** → 按 `\n` 切行永远不会切错。

这条性质是白送的，不用我们额外做什么。**这也是为什么选 ndjson 而不是自己搞长度前缀。**

> 但有一个坑我们真踩过：Windows 换行是 `\r\n`。
> 按 `\n` 切开后，每行末尾还留着一个 `\r`，`JSON.parse` 会失败。
> 修法是在切行那一层统一剥掉 `\r`（见经验手册 §6）。

## 2.6 出错时怎么说话：错误码

响应有两种：成功带 `result`，失败带 `error`：

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"file not found: D:/nope.txt","data":{"path":"D:/nope.txt"}}}
```

`code` 是**数字**，机器读；`message` 是**字符串**，人读；`data` 放结构化细节，排障用。

**为什么用数字而不是字符串？** 因为数字稳定。你改文案不会破坏判断逻辑。

我们的错误码分两组：

| 组 | 码 | 谁定的 |
|---|---|---|
| JSON-RPC 标准 | `-32700` 解析失败 / `-32600` 请求非法 / `-32601` 方法不存在 / `-32602` 参数非法 / `-32603` 内部错误 | 标准，不改 |
| 我们自己的 | `-32001` 未授权 / `-32002` 用户拒绝 / `-32003` 找不到 / `-32004` 超时 / `-32005` 对端不支持 / `-32006` 工作区未信任 / `-32007` 没连接 | 项目自定义 |

标准规定 `-32000 ~ -32099` 这段留给应用自己用，所以我们的码都在这里。

### 一个真实的设计判断：`-32005` 和 `-32601` 为什么分开

初看这两个都是「做不到」。但我们刻意分开：

- **`-32601`（方法不存在）** = 这是**编程错误**。你调了一个协议里根本没定义的方法，代码写错了。
- **`-32005`（对端不支持）** = 这是**正常的降级场景**。方法协议里有定义，但对面的编辑器版本没实现它。

区别在于**调用方该怎么反应**：前者该去改代码，后者该换个做法继续跑。
错误码如果不分，调用方就只能一律当崩溃处理。

## 2.7 token 怎么验：每条消息都验

实测（演示 4）：

```
  错误码： -32001 （-32001 = 未授权）
  原因：   bad-token
```

有个设计选择值得说：token **不是在连接建立时验，而是每条消息都验**。

原因两条：
1. 连接建立时不验，**连上也什么都干不了** —— 攻击者连上来也探测不出 token 对不对，因为不告诉他。
2. 断线重连**不用重开 socket**，只要带对 token 就能继续。

而且错误的 token 和缺失的 token 会给不同的 `reason`（`bad-token` / `missing-token`），方便排障时区分。

---

## 第 2 课练习题

> **问：我要同时请求「打开文件」和「读取选区」两件事，分别用请求还是通知？为什么？**

提示：想两件事 —— ①我需不需要知道结果？②如果不等结果就往下走，会出什么问题？

---

## 第 2 课答疑：主人原答案 vs 精确答案

### 主人原答案（2026-10-21）

> 不一样，打开文件只需要打开这个动作本身就带着回复，读取选区需要回复读取的内容。

### 判定：**答错了，但错得很有价值 —— 错在一个几乎所有人都会踩的地方**

这个答案的直觉是：**「打开文件」是一次性动作，「读取」才需要拿数据。**
所以打开算「通知」，读取算「请求」。

听起来特别顺。但它有一个致命前提被漏掉了：**「打开文件」这个动作会失败。**

### 为什么「一次性动作」不等于「不用回收结果」

主人把两件事分成了「有回话 / 没回话」，但正确的分法不是这个。正确的分法是：

> **这件事会不会失败？失败了我要不要知道？**

「打开文件」至少有五种失败方式，全都在我们的真实代码里：

| 失败原因 | 错误码 | 代码位置 |
|---|---|---|
| 文件根本不存在 | `-32003` | `capabilities.js:94` |
| `params.path` 是空字符串或不是字符串 | `-32602` | `capabilities.js:88` |
| 工作区没被信任 | `-32006` | `capabilities.js:74` |
| 编辑器版本没这个能力 | `-32005` | `capabilities.js:232` |
| 扩展根本没连上 | `-32007` | kit 的 `request()` |

**一个有五种失败方式的动作，不能用「不回收结果」的通知来发。**

### 实测后果（`work/scripts/lesson2-answer-check.mjs`）

我写了脚本，让同一个失败场景分别走两条路。真实输出：

**用请求（有 id）：**

```
  ✅ 调用方收到错误：
     code    = -32003 ( -32003 = 找不到 )
     message = file not found: D:/nope.txt
     data    = {"method":"vscode.openFile","path":"D:/nope.txt"}
  → DSH 能据此告诉 agent「文件不存在，换个路径」
```

**用通知（没有 id）：**

```
  通知发出去了，然后呢？
  → 客户端这边：什么都没发生
     （没有 Promise 可以 await，也没有异常可 catch）
  → 服务端这边：错误只记在它自己的 onError 里
     onError 收到: file not found: D:/nope.txt
  ❌ DSH 永远不知道失败了
     agent 会以为文件打开了，继续往下做 —— 这就是静默失败
```

**「静默失败」是本项目最怕的一种 bug。** 它不报错、不崩，只让 agent 基于错误前提一路做下去，最后产出一堆垃圾。排障时你甚至不知道从哪查起。

### 正确的判断标准（本课最该记的一条）

不要问「这个动作需不需要回话」，要问：

> **这件事失败了，我需不需要知道？**

| 需要知道失败 → 用**请求** | 不需要 → 可用**通知** |
|---|---|
| `vscode.openFile`（5 种失败） | `bridge.hello`（能力清单，丢了下次再说） |
| `vscode.getSelection`（可能没编辑器） | 日志上报（丢几条无所谓） |
| `vscode.getDiagnostics` | 心跳 |
| 任何有参数校验的动作 | 任何「说了就行」的广播 |

**只要有参数、有校验、可能失败，就必须用请求。** 通知只留给「丢了也不影响业务」的东西。

### 顺带纠正一个措辞

主人说「打开这个动作本身就带着回复」。这个说法混淆了两件事：

- **动作发生了** ≠ **动作成功了**
- 编辑器那边确实「动了一下」，但「动了一下」不等于「打开了」

用通知的话，我们只能知道「消息送到了」，**永远不知道「事办成了没有」**。
这两者的差距，就是静默失败的空间。

### 所以正确答案是

**两个都用请求。** 理由不在于「要不要拿数据」，而在于**两个都可能失败，都必须让调用方知道**。

我们项目里也确实是这么做的 —— `capabilities.js` 的四个能力全部走请求，
而全项目只有 `bridge.hello` 一个通知，因为它真的「丢了也不影响业务」。

---

# 第 3 课：怎么"找到对方"

> 本课结论都可用脚本复现：`work/scripts/lesson3-demo.mjs`
> 跑法：`cd projects/dsh-vscode-dev && node work/scripts/lesson3-demo.mjs`

## 3.1 这一课要解决的问题

第 1 课我们说：两个进程要通信，得有一条通道。第 2 课我们说：通道上说话用 JSON-RPC。

但**中间还缺一环**，而且是最容易被忽略的一环：

> VS Code 和 DSH 是**各自独立启动**的。
> 你先开 VS Code，或者先开 DSH，顺序任意。
> 那么 —— **它怎么知道对方在哪？端口是多少？**

这不是小事。端口是操作系统分配的，每次启动可能不同。而且你可能同时开两个 DSH、三个 VS Code 窗口。

**答案是一个土办法：往一个固定的抽屉里塞纸条。**

## 3.2 抽屉在哪

```
C:\Users\<你>\.dsh\dsh-vscode-kit\
```

就这一个目录，双方都知道它。

- **DSH 启动时**：往里面写一张「名片」，然后开始监听端口
- **VS Code 扩展启动时**：每 2 秒扫这个目录，看有没有活的名片

代码里这个路径不是写死的，而是按优先级算出来的（`discovery.js:27`）：

```js
export function resolveDshHome(explicit) {
  if (explicit) return explicit                    // ① 配置里明确指定
  if (process.env.DSH_HOME) return process.env.DSH_HOME  // ② 环境变量
  return join(homedir(), '.dsh')                   // ③ 兜底：用户主目录
}
```

**为什么要三级？** 因为测试要能指定临时目录（我们 38 条单测全靠这个），用户要能改位置，普通情况要有个默认值。

## 3.3 名片上写什么

真实写出来的内容（脚本演示 2 的实测输出）：

```json
{
  "port": 7410,
  "token": "857129ba32464f23dcee…（共 64 个字符）",
  "pid": 34608,
  "startedAt": 1792529682615,
  "dshVersion": "lesson3-demo",
  "protocolVersion": 1,
  "capabilities": ["bridge.ping"]
}
```

（这是脚本 `work/scripts/lesson3-demo.mjs` 演示 2 的真实输出，不是编的。）

每个字段都有用，一个都不能省：

| 字段 | 干什么 | 少了会怎样 |
|---|---|---|
| `port` | 连哪个端口 | 根本连不上 |
| `token` | 通行证 | 连上也被 `-32001` 拒绝 |
| `pid` | 这个实例的进程号 | 无法判断它是不是还活着 |
| `startedAt` | 启动时间戳 | 多个实例时不知道该连哪个 |
| `protocolVersion` | 协议版本 | 双方版本不匹配还硬聊，会解析炸掉 |
| `capabilities` | 我支持哪些能力 | 调用方只能盲试 |
| `dshVersion` | DSH 版本号 | 排障时不知道对方是什么版本 |

## 3.4 文件名为什么是 `pid.json`

文件名就是 `<pid>.json`（`discovery.js:46`）。**为什么不用端口做文件名？** 也不该用 token 做文件名。这条实测输出说得很直白：

```
  文件名只用 pid： 34608.json
  → 文件名会被 ls / 日志 / 报错信息带出去，token 放进去等于到处宣传
```

因为名片要回答的问题是「**有哪些实例活着**」，而「活着」是进程的属性，不是端口的属性。
用 pid 命名，好处是：

1. 同名文件天然覆盖 —— 同一个进程重启后 pid 一般不同，不会留下重复
2. 清理时一眼就知道该查哪个进程
3. **文件名本身不泄密**（pid 不是秘密，token 是）

## 3.5 原子写：为什么不能直接 `writeFileSync`

这是本课第一个真正的技术点。

**问题**：VS Code 那边可能**在任何时刻**来读这个文件。如果你正在写（只写了一半），它读到的就是**半截 JSON**，`JSON.parse` 直接炸。

**解法**：先写临时文件，写完再「改名」（`discovery.js:44`）：

```js
const temp = join(dir, `.${payload.pid}.${randomBytes(6).toString('hex')}.tmp`)
writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
renameSync(temp, target)   // ← 关键这一行
```

**为什么 `rename` 能解决？** 因为在同一磁盘上，`rename` 是**原子操作**：
操作系统层面要么「还是旧文件」，要么「已经是新文件」，**不存在「写了一半」的中间状态**。

所以读者看到的永远是**一个完整的旧版本**或**一个完整的新版本**，绝不会是半截。

> 这个技巧在别处也常用：配置文件热更新、日志轮转、Git 写 index。
> 记住这套路：**写临时文件 → rename 覆盖**。

## 3.6 `chmod 0600` 在 Windows 上是骗人的

代码里写了 `mode: 0o600`（只有自己能读写），还额外补了一次 `chmodSync`：

```js
writeFileSync(temp, ..., { mode: 0o600 })
try { chmodSync(temp, 0o600) } catch { /* best effort on Windows */ }
```

**但实测结果呢？**（脚本演示 3）

```
  代码里写的是 0600（只允许自己读写）
  实际 stat 出来： 666
  ⚠️ Windows 上 chmod 的语义与 POSIX 不同，这里拿不到 600
  → 所以「靠权限位保护 token」在 Windows 上靠不住
  → 真正兜底的是：目录在用户 home 下 + 只监听 127.0.0.1
```

`666` = 所有人都能读写。

**这是 Windows 的 POSIX 兼容层不完整导致的**，不是 bug，是平台差异。所以我们的安全不能只靠权限位，还需要另外两道：

1. 目录在用户 home 下（`C:\Users\<你>\.dsh\` —— 其他用户默认进不来）
2. 端口只监听 `127.0.0.1`（见 3.8）

**这条值得记进脑子**：写跨平台代码时，**权限位这种东西在 Windows 上不能当真**。
写到代码里的保护，必须在目标平台上实测过才算数。

## 3.7 死掉的实例会留下骗人的名片

DSH 被强杀（任务管理器结束进程、断电）时，来不及删名片。于是目录里会留着一张「过期名片」，写着已经不存在的端口。

**如果编辑器照着这张名片去连，就会连到一个死端口，然后一直等。**

我们的处理是：**名片存在 ≠ 实例存活**，要用 `pid` 探一下（`discovery.js:71`）：

```js
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)   // 0 号信号 = 只检查，不真发信号
    return true
  } catch (err) {
    return err.code === 'EPERM'   // EPERM = 存在但没权限 → 仍算活着
  }
}
```

**`process.kill(pid, 0)` 是这行的关键。** 它不发任何信号，只让操作系统检查「这个 pid 存不存在、我有没有权限」。

两个返回值要分清：

- `ESRCH` = No such process → **死了**
- `EPERM` = 存在但我没权限动它 → **活着**（这点很容易写错，把 EPERM 当成死）

实测（脚本演示 4）：

```
  伪造死名片后，目录里有： 34608.json, 999999.json
  pid 999999 还活着吗？ false
  listLiveBridges 只返回： 34608 （死的那张被跳过了）
  sweepDiscoveryDir 删掉了： 999999.json
  → 编辑器不会被一张过期名片骗去连一个不存在的端口
```

## 3.8 `127.0.0.1` 到底是什么意思

看这个 IP 会觉得奇怪：为什么不是本机的局域网 IP（比如 `192.168.1.5`）？

| 地址 | 意思 | 谁能连 |
|---|---|---|
| `0.0.0.0` | 接受**所有**网络接口 | 本地 + 局域网 + （如果路由器转发）公网 |
| `127.0.0.1` | 只接受**本机**回环接口 | **只有本机的进程** |
| `192.168.1.5` | 只接受这一个网卡 | 局域网 |

我们 bind 的是 `127.0.0.1`（`server.js` 里写死，非 loopback 直接抛错）：

```js
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  throw new Error(`refusing to bind non-loopback host "${host}"`)
}
```

**为什么这么严格？** 因为 token 会通过这个端口传输。
如果 bind 到 `0.0.0.0`，同一个 WiFi 下的任何人都能连上你的 7410 端口，慢慢试 token。

**这是「默认安全」的设计**：不做「默认开放 + 可选收紧」，而是**默认就关死，想开也开不了**。

## 3.9 端口为什么要用区间 7410-7419

代码里的常量（`server.js`）：

```js
export const DEFAULT_PORT_RANGE = [7410, 7419]
```

启动时从 7410 开始逐个试，遇到占用就换下一个（`listenOnFreePort`）。

**为什么不固定一个端口？**

因为端口可能被别的程序占了（尤其是重启 DSH 时，上一个还没释放干净）。固定端口会导致第二次启动失败。

**为什么要有区间而不是随便挑？**

为了**可预测**。排障时你知道「去看 7410-7419」，而不是「全端口扫一遍」。

> 顺便说个细节：这个区间是**刻意避开** Fengze233 那个扩展的 7310-7319 段。
> 两个项目各占一段，同机共存不会打架。

## 3.10 多个实例时，编辑器连哪个

`listLiveBridges` 的返回是**按 `startedAt` 降序**（`discovery.js:130`）：

```js
out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
```

实测（脚本演示 5）：

```
  listLiveBridges 返回顺序（startedAt 降序 = 最新的在前）：
    [0] port=7422 pid=18376 假实例（演示排序用）
    [1] port=7410 pid=34608 (真实例)
  → 编辑器取 [0]（startedAt 最大的那个），这就是多实例仲裁规则
```

**规则**：连最新启动的那个。

**为什么？** 因为「最新的」通常就是你正在用的那个（你刚开的窗口）。
这是个启发式规则，不是绝对正确 —— 所以我们在架构上留了余地，将来可以换成「让用户选」。

> ⚠️ 这个演示里我自己也踩了一个坑，值得记下来：
> 一开始我想在**同一个进程里**起两个 server 来演示多实例，结果名片文件名是 `<pid>.json`，
> 同一个进程 pid 相同 → **后起的把前一个的名片覆盖了**。
> 这反而证明了一件事：**多实例仲裁只在「不同进程」时才有意义**，
> 单测里造不出这个场景，必须真机验证（我们在 E2E 里用两个真子进程验的）。

## 3.11 把这一课的链路串起来

```
① DSH 启动
   ├─ 找一个空闲端口（7410 起，逐个试）
   ├─ 生成 token（randomBytes(32) → 64 个 hex 字符）
   ├─ 在 127.0.0.1:那端口 上 listen
   └─ 写名片 ~/.dsh/dsh-vscode-kit/<pid>.json（临时文件 → rename 原子写）

② VS Code 扩展启动
   ├─ 每 2 秒扫 ~/.dsh/dsh-vscode-kit/
   ├─ 逐个名片：pid 还活着吗？（process.kill(pid, 0)）
   ├─ 活着的按 startedAt 降序排，取 [0]
   └─ 连 127.0.0.1:<port>，每次请求都带那个 token

③ 之后
   ├─ DSH 被强杀 → 名片残留 → 下次清扫时按死 pid 删掉
   └─ DSH 正常退出 → 主动删名片
```

**这条链路回答了一个核心问题**：两个独立启动的进程，靠**一个双方都知道的目录** + **一张写着联系方式的名片** + **每次心跳式的 pid 探测**，就能互相找到。

它不需要服务注册中心，不需要广播，不需要配置文件。**只需要一个约定好的路径。**

---

## 第 3 课练习题

> **问：如果我不小心把 `127.0.0.1` 改成了 `0.0.0.0`，会发生什么？风险有多大？**

提示：想两件事 —— ①谁能连上来了？②token 还能保护住什么？

---

## 第 3 课答疑：主人原答案 vs 精确答案

### 主人原答案（2026-10-21）

> **理解部分**：dsh 启动后会在分配的端口端找空闲端口，若有就生成鉴权 token，开始本地回环 listen，并且生成带这个 token、有 pid 的名片 json。等 vs 启动扩展后会循环监测扫一个最容易认的文件目录，找到里面的结构化数据 json，确认存活性后，领取一个确认存活的 pid，去在 localhost 网段进行 pid 间的通信，靠 token 来识别是否对话正常。但是这样的方式是否有性能浪费。
>
> **练习题答案**：0.0.0.0 是面向几乎所有的网段，这意味着任何人都能进。token 会在这种情况被爆破。

### 判定

- **练习题：对了一半，但"爆破"这个词把风险说偏了**（详见 3.D）。
- **理解部分：主干全对，三处需要校准**，其中第 2 处是概念性错误。

先校准，再答性能。

---

## 3.A 校准三处

### 校准 1：顺序基本对，但起点是"清扫"而不是"找端口"

主人说的顺序：找空闲端口 → 生成 token → listen → 写名片。**代码实际顺序几乎一样**（`server.js:113-174`）：

```js
if (sweep) sweepDiscoveryDir(dir)                    // ① 先清扫上一轮的死名片
const token = randomBytes(32).toString('hex')        // ② 生成 token（64 个 hex 字符）
const { server, port } = await listenOnFreePort(...)  // ③ 从 7410 逐面试，listen
const discoveryPath = writeDiscoveryFile(dir, payload) // ④ 写名片
```

差别只在 ①：**listen 之前先扫一遍旧名片**，把上次被强杀留下的残留清掉。这一步容易漏，因为它是"不做也能跑，但目录会越积越脏"的那种逻辑。

### 校准 2 ★：「pid 间通信」这个说法是错的

主人原话：「领取一个确认存活的 pid，去在 localhost 网段进行 **pid 间的通信**」。

**TCP 不能按 pid 通信。** pid 只是进程在本机的一张身份证号，它**不参与任何网络寻址**。你没法"连接到 pid 34608"，只能"连接到 127.0.0.1:7410"。

真实的分工是这样的：

| 东西 | 在链路里的角色 | 用在哪一步 |
|---|---|---|
| `pid` | **身份证**，只用来回答"这个实例还活着吗" | 扫目录时 `process.kill(pid, 0)` |
| `port` | **门牌号**，TCP 连接的唯一寻址依据 | `createConnection({port})` |
| `token` | **通行证**，每条消息验证一次 | 每条消息的顶层 `token` 字段 |

一句话：

> **pid 决定"要不要连"，port 决定"连到哪"，token 决定"让不让你办事"。**
> 三者各管一件事，pid 从头到尾没进过 TCP。

顺带纠一个小词：`localhost` 不是"网段"，它是一个主机名，解析到回环接口 `127.0.0.1`。真正的"网段"叫法是 `127.0.0.0/8`。这个用词不影响理解，但排障时说错会误导自己。

### 校准 3：「循环监测」只在整个"没连上"期间发生

主人说"vs 启动扩展后会循环监测扫一个最容易认的文件目录" —— 对，但有个重要补充，正好接上性能问题：

**连上之后就不扫了。**（`connector.js:173`）

```js
async function tick() {
  if (stopped || state.state === 'ready' || state.state === 'connecting') return
  //                      ↑ 已经 ready 就直接返回，一次磁盘都不碰
  const bridges = listLiveBridges(dir)
  ...
}
```

这一点是性能问题的关键答案：**扫描是有止境的，不是永远在扫。**

---

## 3.B 性能：真实测量，不估算

脚本：`work/scripts/lesson3-cost.mjs`（跑法 `node work/scripts/lesson3-cost.mjs`）。以下全是实测输出。

### 测量 1：一次扫描花多少

```
  2000 次，共 96.1 ms
  单次 ≈ 48.1 微秒
```

48 微秒。这个数字包含：读目录 → 读每个 json → `process.kill(pid,0)` 探活 → 按时间排序。

**参照物**：人眼一次眨眼约 100000 微秒。一次扫描是眨眼的 **1/2000**。

### 测量 2：折成长期占用

```
  每 2000 ms 跑一次 / 单次 ≈ 0.048 ms
  → CPU 占用率 ≈ 0.0024 %
  → 一天跑 43200 次，累计 ≈ 2.1 秒
```

**一天总共 2.1 秒 CPU。** 而且这 2.1 秒只在"没连上"时发生 —— 连上后归零。

作为对照，一个 VSCode 扩展宿主本身的基础占用是百分之几的量级。**这个扫描在噪声里，测不出来。**

### 测量 3：连一次要多久

```
  连一次（含 hello 往返）≈ 0.51 ms
```

半毫秒。而且这只在启动/重连时发生一次。

### 测量 4：空闲时到底消耗什么

```
  这一个进程空闲 1 秒的 CPU：user 0.00 ms + system 0.00 ms
```

**0。** 因为：

- 连接建立后双方都不轮询、不发心跳、不查存活
- TCP 是事件驱动的：socket 空闲时进程在内核里睡觉，数据到了才被唤醒

这是 Unix 的 `epoll`/Windows 的 `IOCP` 干的事 —— **"等"不花 CPU**。

### 结论：这个设计有没有性能浪费？

**有，但量级可以忽略，而且换来的是更重要的东西。**

| 项 | 实测成本 | 评价 |
|---|---|---|
| 未连接时每 2 秒扫一次 | 48 µs / 次，CPU 0.0024% | 可忽略 |
| 连接建立 | 0.51 ms，仅一次 | 可忽略 |
| 已连接后空闲 | 0 CPU | 零成本 |
| 每次请求的协议开销 | 一次 JSON 序列化 + 一次 socket.write | 微秒级 |

**真正该问的不是"浪费多少"，而是"这个浪费换来了什么"**：

1. **不需要配置文件** —— 用户不用手填端口
2. **不需要注册中心** —— 没有常驻服务
3. **不需要约定启动顺序** —— 谁先起都行
4. **能自动重连** —— DSH 重启后 VS Code 自己发现

如果把这套换成"用户手填端口"，那 48 µs 是省下来了，代价是每次重启都要人工介入。

> 工程上有个判断标准：**省下来的时间能不能被用户感知？** 0.0024% 的 CPU 用户感知不到，但"每次都要手填端口"用户立刻就烦了。这就是为什么这个"浪费"是值得的。

---

## 3.C 那为什么不用 `fs.watch`（文件监听）？

这是主人问题的自然延伸，而且我必须**诚实交代**：

> **`fs.watch` 我们没做。** 它在架构文档里是「待验证点 4」，到打样结束仍然标着"未验证"。

这不是忘了，是权衡后放着。原因三条：

| 原因 | 具体问题 |
|---|---|
| 平台行为不一致 | `fs.watch` 在 Windows/macOS/Linux 上语义不同，Linux 用 inotify（有上限）、macOS 用 FSEvents、Windows 用 ReadDirectoryChangesW |
| 网络盘直接不工作 | 如果 `~/.dsh` 在网络漫游盘上，`fs.watch` 静默失效 |
| 换来的收益太小 | 48 µs / 2 秒，换成文件监听也就是省掉这 48 µs |

**这就是"值不值得"的判断**：`fs.watch` 能把 48 µs 降到 0，但它引入三个平台差异问题。**用不必要的不确定性换可忽略的收益，是错的。**

> 这条经验值得记：**轮询不是原罪，"高频轮询"才是。** 2 秒一次、每次 48 µs，这是好轮询；10 毫秒一次、每次扫全盘，那才是浪费。
> 判断标准：**轮询间隔 >> 单次耗时**，比如这里 2000 ms vs 0.048 ms，比值 40000:1。

---

## 3.D 练习题判定

### 主人答案

> 0.0.0.0 是面向几乎所有的网段，这意味着任何人都能进。token 会在这种情况被爆破。

### 判定：**方向对，但「爆破」把风险说偏了 —— 既低估了也高估了**

**对的部分**：`0.0.0.0` = 接受所有网络接口（本机 + 局域网 + 路由器转发的话还有公网），"任何人都能进"。完全正确。

**高估的部分**：**token 爆破不了。**

```js
randomBytes(32).toString('hex')   // 32 字节 = 256 位 = 64 个 hex 字符
```

256 位随机数。即使每秒试 10 亿个，试完所有组合需要 **10^60 年**（宇宙年龄的 10^50 倍）。**爆破在物理上不可能。**

**低估的部分**：真正的风险**不需要爆破**。我做了实测（测量 5）：

```
  ★ 我们发出去的原始字节（就是这段明文）：
    {"id":1,"method":"bridge.ping","params":{},"token":"ea6317bdfba03604c9859d124032f6b96105d7333a2eace36e9cdeea7973e820"}
```

**token 在 TCP 上是明文传输的，双向都是。**

所以如果 bind 到 `0.0.0.0`，攻击者**根本不用猜** —— 在同一个 WiFi 下抓一个包，token 直接到手。

### 更糟的是：连接不会因为错 token 被断开

实测输出第 2 行：

```
{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"unauthorized",...,"reason":"bad-token"}}
```

**只拒绝这一条消息，连接依然活着。** 这意味着在一条连接上可以无限次尝试。这是刻意的设计（协议层职责分离：鉴权不等于断连），但它意味着**"试错成本"这道防线并不存在**。

### 所以精确答案是

把 `127.0.0.1` 改成 `0.0.0.0`，风险按严重程度排序：

| # | 风险 | 严重度 | 为什么 |
|---|---|---|---|
| 1 | **抓包直接拿到 token** | 致命 | 明文传输，无需爆破 |
| 2 | 局域网内任意机器可连 | 高 | 已经不需要"攻破"，连上就能试 |
| 3 | NAT/路由器转发可能暴露到公网 | 高 | 取决于家里网络环境，不可控 |
| 4 | 试错无成本 | 中 | 错 token 不断连，可无限试 |
| 5 | ~~token 被爆破~~ | **不存在** | 256 位，物理上不可能 |

**一句话总结**：

> 风险不是"token 会被算出来"，而是"token 会被看到"。
> 加密强度救不了明文传输 —— 这就是为什么 `127.0.0.1` 这条检查不能只当注释，必须写成 `throw`。

### 这也解释了代码里为什么写得这么硬

```js
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  throw new BridgeError(ERR.INTERNAL, `refusing to bind non-loopback host "${host}"`)
}
```

不是"警告一下让用户自己决定"，而是**直接拒绝启动**。因为一旦放开，用户不会意识到自己把明文 token 暴露到了局域网。

---

## 第 3 课答疑（第二轮）：查证时挖出三个真洞

### 主人原答案（2026-10-21）

> 攻击者连不上我的内网吧。如果连上了，我们的每次请求后续还会带 token。

### 判定：**对了一半，而且第二半正好踩着 bug**

为了回答这个问题，我写了三个验证脚本去实测：

- `work/scripts/lesson3-verify-hello.mjs` —— 验证 hello 里有没有 token
- `work/scripts/lesson3-hijack.mjs` —— 验证能不能劫持 DSH 的调用
- `work/scripts/lesson3-leak.mjs` —— 验证其他攻击面

结果：**我们自己的代码里查出三个真缺陷。**

---

## 3.E 洞 1：hello 白送 token（最严重）

### 实测

```
=== 验证 1：服务端连上就发的第一条消息，有没有 token？ ===
  原始消息：
    {"jsonrpc":"2.0","method":"bridge.hello","params":{...},"token":"d78eb530c2788779b7e0…（共 64 字符）
  名片里的真 token：d78eb530c2788779b7e0…
  两者相同吗？ ★ 是 —— token 被白送了

=== 验证 2：用 hello 白拿的 token 能通过鉴权吗？ ===
  回复：{"jsonrpc":"2.0","id":99,"result":{"pong":true,...}}
  ★ 成功 —— 攻击者用 hello 白拿的 token 就成了合法对端

=== 验证 3：完全不带 token 的连接，还能收到 hello 吗？ ===
  收到了：method=bridge.hello
  里面照样带 token：是
  → 也就是说，握手发生在鉴权之前。
```

### 代码原因

`packages/dsh-vscode-kit/src/server.js:130-156`：

```js
const link = connect({
  write, onRequest, timeoutMs,
  token,                                    // ← ① 把 token 交给协议终端
  authorize: (incoming) => incoming === token,
})
...
link.notify('bridge.hello', { ... })        // ← ② hello 走 notify
```

`packages/dsh-vscode-kit/src/protocol.js:174-178`：

```js
function notify(method, params) {
  const msg = { jsonrpc: '2.0', method, params: params ?? {} }
  if (token !== undefined) msg.token = token   // ← ③ 所有出站消息一律附加
  send(msg)
}
```

**三条各自都没错，合起来就成了洞**：hello 是连接建立后**第一条**消息，发在**客户端还没证明身份之前**，却已经把通行证一起寄出去了。

### 后果

token 的**全部意义**是"只有真编辑器知道它"。它被白送之后，鉴权等于不存在：

> 任何人只要能连上 127.0.0.1:7410，第一条消息就拿到 token，然后就是合法对端。

### 该记的经验

> **"先打招呼"和"先验身份"不能同时成立。** 任何"连上就主动推一段信息"的协议，都要检查这段信息里有没有凭证——尤其当"推送"和"带凭证"是同一个函数的默认行为时。
> 默认带凭证很方便，但**默认**意味着写这段代码的人根本没意识到自己在发凭证。

---

## 3.F 洞 2 + 洞 3：能劫持，且伪造的回复会被接受

### 洞 2：谁最后连上，谁就是"编辑器"

`packages/dsh-vscode-kit/src/index.js:64-66`：

```js
_activeLink() {
  const links = [...this.server.links]
  return links.length ? links[links.length - 1] : null   // ← 最后一个
}
```

`packages/dsh-vscode-kit/src/server.js:148`：

```js
links.add(link)   // ← 连接一建立就加，跟 token 对不对无关
```

### 洞 3：响应不过鉴权门

`packages/dsh-vscode-kit/src/protocol.js:197-210` 的响应分支：

```js
const isResponse = msg.id !== undefined && msg.method === undefined
if (isResponse) {
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  clearTimeout(entry.timer)
  if (msg.error !== undefined && msg.error !== null) entry.reject(BridgeError.from(msg.error))
  else entry.resolve(msg.result)     // ← 直接 resolve，全程没调 authorize
  return
}
```

而 `respond()` 也不带 token（`protocol.js:181-183`）：

```js
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })   // ← 没有 token
}
```

**所以"响应不带 token"和"响应不验 token"是自洽的——自洽地一起错。**

### 实测劫持（`lesson3-hijack.mjs`）

```
=== 场景准备 ===
  桥：127.0.0.1:7410
  ① 真编辑器连上并报了身份
     kit.lastEditor = "real-vscode"
     在线连接数 = 1

=== 攻击者做了什么？只是连上了。没 token、不认识协议库，就裸 socket。 ===
     在线连接数 = 2
     kit.lastEditor 还是 "real-vscode"（身份没被改）

=== 现在 DSH 侧发起一个正常请求：读编辑器选区 ===
  真编辑器收到请求了吗？ 否 —— 请求发给了别人
  攻击者收到 DSH 的请求数量：1
  ★ 请求里附带 token，攻击者现在知道它是：685a52aaced8e9bb61b90528…

  ★★★ DSH 侧拿到的 result：
      {"text":"FAKE-SELECTION-FROM-ATTACKER","file":"C:\\fake.txt","isEmpty":false}
  ★★★ 这是攻击者伪造的数据 —— 冒充成功。响应不过鉴权门。
```

注意攻击者**全程没发过一条带 token 的消息**，只是：

1. `net.createConnection({port})` 连上——就这样就成了"最后一个连接"
2. 收到 DSH 的请求（里面**带着 token**，等于洞 1 再来一次）
3. 回一段 JSON，DSH 就信了

### 该记的经验

> **只拦"进"不拦"出"的鉴权，等于没鉴权。** 请求验了 token，响应不验，那攻击者只需要"等"，不需要"猜"。
> 更根本的一条：**"谁是活跃对端"不该由连接顺序决定，该由身份决定**。连接顺序是网络事实，身份是协议事实，两者混淆就会被抢占。

---

## 3.G 校准主人的答案

### 对的部分

> 「攻击者连不上我的内网吧」

**对**。`127.0.0.1` 只在本机回环接口上监听，外网、局域网都进不来。这一条守住了。

### 需要补的部分

> 「内网」和「本机」不是一回事。

`127.0.0.1` 挡住的是**网络上的别人**，挡不住**本机上的别的进程**。而开发机的本质就是"跑很多来路不明的代码"：

| 本机进程 | 能不能连 127.0.0.1:7410 |
|---|---|
| 你自己敲的命令 | ✅ 能 |
| 某个 npm 包的 postinstall 脚本 | ✅ 能 |
| 被投毒的依赖 | ✅ 能 |
| 任何脚本、任何 Electron 应用 | ✅ 能 |

**所以"只监听回环"降低的是"外部攻击"，不是"本机攻击"。** token 存在的意义恰恰是防本机——而它现在不防。

### 需要纠正的部分（关键）

> 「如果连上了，我们的每次请求后续还会带 token」

这句话把 **"带"** 当成了 **"验"**。两件事完全不同：

| 动作 | 谁做 | 保护谁 |
|---|---|---|
| **带** token | 发消息的一方 | 不保护任何人 |
| **验** token | 收消息的一方 | 才构成保护 |

而实际情况是：

1. token 是**被白送的**（洞 1）—— 对方不需要知道，连上就有
2. **验**只发生在"收到请求"时 —— 收到**响应**时根本不验（洞 3）
3. 而且验的那个连接，可能根本不是真编辑器（洞 2）

### 精确答案

> **攻击者需要的额外条件只有一个：能在本机跑一个进程。**
>
> 有了这个条件，他连上端口就白拿 token，然后能截走 DSH 的调用、伪造返回值。
> `127.0.0.1` 挡住的是"外面的世界"，挡不住"自己机器上的东西"。

---

## 3.H 三个修法（按优先级）

| # | 修什么 | 改哪里 | 代价 |
|---|---|---|---|
| 1 | hello 不带 token | `server.js:151` 改用裸 `write()`，不走 `link.notify()` | 5 行 |
| 2 | 响应也验 token | `protocol.js` 的 `respond`/`respondError` 附加 token + `isResponse` 分支过 `authorize` | 15 行 + 改若干测试 |
| 3 | "谁是编辑器"由身份决定 | `server.js` 不再在连接建立时 `links.add`，改为收到带正确 token 的 `bridge.hello` 后才登记 | 30 行 + 改服务器/应用层测试 |

三条都是**行为变更**，不是纯内部重构 —— 尤其第 2、3 条会改变协议语义（响应开始带 token、连接不再等于"已登记对端"）。按工作区约定，这类改动先报告、确认后再动。

---

# 第 4 课：DSH 的插件系统 —— 为什么是"登记表 + 生命周期"，而不是直接 import 一个函数

> 本课关于 cordis 行为的结论，都在下面贴了原样输出。探针脚本是临时写的
> （`/tmp/probe-check.mjs`、`/tmp/probe-check2.mjs`、`/tmp/probe-effect2.mjs`），**没有入库**
> —— 它们要读的 cordis 源码在 DSH 发行包的 `app.asar` 里面，普通 `node` 读不到，
> 得先解包才能跑（见 4.5 的说明）。项目自己的验收命令随时可跑，见第 5、6 课。

## 4.1 问题先行：直接 import 别人的函数，会出什么事？

第 1 课说过：DSH 想让 VS Code 打开一个文件，不能自己调，得找中间人。
中间人写好了，最省事的用法看起来是这样：

```js
// 想象中：DSH 插件直接 import 中间人的函数
import { openFile } from 'dsh-vscode-kit'
await openFile({ path: 'package.json' })
```

本项目**没有**这么做。它的用法长这样（`packages/dsh-kit-demo/src/index.js:18`）：

```js
export const inject = ['dshVscodeKit']
```

用的时候（`packages/dsh-kit-demo/src/index.js:26`）：

```js
const kit = ctx.get('dshVscodeKit')
```

只多了一句声明、一个 `ctx.get`。为什么值得绕这一下？因为直接 `import` 有四个绕不过去的坑：

| # | 问题 | 具体会怎么坏 |
|---|---|---|
| 1 | **加载顺序没人管** | A 插件用 B 插件的功能，谁先加载全靠运气；`import` 只能拿到"模块被加载那一刻"的值 |
| 2 | **能力是会上下线的** | 编辑器没开、桥没连上、扩展被用户禁用 —— 功能这一刻在、下一刻不在。`import` 拿到的是**死值**，不会跟着变 |
| 3 | **宿主看不见依赖图** | 谁依赖谁是一句 `import`，宿主无从得知，卸载 / 热重载时没法按正确顺序处理 |
| 4 | **实现被写死了** | 测试时想换成假实现？`import` 走的路径是硬编码的 |

四条合起来是一句话：**`import` 把"依赖"写成了代码，而代码是宿主看不见、也改不动的。**

插件系统要做的，就是把这层关系从"代码"里挖出来，变成宿主能读的**数据**。

## 4.2 最小模型：插件 = 三样东西

本项目的插件长这样（`packages/dsh-vscode-kit/src/index.js:18`、`:26`、`:196`）：

```js
export const name = 'dsh-vscode-kit'      // ① 我叫什么
export const inject = []                  // ② 我需要谁（这里：谁都不需要）
export function apply(ctx, config = {}) { // ③ 我被叫起来时干什么
```

就这三样。没有基类、没有装饰器、没有 `import cordis`。

> **打比方**：插件系统像单位门口的**登记簿**。
> 你进门先写三行：我叫什么（`name`）、我必须等谁到场才开工（`inject`）、我开工干什么（`apply`）。
> 前台（宿主）拿这本簿子就能算出**谁该先上班**，而不是让每个员工自己去别人工位上抓人（直接 `import`）。

`inject` 是空数组这件事本身有信息量 —— 原文注释在 `packages/dsh-vscode-kit/src/index.js:26` 附近：

> `export const inject = []` 空数组是**刻意**的：本插件不依赖任何 DSH 内部服务，
> 这样就不会因为"某个内部服务缺失"被连带卸载掉。

换句话说：**依赖越少，越不容易被别人拖死。** 这条规律在第 6 课会变成整个项目的设计铁律。

### 三个原语的分工（本课地图）

| 原语 | 一句话 | 打比方 | 本项目位置 |
|---|---|---|---|
| `ctx.provide(name, value)` | 把能力挂到公共柜子上 | 东西放进柜子、贴上标签 | `packages/dsh-vscode-kit/src/index.js:300` |
| `inject: [...]` | 声明"没有这个我不开工" | 门上贴"没工牌不开门" | `packages/dsh-vscode-kit/src/index.js:26` |
| `ctx.effect(fn)` | 登记"我走的时候要收拾什么" | 领用登记表 | `packages/dsh-vscode-kit/src/index.js:396-397` |

## 4.3 原语一：`ctx.provide` —— 重点在"提供的东西长什么样"

调用只有一行（`packages/dsh-vscode-kit/src/index.js:300`）：

```js
ctx.provide('dshVscodeKit', facade)
```

真正值得学的是 `facade` **为什么长这样**。先看形状（`packages/dsh-vscode-kit/src/index.js:245-258`）：

```js
const vscode = {
  openFile: (params, opts) => (kit
    ? kit.vscode.openFile(params, opts)
    : notReady('vscode.openFile')),
  getSelection: (params, opts) => (kit ? ... : notReady('vscode.getSelection')),
  getDiagnostics: (params, opts) => (kit ? ... : notReady('vscode.getDiagnostics')),
  listOpenEditors: (params, opts) => (kit ? ... : notReady('vscode.listOpenEditors')),
}
```

（上面 `...` 是本文为省地方做的缩写，真实文件里是完整转发。）

注意两件事：

1. **四个方法名"固定存在"**，不管桥连没连上。没连上时它们返回一个被拒绝的 Promise，而不是 `undefined`。
2. **每个方法都是转发**（`(params, opts) => kit ? ... : ...`），不是把底层 `kit.vscode` 直接交出去。

为什么不直接把底层的交出去？源码注释留着答案（`packages/dsh-vscode-kit/src/index.js:236-241`）：

> ★ 早期写成 `get vscode() { return kit?.vscode ?? {} }`，真机上出过两类问题：
> ① 监听没起来时消费者拿到 `{}`，调用得 `kit.vscode.openFile is not a function`
> （裸 TypeError，没有错误码、没有原因，最糟的失败形态）；
> ② 消费者把方法**解构**出去后（`const { bind } = kit.vscode`），就算监听后来就绪，
> 解构出来的已经是 `undefined`，永远好不了。
> 所以糖衣方法必须是**稳定存在**的转发函数，只在调用时检查就绪状态。

这是 `AGENTS.md` 的**铁律 2**：服务返回的东西必须稳定存在，不许在未就绪时返回 `{}` 或 `null`。

> 判断标准：**"暂时不能用"要表现为一个带错误码的拒绝，而不是 `undefined`。**
> 前者调用方看得懂、能降级；后者是一颗裸 TypeError，还会被"解构"放大成永久故障。

"没连上"这个错误长这样（`packages/dsh-vscode-kit/src/index.js:242`）：

```js
const notReady = (method) => Promise.reject(new BridgeError(ERR.DISCONNECTED,
  'dsh-vscode-kit is not listening yet', { method, reason: 'server-not-ready' }))
```

其中 `ERR.DISCONNECTED` 是 `-32007`，定义在 `packages/dsh-vscode-kit/src/protocol.js:26`。

## 4.4 原语二：`inject` —— 依赖是数据，不是 import

消费者一侧（`packages/dsh-kit-demo/src/index.js:18`）：

```js
export const inject = ['dshVscodeKit']
```

旁边注释（`packages/dsh-kit-demo/src/index.js:16`）写得很清楚：

> 注意这是**字符串数组**，纯声明，不需要 import cordis。

一个字符串，指向前一间屋子 `ctx.provide('dshVscodeKit', ...)` 里的名字。就靠**名字**对上号，
两边没有任何代码互相 import。这是第 6 课"零耦合"的地基。

宿主规则简单说：**`inject` 里列的服务全部到位，才调你的 `apply`。** 服务没到位就等着。

"等着"这两个字，正是下一节那口坑的来源。

## 4.5 本项目最贵的坑：`check` 谓词不是"就绪通知"

### 当时的想法（听起来完全合理）

`ctx.provide` 有第三个参数。既然桥要过一会儿才连上，那就告诉宿主
"我这个能力是**有条件**的，条件没满足时别给消费者"：

```js
// ❌ 真机上把消费者永久卡死的写法
ctx.provide('dshVscodeKit', facade, () => kit !== null)
```

意图是："`kit` 没就绪时消费者先别启动；等它就绪了，谓词变真，消费者自然就起来了。"

**这个"自然就起来了"不存在。** 这是本项目代价最大的一次误判。

### 真实机制

cordis（本项目用的插件框架，版本 4.0.5）里，`check` 只在**有人来取（get）这个东西的时候**被求值；
求值为假，它做的事是**把这个值从仓库里删掉**：

```js
// cordis 的 lib/index.js:1306-1315（_checkImpl 的原文逻辑）
if (!impl) return delete this._store[name]
try {
  if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value)))
    return delete this._store[name]
} catch (error) { ... return delete this._store[name] }
```

（同一段源码，`docs/phase7-经验手册.md` §3.3 也引过，路径行号一致。本课的引用是我解包
DSH 发行包里的 cordis 后逐行核对过的。）

关键词是 **delete**：不是"暂缓发放"，是"当它不存在"。

### 我自己跑出来的三条对照

最小探针只做三件事：注册一个带 `check` 的服务、让一个消费者 `inject` 它、看消费者有没有被叫起来。
三个场景原样输出：

```
[A-no-check] provided
[A-no-check] consumer active; svc = world
[A-no-check] => consumerRan=true

[B-check-false-then-true] provided
[B-check-false-then-true] => consumerRan=false

[C-check-true] provided
[C-check-true] consumer active; svc = world-true
[C-check-true] => consumerRan=true
```

| 场景 | check | 消费者起来了没 |
|---|---|---|
| A | 不传 check | ✅ 起来了 |
| B | 一开始 `false`，之后变 `true` | ❌ **永远没起来** |
| C | 恒为 `true` | ✅ 起来了 |

B 这一格就是那个坑：谓词后来确实变真了，消费者**没有**被叫醒。

把时间轴放大，看 B 到底怎么卡住的：

```
[provider] provided（check = () => ready，此刻 ready = false）
① ready=false 时 consumer 激活了吗？ false
② ready=false 时 root.get 拿得到吗？ { hello: [Function: hello] }
③ 把 ready 改成 true 了 —— 现在等 300ms 看消费者会不会自己醒……
④ consumer 激活了吗？ false ← false 就是永久 pending（没有任何机制重发通知）
⑤ 但下一次 get / 或插件重新加载，谓词会被重新求值。root.get 现在： 拿得到值
```

把 ① 和 ⑤ 并排读一遍，这是全课最重要的一处对比：

- **⑤ 说：后来 `get` 拿得到值。**（谓词重新求值，通过了）
- **①④ 说：早就等在门口的那个消费者，永远不会醒。**

结论不是"值坏了"，而是：**`check` 是门禁，不是门铃。**

> **打比方**：`check` 像闸机上的刷卡验证 —— 每次有人要进，它当场验一下卡；
> 验不过，就把这个人**从名册上划掉**。但它**没有**"条件变好了就敲门通知排队的人"这个功能。
> 你指望它当门铃，等的人就永远站在门外。

### 真机上的样子

`docs/phase7-经验手册.md` §3.3 记录了当时的原始输出：

```
dsh: warning: 1 entry did not activate
dsh-kit-demo-realtest (dsh-kit-demo): pending (waiting for services: unknown)
```

`waiting for services: unknown` —— 连"在等哪个服务"都说不出来。这就是谓词为假、值被删掉之后
等待者眼里的世界：这个服务根本不存在。

> 诚实说明：这两行 warning 来自 DSH 的 loader，不在 cordis 里（我 grep 过 cordis 的
> `lib/index.js`，`did not activate` / `waiting for services` 零命中）。所以我能给的证据是
> **手册里的历史记录 + 我自己复现的"永久 pending"机制**，而不是我当场又看到了这两行 warning。

### 修法（现在是铁律 1）

两句话：

1. **`ctx.provide` 不传 `check`** —— 注释在 `packages/dsh-vscode-kit/src/index.js:291-299`，
   实际调用在 `:300`。
2. **需要等的人自己等** —— 用 `facade.waitReady(ms)`（`packages/dsh-vscode-kit/src/index.js:277-286`）：

```js
waitReady: async (timeoutMs = 5000) => {
  if (kit !== null) return true
  if (!(timeoutMs > 0)) return false
  ...
  const ok = await Promise.race([readySignal, timeout])
  clearTimeout(timer)
  return ok
},
```

它的三个设计细节都是被坑教出来的：

| 细节 | 为什么 |
|---|---|
| 返回 `boolean`，**不抛** | 调用方自己决定怎么降级（"等不到就明说等不到"） |
| 有超时 | 永远等不到的东西不该让调用方挂死 |
| 一旦就绪，后续调用**立即**返回 `true` | 底层是一次性 Promise（`packages/dsh-vscode-kit/src/index.js:231`），已结算就不再等 |

配套的 `ready` 是普通 getter（`packages/dsh-vscode-kit/src/index.js:261`）：
`get ready() { return kit !== null }` —— 状态如实报告，不兼职"门禁"。

> 判断标准：**你要的到底是"别让他拿到"，还是"让他知道什么时候能拿到"？**
> 前者是 `check`（会永久卡住消费者），后者是 `waitReady`（有超时、有布尔结果）。
> 本项目选后者，并写进了 `AGENTS.md` 铁律 1。

## 4.6 原语三：`ctx.effect` —— 登记"我走的时候要收拾什么"

本项目怎么用（`packages/dsh-vscode-kit/src/index.js:396-397`）：

```js
if (typeof ctx.effect === 'function') {
  ctx.effect(() => () => {
    disposed = true
    settleReady(false)
    for (const waiter of [...(kit?.waiters ?? [])]) waiter(null)
    ...
  })
}
```

**是两个箭头，别数成三个。** 外面那层 `() => ...` 是"现在就执行的登记动作"，
它返回的里面那层 `() => {...}` 才是"将来卸载时执行的清理动作"。

### cordis 的契约原文

```js
// cordis 的 lib/index.js:1142-1143
const effect = runner.execute.call(this);
if (typeof effect === "function") return runner.collect(effect);
```

翻译：**先调用你传的函数；如果它返回了一个函数，就把这个返回值收集起来当 disposer。**

```
ctx.effect(fn)  →  立刻执行 fn()，把 fn 的返回值当"卸载时要调用的清理函数"
```

| 你写的 | 发生什么 |
|---|---|
| `ctx.effect(() => { setup(); return () => cleanup() })` | ✅ 注册时跑 `setup`，卸载时跑 `cleanup` |
| `ctx.effect(() => () => cleanup())` | ✅ 同上（只有清理，没有 setup） |
| `ctx.effect(() => cleanup)` | ⚠️ 注册时什么都不做，**卸载时才第一次调用** `cleanup`（见下） |

### 实测

一个插件用正确写法，一个用"把 `fn` 当 disposer"的写法，然后卸载两个插件。原样输出：

```
[正确写法] fn 立刻执行（注册时就跑了）
[错误写法] 注册完，等一下看有没有东西被当场打印
--- 现在卸载两个插件 ---
[正确写法] disposer 被调用（卸载时）
[错误写法] 有人调用了这个函数
--- 结束 ---
```

第二行到第三行之间**没有任何输出** —— 错误写法在注册时真的什么都没干。
它的"清理函数"只在卸载时才第一次被调用，而那时它要"清理"的东西从来没被建立过。

### 这条写错一次，代价是一整轮排查

`docs/phase7-经验手册.md` §2.3 与 §9.3 记了同一件事：写测试用的假 `ctx` 时，
把 `fn` 本身当成 disposer 收集了。于是：

- 卸载后资源没释放（真正的清理函数从没被登记）
- `await stopped` **永久挂起**（没人 resolve）

两条加起来，症状看起来和"产品有 bug"一模一样。这类**假 bug 比真 bug 更贵**：
真 bug 至少是真问题，假 bug 会让你去改没坏的代码。手册的结论是「白查两轮」。

> 判断标准：**`effect(fn)` 的意思是"现在做，并把做完后要回收的东西交给我"，
> 不是"以后再做"。** 返回值才是契约的另一半。

## 4.7 本课要带走的几句话

> 1. **插件不是"被 import 的函数库"，而是"登记表 + 开工函数"**：`name` / `inject` / `apply`。
> 2. **依赖要写成数据**（`inject: ['dshVscodeKit']`）而不是写成 `import` ——
>    宿主才排得出启动顺序，卸载时也才拆得干净。
> 3. **`provide` 出去的对象必须"永远有那几个方法"**：未就绪时返回带错误码的拒绝，
>    不许返回 `{}` 或 `null`（铁律 2）。
> 4. **`check` 是门禁，不是门铃** —— 不传它；要等就自己 `waitReady(ms)`（铁律 1）。
> 5. **`effect(fn)` 里 `fn` 立刻执行，`fn` 的返回值才是 disposer**。

## 第 4 课练习题

> **问 1：如果把 `ctx.provide('dshVscodeKit', facade)` 改成
> `ctx.provide('dshVscodeKit', facade, () => kit !== null)`，会发生什么？
> 为什么"谓词后来变真了，等在门口的消费者还是醒不过来"？**

提示：想两件事 —— ① `check` 是在**什么时候**被求值的？② 值被"删掉"之后，
**谁负责**通知那些已经在等的人？

> **问 2：`ctx.effect(() => () => console.log('bye'))` 里，`console.log('bye')` 什么时候打印？
> 如果写成 `ctx.effect(() => console.log('bye'))`，又是什么时候打印？**

提示：数一下箭头函数的层数；再想一句话 —— "返回值"在这里扮演什么角色。

---

# 第 5 课：VS Code 扩展模型 —— 一个只能活在别人进程里的程序

> 本课的代码引用全部来自 `packages/dsh-kit-bridge/`；两处命令实测（`npm view vscode`、
> `node -e "require.resolve('vscode')"`）与端到端测试的输出，都原样贴在下面。

## 5.1 问题先行：DSH 为什么不能自己调 VS Code 的 API？

第 1 课的老问题，这一课要把它钉死。

"当前选区里的文字""打开了哪几个文件""这个文件有没有报错" —— 这三样东西**只存在于 VS Code 里**。
DSH 是另一个进程（跑在 Node 里），它没有编辑器、没有文档模型，它连"哪个文件被选中了"这个问题都无从回答。

所以必然有一侧要**去问** VS Code。问题只剩一个：**问的方式是什么？**

最省事的方式当然是：

```js
import * as vscode from 'vscode'
const sel = vscode.window.activeTextEditor.selection
```

本项目里，这行代码确实存在（`packages/dsh-kit-bridge/src/extension.js:9`、`packages/dsh-kit-bridge/src/vscode-host.js:11`），
但它**只存在于扩展里**，绝不出现在 DSH 那一侧。原因不是风格洁癖，而是一个硬事实：

> **`vscode` 这个模块，在磁盘上不存在。** 它是 VS Code 在加载扩展时"塞"给扩展代码的。

下一节先把周边讲清，5.3 再上实测。

## 5.2 extension host 是什么，`activate` 什么时候被调用

### 三句话版本

1. VS Code 打开时，除了画界面那个进程，还会另外拉起一个**独立的 Node.js 进程**，
   专门跑所有扩展的代码。这个进程叫 **extension host**（扩展宿主）。
2. 扩展不是"一直活着"的：VS Code 认为某个扩展该干活了，才调用它的入口函数 `activate`。
3. 入口函数返回之后，扩展就回到"待命"状态 —— 它靠**注册的回调**（命令、事件）被再次唤醒。

> 诚实边界：上面这三条是 VS Code 扩展模型的公开设计（官方文档级别的常识），
> **本项目里没有可跑的命令能"验证进程数"**。本课能给你实测证据的是后面几节：
> 模块从哪来、入口函数怎么写、为什么必须打成 CJS 单文件。

### 本项目落在这套模型里的哪几处

| 模型里的概念 | 本项目的代码 | 说明 |
|---|---|---|
| 扩展清单 | `packages/dsh-kit-bridge/package.json:26` `"main": "./out/extension.cjs"` | 告诉 VS Code 入口文件在哪 |
| 最低版本 | `packages/dsh-kit-bridge/package.json:20-22` `"engines": { "vscode": "^1.91.0" }` | 低于这个版本不装 |
| 什么时候叫我 | `packages/dsh-kit-bridge/package.json:27-29` `"activationEvents": ["onStartupFinished"]` | VS Code 启动完成后叫我一次 |
| 入口 | `packages/dsh-kit-bridge/src/extension.js:132` `export function activate(context)` | 被叫起来时执行 |
| 关闭 | `packages/dsh-kit-bridge/src/extension.js:233` `export function deactivate()` | VS Code 要走时执行 |
| 收拾动作 | `packages/dsh-kit-bridge/src/extension.js:172-227` `context.subscriptions.push(...)` | 交出去的每样东西都会在停用时被 dispose |

`activate` 里做的事极少（`packages/dsh-kit-bridge/src/extension.js:133-159`）：

```js
const output = vscode.window.createOutputChannel('DSH Kit Bridge')
const cfg = readConfig()
if (!cfg.enabled) return { disabled: true }
const { dispatch, capabilities } = createDispatcher(output)
const connector = createConnector({ dispatch, log, ... })
connector.start()
```

建日志通道 → 读配置 → 建能力分派 → 起连接器 → 把要收拾的东西登记进 `context.subscriptions`。
**没有一句 `await` 卡在这里**，也没有"等连接成功再返回"。连接是后台轮询的
（`packages/dsh-kit-bridge/src/connector.js:196-202`，`setTimeout` 递归 —— 不是 `while` 死循环）。

### 为什么扩展代码不能随便"长跑阻塞"

扩展宿主是**一个共用的 Node 进程**，所有扩展都在里面。JS 是单线程的：
一段同步的 `while (true)` 或一次几十秒的同步计算，会把整个扩展宿主卡住 —— **包括别的扩展**。

这条规则在本项目里留下了自己的现场证据（`packages/dsh-kit-bridge/src/extension.js:210-226`）：

```js
// 配置变化：只有影响连接构建的键才需要重启扩展宿主。
// 曾经的写法是「任何 dshKit.* 变更都 reloadWindow」，那会在用户只是点开一个
// 检查框、或自检临时开关时把正在执行的命令连根拔掉（真机自检就是这么被杀的）。
const needsRestart = RESTART_KEYS.some((k) => e.affectsConfiguration(`dshKit.${k}`))
```

`RESTART_KEYS` 只有两个键（`packages/dsh-kit-bridge/src/extension.js:21`）：

```js
const RESTART_KEYS = ['dshHome', 'pollIntervalMs']
```

翻译成人话：改"连接怎么建立"才值得重启整个扩展宿主；改其它开关不该重启 ——
**因为"重启扩展宿主"这个动作会把正在跑的活儿一起掐死。** 真机上确实掐死过一次自检。

> 判断标准：**扩展宿主不是你一个人的进程。** 你在里面做的每个"等一下"，都是别人在陪等。

## 5.3 为什么 `vscode` 不能直接 import（实测）

### 实测一：在普通 node 里根本找不到这个模块

在项目根目录跑：

```
$ node -e "try{console.log(require.resolve('vscode'))}catch(e){console.log('require.resolve 失败：', e.code)}"
require.resolve 失败： MODULE_NOT_FOUND
```

`MODULE_NOT_FOUND` —— 不是"装了但版本不对"，是**磁盘上就没有这个东西**。

### 实测二：npm 上那个 `vscode` 是个空壳

```
$ npm view vscode version description
version = '1.1.37'
description = '## ⚠️ Deprecated, use @types/vscode and vscode-test instead ⚠️'
```

它停更在 `1.1.37`，官方描述直接写了 Deprecated（"请改用 `@types/vscode` 和 `vscode-test`"）。
而且它**没有 `main` 字段**（`npm view vscode main` 什么都不输出）——
也就是说：就算你 `npm i vscode`，`require('vscode')` 也找不到可加载的入口。

`@types/vscode` 是什么？是**类型声明**（给编辑器用的"说明书"），里面没有一行可执行代码。
所以"装个包不就有了"这条路是死的。

### 那 `import * as vscode from 'vscode'` 为什么能跑？

因为**扩展宿主在加载扩展前，把这个模块注入进去了**。扩展代码里 `require('vscode')` 拿到的
是一个由 VS Code 自己创建的、活的 API 对象 —— 里面挂着 `workspace`、`window`、`commands` 等等。

本项目把这件事写在了打包脚本的注释里（`packages/dsh-kit-bridge/scripts/build.mjs:29-30`）：

```js
// vscode 由扩展宿主注入，绝不能打包
external: ['vscode'],
```

`external` 的意思是"这个 import 原样留着，别试图解析它"。如果真去解析，构建会失败 —— 因为磁盘上没有。

### 这条事实推出的两个结论（全项目最重要的一步推理）

| 结论 | 为什么 |
|---|---|
| **能力实现必须放在扩展里** | 只有扩展宿主里能拿到 `vscode` 这个对象，别的地方拿不到 |
| **DSH 侧只能"发消息"** | DSH 拿不到 `vscode`，它能做的只有：把"我要打开这个文件"写成一个请求，送过去 |

这就是整座"桥"存在的根本原因 —— 回看第 1 课，那条链子的起点在这里。

同一个事实还解释了另外两件事：

1. **为什么自检非得跑在真机上**（`packages/dsh-kit-bridge/src/extension.js:34-39` 的注释）：

   > 单测用的是假 host，E2E 用的是假 host，两者都证明不了 `vscode-host.js` 里那几行真实 API
   > 调用是对的（`showTextDocument` 的参数、`env.openExternal` 的返回值、`activeTextEditor` 的形状）。

2. **为什么自检结果要写到文件**（`packages/dsh-kit-bridge/src/extension.js:121-128`）：
   写到 `~/.dsh/dsh-vscode-kit/selftest-<pid>.json`。人在 VS Code 里跑一遍，DSH 侧再去读文件 ——
   因为**两个进程没有别的共同语言**。

## 5.4 怎么让"只能活在扩展里的能力"变得可单测

这是本项目最漂亮的一处设计。一句话：**把"vscode 长什么样"这个知识，关进一个文件。**

### 只有 `vscode-host.js` 知道 vscode

`packages/dsh-kit-bridge/src/vscode-host.js:1-6`：

```js
/**
 * VS Code 宿主适配器：把 vscode API 包成 capabilities/connector 需要的形状。
 *
 * 隔离目的很实在：能力实现与连接管理都不 import 'vscode'，因此能在 node:test 里
 * 用假 host 跑真 TCP 端到端。**只有这个文件**知道 vscode 长什么样。
 */
```

它做的事：把一堆 `vscode.*` 调用包成普通函数，凑成一个**普通对象**返回
（`packages/dsh-kit-bridge/src/vscode-host.js:128-139`）：

```js
return {
  fileExists: (p) => { ... },
  resolvePath,
  workspaceRoots,
  isTrusted: () => vscode.workspace.isTrusted,
  openTextDocument,
  openExternalFile,
  activeEditor,
  collectDiagnostics,
  listEditors,
  log,
}
```

这个对象的形状（谁调用、参数、返回值）就是**接口**。有了接口，就能有两份实现：
真的那份用 `vscode`，假的那份用手写数据。

### 能力层：`capabilities.js` 一行 `vscode` 都没有

`packages/dsh-kit-bridge/src/capabilities.js:1-12` 的头注释：

```
 * 设计要点：
 *  - **不直接 import 'vscode'**，全部经 `host` 注入 —— 这样能在 node:test 里单测，
 *    不必起 Electron / 扩展宿主。
 *  - 每个能力先做三项前置检查（信任 / 可用性 / 参数），再做实际动作。
 *  - 失败一律抛 BridgeError 带稳定错误码，让 DSH 侧拿到结构化原因而不是字符串。
 *  - 坐标约定：协议对外一律 **1-based**
```

它唯一的 import 是协议库（`packages/dsh-kit-bridge/src/capabilities.js:14`）：

```js
import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
```

能力清单（`packages/dsh-kit-bridge/src/capabilities.js:17-22`）：

```js
export const CAPABILITIES = [
  'vscode.openFile',
  'vscode.getSelection',
  'vscode.getDiagnostics',
  'vscode.listOpenEditors',
]
```

创建方式（`packages/dsh-kit-bridge/src/capabilities.js:68`）：

```js
export function createCapabilities(host) {
```

`host` 就是 5.4 开头那个普通对象。**依赖从外面递进来**，不自己去拿。

### "三项前置检查"长什么样

以 `openFile` 为例（`packages/dsh-kit-bridge/src/capabilities.js:84-112`，摘关键几行）：

```js
async function openFile(params) {
  assertTrusted('vscode.openFile')                       // ① 信任检查
  const raw = params?.path
  if (typeof raw !== 'string' || raw.trim() === '') {     // ② 参数检查
    throw new BridgeError(ERR.INVALID_PARAMS, 'params.path must be a non-empty string', ...)
  }
  const abs = host.resolvePath(raw)
  if (!host.fileExists(abs)) {                            // ③ 可用性检查
    throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, ...)
  }
  ...
}
```

三种失败，三个稳定错误码：

| 检查 | 失败时 | 错误码 |
|---|---|---|
| 工作区没被信任 | `untrusted-workspace` | `-32006`（`packages/dsh-vscode-kit/src/protocol.js:25`） |
| 参数不合法 | `invalid-params` | `-32602`（`packages/dsh-vscode-kit/src/protocol.js:17`） |
| 文件不存在 | `not-found` | `-32003`（`packages/dsh-vscode-kit/src/protocol.js:22`） |

还没实现的方法呢？分派器给的是 `-32005`，**不是**标准 JSON-RPC 的 `-32601`
（`packages/dsh-kit-bridge/src/capabilities.js:229-235`）：

```js
async function dispatch(method, params) {
  const handler = handlers[method]
  if (!handler) {
    throw new BridgeError(ERR.UNSUPPORTED, `capability not implemented: ${method}`, { method })
  }
  return handler(params)
}
```

注释解释了为什么：**让 DSH 侧能区分"对端不支持这个能力"（可以降级）和"你方法名写错了"（是 bug）。**
第 6 课末尾会看到这条设计的实际效果。

### 一项"看着无所谓、其实救了命"的细节

`packages/dsh-kit-bridge/src/capabilities.js:48-51`：

```js
function canonicalPath(p) {
  if (typeof p !== 'string') return p
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p
}
```

就是把 Windows 盘符统一成大写。为什么值得单独写个函数？看它的注释（`packages/dsh-kit-bridge/src/capabilities.js:42-46`）：

> 真机自检抓到的坑：同一个文件，`vscode.openFile` 回传的是调用方传入的 `C:\Users\...`，
> 而 `vscode.getSelection` / `listOpenEditors` 回传的是 VSCode URI 的 `fsPath`，在 Windows 上
> 盘符被小写化成 `c:\Users\...`。消费者若按字符串比较（`list.some(e => e.file === p)`）会静默失败。

这个坑是**假 host 永远测不出来**的 —— 假 host 里路径是你自己写的字符串，当然一致。
又一次印证 5.3 的结论。

## 5.5 `connector.js`：把"发现 / 连接 / 握手 / 重连"和 vscode 隔开

扩展里第二个有分量的文件。它负责第 3 课讲的那套找对方的过程，但**它也不 import vscode**
（`packages/dsh-kit-bridge/src/connector.js:1-11`）：

```
 * 刻意**不碰 vscode**：所有宿主能力经 `deps` 注入，因此可以用真 TCP + 假宿主跑单测。
 * 这一层是「薄扩展」里唯一有状态的部件，其余文件都是纯函数。
 *
 * 状态机：
 *   idle → connecting → ready → (断开) → idle → ……
 *             ↓ 失败
 *          idle（等下一次轮询）
```

它用的依赖（`packages/dsh-kit-bridge/src/connector.js:13-19`）：

```js
import { createConnection } from 'node:net'
import { BridgeError, ERR, PROTOCOL_VERSION, connect, createLineSplitter }
  from '../../dsh-vscode-kit/src/protocol.js'
import { discoveryDir, listLiveBridges } from '../../dsh-vscode-kit/src/discovery.js'
import { CAPABILITIES } from './capabilities.js'
```

全是 Node 内置模块 + 协议库 + 能力清单。**没有任何 `vscode`。**

### 四个阶段，各自在哪几行

| 阶段 | 代码 | 一句话 |
|---|---|---|
| 轮询 | `packages/dsh-kit-bridge/src/connector.js:196-202` | `setTimeout` 递归，间隔 `pollIntervalMs`（默认 2000，见 `packages/dsh-kit-bridge/src/connector.js:41`） |
| 找目标 | `packages/dsh-kit-bridge/src/connector.js:176-194` | `listLiveBridges(dir)`，取 `bridges[0]`（**多实例仲裁：连 `startedAt` 最新的那个**，注释在 `:182`） |
| 连接 | `packages/dsh-kit-bridge/src/connector.js:102-129` | `createConnection` + 超时（`connectTimeoutMs` 默认 3000），超时回 `ERR.TIMEOUT`、失败回 `ERR.DISCONNECTED` |
| 握手 | `packages/dsh-kit-bridge/src/connector.js:132-173` | 建协议终端 → 主动发 `bridge.hello` 报自己的能力清单 |

握手那一段有个安全细节值得单看（`packages/dsh-kit-bridge/src/connector.js:140-144`）：

```js
// 入站鉴权：DSH 侧发的消息必须带同一个 token（对端被冒名时我们能发现）。
// 例外是 bridge.hello：它是 DSH 侧连上后主动打的招呼，发生在双方互相确认之前，
// 按协议**不允许携带 token**（曾经携带过，等于把通行证寄给任何连上端口的人）。
authorize: (incoming, method) => method === 'bridge.hello' || incoming === info.token,
```

和第 3 课答疑里那三个洞是同一条线的：**"连接建立"不等于"已鉴定身份"**。

### 一个"顺序写错、功能全废"的坑

`packages/dsh-kit-bridge/src/connector.js:90-99`：

```js
function handleInbound(method, params, ctx) {
  const fn = inbound[method]
  if (fn) return fn(params)
  if (onRequest) {
    const custom = onRequest(method, params, ctx)
    if (custom !== undefined) return custom
  }
  // 未实现的能力由 capabilities.dispatch 回 -32005（可与「协议层方法不存在」区分）。
  return dispatch(method, params)
}
```

注释（`packages/dsh-kit-bridge/src/connector.js:86-88`）说了代价：

> 顺序很重要：先认协议层方法（ping/hello），**其余一律交给能力分派**。
> 早期版本忘了最后这一步 fallthrough，结果 vscode.* 全被当成未知方法回 -32601 ——
> 端到端测试当场抓到。

这就是第 2 课"错误码要说清是哪一层的事"的实际价值：`-32601`（方法不存在）和
`-32005`（对端不支持）看起来都是"失败了"，含义完全不同。

### 停止时要"两层都关"

`packages/dsh-kit-bridge/src/connector.js:221-232`：

```js
stop() {
  stopped = true
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  if (link) link.close('connector stopped')
  if (socket) {
    // 与 DSH 侧同一个教训：协议层 close ≠ 传输层 close。
    try { socket.destroy() } catch { /* ignore */ }
  }
```

`link.close()` 只是"我这个协议终端不玩了"，socket 还开着。必须再 `socket.destroy()`
才能真正断开 —— 否则对方（DSH）那边会以为连接还在，`server.close()` 会挂住（`AGENTS.md` 铁律 5）。

## 5.6 为什么最后打成一个 CJS 单文件

`packages/dsh-kit-bridge/package.json:26` 指向 `./out/extension.cjs` —— 一个构建产物，
不是源码。构建脚本只有 37 行（`packages/dsh-kit-bridge/scripts/build.mjs`），
理由是两条（`packages/dsh-kit-bridge/scripts/build.mjs:4-9`）：

> **为什么是 CJS**：VS Code 扩展宿主对 ESM 扩展的支持要 1.94+ 且仍有边界情况；
> CJS 是 1.91 起就没问题的稳妥选择。源码本身仍写 ESM，打包转换即可。
>
> **为什么 bundle 而不是 tsc**：kit 的 protocol.js/discovery.js 是跨包相对 import，
> 不打包的话 vsix 里就得塞 node_modules 或 ../dsh-vscode-kit，两个都不干净。
> 打包后 vsix 只有一个 extension.cjs，零安装依赖。

也就是说：

| 麻烦 | 不打包的后果 | 打包后 |
|---|---|---|
| `import { connect } from '../../dsh-vscode-kit/src/protocol.js'` | vsix 里得带上 `../dsh-vscode-kit` 这个**兄弟目录**（安装到用户机器上根本不存在） | 代码被"复印"进 `extension.cjs` |
| 依赖别的 npm 包 | vsix 里要塞 `node_modules`（几十 MB、版本漂移） | 零安装依赖 |

"零安装依赖"到什么程度？看 `packages/dsh-kit-bridge/package.json:80-82`：

```json
"devDependencies": {
  "esbuild": "^0.28.2"
}
```

`esbuild` 是**构建时**用的（`devDependencies`），装出来的扩展里没有运行时依赖。

### 那 `@deepseek-ai/*` 呢？

协议库**规定不许 import** 它们（`packages/dsh-vscode-kit/src/protocol.js:5`）：

> 零依赖：只用 Node 内置模块，绝 import @deepseek-ai/*（ERR_MODULE_NOT_FOUND 前科）。

原因：那些是 DSH 宿主内部的包，扩展这个包里根本没有它们；一旦 import，
打包时解析不到（`ERR_MODULE_NOT_FOUND`），或者更糟 —— 硬塞进去，然后在用户机器上版本对不上。
这条规则的完整道理放到第 6 课讲。

### 一处实测：打包出来的东西能不能真的跨进程干活

`packages/dsh-kit-bridge` 有个端到端脚本 `scripts/e2e.mjs`：**真 TCP + 假宿主**，
把两个进程（DSH 侧协议库 ↔ 扩展侧 connector/capabilities）真连起来跑一轮。跑一遍：

```
$ cd packages/dsh-kit-bridge && node scripts/e2e.mjs
PASS vscode.openFile 跨进程成功 — {"opened":true,"path":"/ws/e2e/target.txt","mode":"text"}
PASS 编辑器侧真的执行了打开动作
PASS vscode.getSelection 跨进程成功 — {"text":"selected-text","file":"/ws/e2e.js","start":{"line":5,"column":1},"end":{"line":5,"column":14},"isEmpty":false}
PASS 选区坐标 1-based — {"line":5,"column":1}
PASS vscode.getDiagnostics 跨进程成功 — {"total":1,"files":[{"file":"/ws/e2e.js","diagnostics":[{"severity":"error","line":2,"column":4,"message":"e2e-err","source":"e2e"}]}],"truncated":false}
PASS vscode.listOpenEditors 跨进程成功 — {"editors":[{"file":"/ws/e2e.js","isActive":true,"isDirty":false,"languageId":"javascript"},{"file":"/ws/other.js","isActive":false,"isDirty":true}],"total":2,"truncated":false}
PASS 未实现能力回 -32005 — {"code":-32005,"message":"editor does not advertise capability for \"vscode.diff\""}
PASS DSH 重启后编辑器自动重连

=== 13/13 passed ===
```

（上面是节选，原输出 13 条全绿。）注意最后两条：一条证明"未实现能力回 `-32005`"这个设计真的生效，
一条证明**DSH 重启后扩展会自己连回来** —— 也就是 5.5 里那个 `idle → connecting → ready` 状态机在工作。

再看它的单测（同一套代码，`node --test`）：

```
$ cd packages/dsh-kit-bridge && node --test "test/*.test.js"
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

23 条测试**全是假宿主**，一条都没起 VS Code。这就是 5.4 那套"host 注入"直接换来的东西。

## 5.7 本课要带走的几句话

> 1. **扩展跑在 extension host 里，是"被叫醒"的**（`activate`），不是常驻服务；
>    它是共用的单线程进程，别在里面长跑阻塞。
> 2. **`vscode` 不是 npm 包，是扩展宿主注入的模块**。磁盘上没有（`MODULE_NOT_FOUND`），
>    npm 上那个 `vscode` 是停更的空壳（无 `main`）。
> 3. **因为上一条，能力实现只能在扩展里，DSH 侧只能发消息** —— 这就是桥的存在理由。
> 4. **把"宿主长什么样"关进一个文件**（`vscode-host.js`），其余代码靠注入拿能力，
>    于是 23 条单测能用假宿主跑，13 条 E2E 能跑真 TCP。
> 5. **打包成单个 CJS bundle、`external: ['vscode']`、零运行时依赖** —— 装出来的扩展
>    不需要用户 `npm install` 任何东西。

## 第 5 课练习题

> **问 1：为什么 `import * as vscode from 'vscode'` 在扩展里能跑，而你在 node 里跑就报
> `MODULE_NOT_FOUND`？这个模块到底是谁提供的？**

提示：想两件事 —— ① `npm view vscode` 出来的那个包，跟"你电脑上的 VS Code 本体"是不是同一个东西；
② 如果它是"被注入的"，那么注入的人是谁、在什么时候注入。

> **问 2：`capabilities.js` 为什么不 `import 'vscode'`，而是等 `host` 传进来？
> 如果不这么做，本项目那些 `node --test` 单测会变成什么样？**

提示：想"假 host"三个字；再想为什么 5.6 的 E2E 能在**没有 VS Code 的终端里**跑通真 TCP。

---

# 第 6 课：分层与解耦 —— 这个项目的设计收口

> 本课有两处"自己动手"的实测：第 6.3 节的两条 `grep` 和三个包的测试都原样贴了输出。
> 这些命令你现在就能在自己的终端里跑。

## 6.1 问题先行：加一个功能，要动几个文件？

想象明天要给这个桥加一个新能力：`vscode.diff`（把两个文件并排对比）。

一个设计得好不好，有个非常朴素的检验方法：**数改动点。**

| 改动点数量 | 会带来什么 |
|---|---|
| 1–3 个文件，且都在同一层 | 加十个功能是十次小手术 |
| 每加一个功能都要碰协议解析、消息分帧、连接管理 | 加十个功能是十次大手术，第十次一定出事 |
| 加功能要同步改消费者 | **不认识你的第三方插件也得跟着改** —— 最贵 |

所以本课的问题就是一句话：**这个项目加一个能力，要碰几层？**

答案是：**一层，加两行测试。** 下面看这条路是怎么修出来的。

## 6.2 四段式链路：谁不知道谁

第 1、2、3 课分别讲了三段，第 5 课讲了扩展那一侧。拼起来是一条四段式链路：

```
① 消费者（任何 DSH 插件）        例：packages/dsh-kit-demo
      │  只用 ctx.get('dshVscodeKit') 拿到的方法
      ▼
② 协议库（DSH 侧，零依赖）        packages/dsh-vscode-kit
      │  消息：JSON-RPC over ndjson
      ▼
③ loopback TCP（127.0.0.1 + token）
      │
      ▼
④ 薄扩展（VS Code 侧）            packages/dsh-kit-bridge
      │  connector（连接）+ capabilities（能力）+ vscode-host（唯一懂 vscode 的）
      ▼
⑤ 官方 API：vscode.*
```

**这张表真正的内容是"谁不知道谁"：**

| 角色 | 不知道什么 | 证据 |
|---|---|---|
| 消费者（①） | 不知道 TCP、端口、发现文件、token 的存在；也不知道 `vscode` | `packages/dsh-kit-demo/src/index.js:5` 的注释 + 6.3 的 grep |
| 协议库（②） | 不知道 VS Code 的 API 长什么样；不 import 任何 `vscode` | `packages/dsh-kit-bridge/src/vscode-host.js` 是唯一 import 它的文件 |
| 扩展（④） | 不知道 DSH 内部服务；不 import `@deepseek-ai/*` | `packages/dsh-vscode-kit/src/protocol.js:5` |
| 双方共同知道的东西 | **只有消息的形状**（方法名、参数、错误码、分帧） | `packages/dsh-vscode-kit/src/protocol.js` |

注意最后一行的分量：**共享的只有"协议"这一份文本，不是对方的代码。**
这就是"解耦"的准确定义 —— 不是"没有关系"，是"只共享一份双方都同意的契约"。

> **打比方**：像打电话办业务。你（消费者）只知道总机号码和"我要办什么"（协议）；
> 你不知道对方在哪个楼、用什么系统、柜台怎么排（实现）。**你要动的事，永远只在"总机的接线规则"里。**

## 6.3 零耦合的证据（自己跑的 grep）

### 先跑任务书里那条"看起来该零命中"的命令

```
$ grep -rin "tcp\|port\|token\|discovery\|vscode\." packages/dsh-kit-demo/
packages/dsh-kit-demo/src/index.js:5: *  - 只 import 协议库的公开 API，**不知道** TCP / 端口 / 发现文件 / token 的存在；
packages/dsh-kit-demo/src/index.js:6: *  - 不改 DSH 核心，不 import cordis，不碰 VSCode；
packages/dsh-kit-demo/src/index.js:12:export const name = 'dsh-kit-demo'
packages/dsh-kit-demo/src/index.js:16: * 注意这是**字符串数组**，纯声明，不需要 import cordis（见打样日志 §1.1 实测）。
packages/dsh-kit-demo/src/index.js:18:export const inject = ['dshVscodeKit']
packages/dsh-kit-demo/src/index.js:24:export function apply(ctx, config = {}) {
packages/dsh-kit-demo/src/index.js:38:      const sel = await kit.vscode.getSelection()
packages/dsh-kit-demo/src/index.js:52:      const r = await kit.vscode.openFile({ path, ...position })
packages/dsh-kit-demo/src/index.js:94:      await step('vscode.openFile', () => openFile(config.smoke.path, { line: 2, column: 1 }))
packages/dsh-kit-demo/src/index.js:95:      await step('vscode.getSelection', () => readSelection())
packages/dsh-kit-demo/src/index.js:98:        const { writeFileSync, mkdirSync } = await import('node:fs')
packages/dsh-kit-demo/src/index.js:99:        const { dirname } = await import('node:path')
packages/dsh-kit-demo/test/index.test.js:4: * 这些测试**不启动真 TCP**，只验解耦度与降级行为 ——
```

**命中了一堆，不是零命中。** 这恰恰是这一课最值得学的地方 —— 逐条看它们是什么：

| 命中来源 | 实际是什么 | 算耦合吗 |
|---|---|---|
| `port` 命中的那些行（`:12`、`:16`、`:18`、`:24`、`:98`、`:99` …） | 全部是 `im`**`port`** 这个词里的三个字母 | ❌ 假命中 |
| `tcp` / `token` 各 1 行（`:5`） | 一句注释，说的是"**不知道** TCP / token 的存在" | ❌ 是"声明不知道" |
| `vscode.` 4 行（`:38`、`:52`、`:94`、`:95`） | `kit.vscode.openFile(...)` —— **服务对象上的一个属性**，不是 `import 'vscode'` | ❌ 公开 API |
| `test/index.test.js:4` | 注释："这些测试**不启动真 TCP**" | ❌ 是注释 |

### 再把 grep 收紧，只问"有没有真的碰基础设施"

```
$ grep -rinE "\b(tcp|port|token|discovery|selftest)\b|node:net|vscode\.workspace|vscode\.window|127\.0\.0\.1" packages/dsh-kit-demo/src/
packages/dsh-kit-demo/src/index.js:5: *  - 只 import 协议库的公开 API，**不知道** TCP / 端口 / 发现文件 / token 的存在；
```

只剩 1 行，而且这一行本身就是**在说"我不知道"**。`node:net`（TCP 的入口）、
`vscode.workspace` / `vscode.window`（真 VS Code API）—— **零命中**。

再看它到底 import 了什么：

```
$ grep -n "import" packages/dsh-kit-demo/src/index.js
98:        const { writeFileSync, mkdirSync } = await import('node:fs')
99:        const { dirname } = await import('node:path')
```

全文只有两处 import，都在一个默认关闭的 smoke 分支里，而且都是 Node 内置模块。
**没有 `import 'vscode'`、没有 `import '@deepseek-ai/cordis'`、也没有 import 协议库。**

> 判断标准：**"耦合"的不是"出现过某个词"，而是"你的代码里写死了对方的实现细节"。**
> 知道方法名（`vscode.openFile`）是契约；知道"消息从 127.0.0.1:7410 走、token 在哪个文件里"
> 才是耦合。前者换实现不用改，后者换实现就得改。

### 第二个证据：协议库自己没有依赖

`packages/dsh-vscode-kit/package.json` 里**没有 `dependencies` 字段**（这是重点），
只有 `peerDependencies`（`:22-29`）：

```json
"peerDependencies": {
  "@deepseek-ai/dsh": ">=0.2.1-0 <0.3.0"
},
"peerDependenciesMeta": {
  "@deepseek-ai/dsh": { "optional": true }
}
```

而且是 `optional` —— 意思是"宿主里通常有，但不强求"。所以安装这个库，**不会顺带拉进任何第三方包**。

它对外暴露的入口也只有一个（`packages/dsh-vscode-kit/package.json:7-11`）：

```json
"exports": {
  ".": "./src/index.js",
  "./protocol": "./src/protocol.js",
  "./package.json": "./package.json"
}
```

界面上就这三个门，"内部文件"没被暴露出去 —— 换内部实现时外面不会崩。

## 6.4 为什么"零依赖、不 import `@deepseek-ai/*`"是铁律

这条规则写在 `packages/dsh-vscode-kit/src/protocol.js:5`，一句话：

> 零依赖：只用 Node 内置模块，绝 import @deepseek-ai/*（**ERR_MODULE_NOT_FOUND 前科**）。

"前科"两个字很关键。为什么明明能 import 却禁止？因为**它是能跑的**：

- DSH 装上之后，那些包在宿主的 `node_modules` 里**是能 resolve 的**（第 4 课我为了读 cordis
  源码，就是从 DSH 发行包里把它们挖出来的）
- 所以 import 一下"能跑"，测试也可能是绿的

那问题在哪？

> **它们是宿主的内部实现，不是给你用的公开 API。** 你现在 import 的每一处，
> 都是在依赖"宿主今天恰好长这样"。宿主的装载器（loader）某天换了实现、改了内部模块布局，
> 你这条 import 就断了 —— 而且断在用户机器上，不在你的测试里。

`packages/dsh-vscode-kit/src/index.js:5` 的注释说得更直白：

> 零依赖：不 import '@deepseek-ai/cordis'。服务用 `ctx.provide(name, 普通对象)` 注册……

也就是说：插件系统需要的能力（`provide` / `inject` / `effect`），**用普通对象和约定就能拿到**，
根本不需要 import 框架本体。第 4 课的内容正好是这条规则的落地方式。

> 判断标准：**"能 import 到"不等于"可以 import"。** 公开 API 和内部实现的区别，
> 往往要等宿主升级那天才显形 —— 那时候已经晚了。

## 6.5 收口：耦合点的数量决定改动成本

把前五节压成一句可迁移的判断：

> **一个系统加功能有多贵，等于"这件事要穿过几个耦合点"。**
> 所以好的设计不是"没有耦合"，而是**把耦合点集中到最少、最稳定的那一层。**

本项目正是这么分的：

| 层 | 加一个能力要改吗 | 为什么 |
|---|---|---|
| 协议层（`protocol.js` / `server.js`） | ❌ **不动** | 消息的形状（JSON-RPC、id、分帧、错误码）跟具体能力无关 |
| 发现 / 连接（`discovery.js` / `connector.js`） | ❌ 不动 | 它们只管"找到并连上"，不管连上之后干什么 |
| 能力层（`capabilities.js`） | ✅ **改这里** | "打开文件""读选区"这些事本来就只有这一层知道 |
| 糖衣（`src/index.js` 的 `facade`） | ✅ 加一行转发 | 让消费者能通过服务对象调到新能力 |

`AGENTS.md` 把这件事写成"**加新能力的三步**"：

1. `packages/dsh-kit-bridge/src/capabilities.js` 加 `CAPABILITIES` 条目 + handler
   （不加 `import 'vscode'`，走 `host` 注入）；
2. `packages/dsh-vscode-kit/src/index.js` 的 `facade.vscode` 加一行转发；
3. 两侧各加单测、跑 E2E、真机验一次。

**协议层 `protocol.js` / `server.js` 不需要改。** 原文还有一句更硬的：
**"要改说明能力设计有问题。"**

这句话的意思是：如果加能力时你发现"得动消息格式"，那不是能力的问题，是**抽象层次划错了**。
这时候正确的动作是回头改设计，而不是在协议里打补丁 —— 因为协议一改，所有消费者都得跟着改，
改动成本就从"2 个文件"变成"无穷"。

### 一个看得见的例子

`vscode.diff` 这个能力本项目**没实现**。但系统对它不是"崩掉"，而是**结构化地拒绝**。
E2E 实测里就有这一条（第 5 课贴过，这里再看一眼它的含义）：

```
PASS 未实现能力回 -32005 — {"code":-32005,"message":"editor does not advertise capability for \"vscode.diff\""}
```

消费者拿到的不是一个空值、不是 `undefined`，而是：**"这个编辑器没声明支持这个能力"**。
它可以选择降级（比如改成 `openFile` 打开其中一个文件），也可以明确告诉用户"做不到"。

> 判断标准：**"做不到"也要分层说清是哪一种做不到。**
> 是协议不认识这个方法（bug）？还是对端不支持这个能力（可以降级）？两种走的路完全不同。

### 顺带看三个包的测试（现跑）

```
$ cd packages/dsh-vscode-kit && node --test "test/*.test.js"
ℹ tests 56      ℹ pass 56      ℹ fail 0

$ cd packages/dsh-kit-bridge && node --test "test/*.test.js"
ℹ tests 23      ℹ pass 23      ℹ fail 0

$ cd packages/dsh-kit-demo && node --test "test/*.test.js"
ℹ tests 7       ℹ pass 7       ℹ fail 0
```

三个包各自独立可测：协议库不用起扩展，扩展不用起 VS Code，消费者不用起 DSH。
**能各自独立测试，是"分层划对了"最实际的证据。**

## 6.6 本课要带走的几句话（以及全课收口）

> 1. **四段式链路**：消费者 → 协议库 → loopback TCP → 薄扩展 → 官方 API。
>    每一段都**不知道**下一段的实现细节，只共享一份协议。
> 2. **"零耦合"不是"没有关系"，是"只共享契约"**：消费者知道 `vscode.openFile` 这个方法名（契约），
>    但不知道端口、token、发现文件（实现）。前者随便改实现都不用动它。
> 3. **协议库零依赖、不 import `@deepseek-ai/*`**：那些是宿主内部实现，能跑不代表能用，
>    宿主升级就断。
> 4. **加能力只改能力层 + 一行转发，协议层不动。** 要动协议层 = 抽象划错了。
> 5. **判断规则（可迁移）**：**耦合点的数量决定改动成本。**
>    设计时先问"这件事要穿过几个耦合点"，再问"能不能把耦合点挪到更稳的那一层"。

### 一句话总结（整门课）

> **两个进程要合作，就得有人当中间人；中间人要好用，就得把"我知道的"压到最少 ——
> 少到只剩一份协议，少到加一个功能不用惊动任何人。**

## 第 6 课练习题

> **问 1：`grep -rin "port" packages/dsh-kit-demo/` 会命中好几行，但为什么它们不算"耦合"？
> 那到底什么才算耦合？**

提示：想两件事 —— ① `import` 这个词里面藏着哪三个字母；② "耦合"耦合的是代码字面，
还是"对别人实现的知识和假设"。

> **问 2：明天要加一个 `vscode.diff` 能力。按"加新能力的三步"，你需要改哪几个文件？
> 哪些文件**不该**动？如果发现必须动协议层，说明什么？**

提示：正文 6.5 有那张四层的表；另外注意"改动成本"是从哪一步开始变贵的。

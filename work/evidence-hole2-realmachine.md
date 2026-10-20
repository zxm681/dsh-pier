# 洞 2 真机复验证据（2026-10-21 06:43）

## DSH 侧日志
```
[dsh-kit-demo] dsh-kit-demo ready (kit.ready=false)
[dsh-vscode-kit] listening on 127.0.0.1:7410 (discovery: C:\Users\zxm\.dsh\dsh-vscode-kit\5764.json) 
[dsh-vscode-kit] live bridges under C:\Users\zxm\.dsh: 1 
dsh web: http://127.0.0.1:3099/?token=<已脱敏>
[dsh-vscode-kit] editor connected (remote port 4664) 
[dsh-vscode-kit] editor authorized (token accepted) 
[dsh-vscode-kit] editor connected (remote port 4666) 
[dsh-kit-demo] smoke PASS -> D:\default-workspace\projects\dsh-vscode-dev\work\smoke-result.json
```

## 攻击者（裸 socket，一个字节都不发）
```
ATTACKER connected to 7410 as pid 11732 (no token, silent)
ATTACKER received 1 message(s)
ATTACKER raw: {"jsonrpc":"2.0","method":"bridge.hello","params":{"client":"dsh-vscode-kit","protocolVersion":1,"dshVersion":"unknown","capabilities":["bridge.ping"]}}
```

## smoke 结果（攻击者在线时的 DSH 侧视角）

```
connections = 2        ← 真编辑器 + 攻击者，两条连接都在册
lastEditor  = dsh-kit-bridge
pass        = True
```

## 读法

1. 日志里 `editor connected (remote port 4666)` 之后**没有** `editor authorized` —— 攻击者没通过 token 校验。
2. 但它仍占一条连接（`connections = 2`），证明修复不是靠"拒绝连接"做到的，而是靠"拒绝准入"。
3. 请求照常落在真编辑器上（openFile / getSelection 全 ok），攻击者收到 0 条消息。
4. 攻击者唯一收到的是 `bridge.hello`，且其中**不含 token**（洞 1 修复仍然有效）。
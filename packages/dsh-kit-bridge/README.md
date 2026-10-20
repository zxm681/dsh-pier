# DSH Kit Bridge

把一小撮 VS Code 能力（打开文件、读编辑器选区）以**只读、需信任、loopback-only**的方式
暴露给 DeepSeek Harness 插件。

## 这是什么

`dsh-vscode-kit` 项目（DSH Editor Bridge Protocol v1）的 VSCode 侧薄扩展：

```
DSH 插件 ──► dsh-vscode-kit（协议库）──► loopback TCP ──► 本扩展 ──► VS Code API
```

本扩展**只会**做它声明的能力：`vscode.openFile`、`vscode.getSelection`。
不做注入、不读整个工作区、不接受远端连接。

## 安装

构建本地产物后手动安装 vsix：

```bash
cd packages/dsh-kit-bridge
npm install
npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension dsh-kit-bridge-0.1.0.vsix
```

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dshKit.enabled` | `true` | 是否启用桥接 |
| `dshKit.dshHome` | `""` | DSH 主目录；留空用 `DSH_HOME` 或 `~/.dsh` |
| `dshKit.pollIntervalMs` | `2000` | 发现文件轮询间隔 |

命令：`DSH Kit: 显示桥接状态`、`DSH Kit: 重新连接`、`DSH Kit: 撤销已信任的 DSH`。

## 安全边界

- 只连 `127.0.0.1`，不监听任何端口（本扩展是**客户端**，DH S 侧才是服务端）。
- 每条消息校验发现文件里的随机 token（32 字节熵）。
- **未信任工作区一律拒绝**（返回 `-32006 untrusted-workspace`）。
- 信任模型为首版简化：安装扩展即视为信任；撤销 = 禁用扩展。

## 排错

输出面板 → `DSH Kit Bridge`。常见状态：

- `idle` 且 `尝试 N 次`：没找到存活的 DSH 实例，确认 DSH 已启动且 `dsh-vscode-kit` 插件已启用。
- `connecting` 卡住：端口被占或 firewall 拦截 loopback。
- 一直 `disconnected`：DSH 侧进程退出；重启 DSH 后会自动重连。

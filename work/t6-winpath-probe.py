#!/usr/bin/env python3
"""T6 Windows 路径探针：openFile / getSelection 的路径归一化与长路径行为。

只调 harness 控制口（转发 ctx.dshVscodeKit.request），不碰任何产品代码。
用法：python3 work/t6-winpath-probe.py --port 3098
"""

import argparse
import json
import os
import urllib.request


def call(port, method, params=None, timeout_ms=8000):
    body = json.dumps({"method": method, "params": params or {}, "timeoutMs": timeout_ms}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/call", data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def show(tag, res):
    if res.get("ok"):
        r = res.get("result") or {}
        print(f"  {tag}: OK file={r.get('file')} lang={r.get('languageId')} elapsed={res.get('elapsedMs')}ms")
    else:
        print(f"  {tag}: FAIL code={res.get('code')} msg={res.get('message')}")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3098)
    ap.add_argument("--root", default=r"D:\code-workspace\projects\dsh-vscode-dev")
    args = ap.parse_args()
    port, root = args.port, args.root

    print("== A) 小写盘符（历史 bug：VSCode uri.fsPath 会把 C: 小写成 c:）==")
    lower = (root[0].lower() + root[1:]) + r"\work\win-e\E.md"
    print(f"  送入路径: {lower}")
    r = show("openFile(小写盘符)", call(port, "vscode.openFile", {"path": lower}))
    sel = show("getSelection", call(port, "vscode.getSelection", {}))
    f = (sel.get("result") or {}).get("file") or ""
    print(f"  返回盘符大小写: {'大写（已归一）' if f[:2].isupper() else '小写（未归一）'} -> {f[:2]}")

    print("\n== B) 中文 + 空格路径 ==")
    zh = os.path.join(root, r"work\win-e\中文 目录\测试 文件.md")
    print(f"  送入路径: {zh}")
    show("openFile(中文+空格)", call(port, "vscode.openFile", {"path": zh}))
    sel = show("getSelection", call(port, "vscode.getSelection", {}))
    got = (sel.get("result") or {}).get("file") or ""
    print(f"  与送入路径一致: {got.lower() == zh.lower()}")

    print("\n== C) 长路径（> 260 字符，Windows MAX_PATH）==")
    seg = "a" * 48
    long_path = os.path.join(root, "work", "long", seg, seg, seg, seg, seg, "deep.md")
    print(f"  路径长度: {len(long_path)}  存在: {os.path.exists(long_path)}")
    show("openFile(长路径)", call(port, "vscode.openFile", {"path": long_path}))
    sel = show("getSelection", call(port, "vscode.getSelection", {}))
    got = (sel.get("result") or {}).get("file") or ""
    print(f"  与送入路径一致: {got.lower() == long_path.lower()}")


if __name__ == "__main__":
    main()

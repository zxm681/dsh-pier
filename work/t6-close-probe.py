#!/usr/bin/env python3
"""T6 真机探针：关掉「当前活跃目标」窗口，观察 DSH 侧下一次调用落到哪里。

用途（只读 + 关自己开的窗口，不改任何产品代码）：
  1. 先连打 N 次，确认当前目标窗口是谁（getSelection 回的文件路径即窗口指纹）；
  2. 对该窗口 HWND 发 WM_CLOSE（等于点右上角 ×，优雅关闭：扩展宿主会走关停流程、
     底层 TCP 才会收到 FIN）；
  3. 立刻以 `--interval` 间隔连续打，逐条记录 {距关闭毫秒数, 成功/失败码, 返回文件}。

判据：
  - 关闭目标后应**自动落到另一个还活着的窗口**（返回另一个窗口的指纹文件），
    而不是 -32004 超时 / -32007 未连接 / 写到已销毁 socket 上；
  - 若中间出现若干条失败，说明存在「目标已死、仲裁还没换」的过渡窗口，需记录时长。

用法：
  python3 work/t6-close-probe.py --hwnd 201294 --calls 12 --interval 0.15 --duration 10
"""

import argparse
import ctypes
import json
import time
import urllib.request

WM_CLOSE = 0x0010


def call(port, method, params=None, timeout_ms=2500):
    body = json.dumps({"method": method, "params": params or {}, "timeoutMs": timeout_ms}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/call", data=body,
        headers={"content-type": "application/json"}, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=(timeout_ms / 1000) + 3) as resp:
            data = json.loads(resp.read().decode())
    except Exception as err:  # 控制口本身出错也要记下来，不能静默
        return {"ok": False, "code": "probe-error", "message": f"{type(err).__name__}: {err}",
                "elapsedMs": int((time.monotonic() - t0) * 1000)}
    data["elapsedMs"] = int((time.monotonic() - t0) * 1000)
    return data


def fingerprint(res):
    if not res.get("ok"):
        return f"FAIL code={res.get('code')} msg={res.get('message')}"
    r = res.get("result") or {}
    return f"file={r.get('file')}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3097)
    ap.add_argument("--hwnd", type=int, required=True)
    ap.add_argument("--calls", type=int, default=3, help="关闭前基线次数")
    ap.add_argument("--interval", type=float, default=0.15)
    ap.add_argument("--duration", type=float, default=10.0)
    ap.add_argument("--method", default="vscode.getSelection")
    ap.add_argument("--timeout-ms", type=int, default=2500)
    args = ap.parse_args()

    print("== 1) 关闭前基线（确认当前目标是哪个窗口）==")
    for i in range(args.calls):
        res = call(args.port, args.method, timeout_ms=args.timeout_ms)
        print(f"  baseline[{i}] {fingerprint(res)} ({res['elapsedMs']}ms)")
        time.sleep(0.1)

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    print(f"== 2) WM_CLOSE -> HWND {args.hwnd} ==")
    t_close = time.monotonic()
    posted = user32.PostMessageW(args.hwnd, WM_CLOSE, 0, 0)
    print(f"  PostMessageW posted={posted} err={ctypes.get_last_error()}")

    print("== 3) 关闭后连续探针 ==")
    rows = []
    while time.monotonic() - t_close < args.duration:
        res = call(args.port, args.method, timeout_ms=args.timeout_ms)
        dt = int((time.monotonic() - t_close) * 1000)
        rows.append((dt, res.get("ok"), res.get("code"), fingerprint(res)))
        print(f"  +{dt:>5}ms  {fingerprint(res)}  ({res['elapsedMs']}ms)")
        time.sleep(args.interval)

    fails = [r for r in rows if not r[1]]
    last_ok = [r for r in rows if r[1]]
    print("\n== 结论 ==")
    print(f"  探针 {len(rows)} 次，失败 {len(fails)} 次，成功 {len(last_ok)} 次")
    if last_ok:
        distinct = sorted({r[3] for r in last_ok})
        print(f"  成功样本的目标指纹集合：{distinct}")
    if fails:
        print(f"  失败样本：{[(r[0], r[2]) for r in fails]}")


if __name__ == "__main__":
    main()

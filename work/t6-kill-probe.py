#!/usr/bin/env python3
"""T6 探针：粗暴杀掉「当前目标窗口」的扩展宿主进程（TCP 被 RST，没有优雅关闭），
观察 DSH 侧下一次调用落到哪里。与 t6-close-probe.py（WM_CLOSE 优雅关窗）互补。

用法：python3 work/t6-kill-probe.py --pid 3616 --port 3098 --duration 8
"""
import argparse, json, subprocess, time, urllib.request

def call(port, timeout_ms=2000):
    body = json.dumps({"method": "vscode.getSelection", "params": {}, "timeoutMs": timeout_ms}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/call", data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=(timeout_ms/1000)+4).read().decode())
    except Exception as e:
        return f"probe-error {type(e).__name__}: {e}", False
    if d.get("ok"):
        return ((d.get("result") or {}).get("file") or "?")[-24:], True
    return f"FAIL code={d.get('code')} {d.get('message')}", False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--port", type=int, default=3098)
    ap.add_argument("--duration", type=float, default=8.0)
    ap.add_argument("--interval", type=float, default=0.1)
    a = ap.parse_args()
    print("== 关闭前基线 ==")
    for _ in range(3):
        print("  ", call(a.port)[0]); time.sleep(0.1)
    print(f"== Stop-Process -Force {a.pid} ==")
    t0 = time.monotonic()
    subprocess.run(["powershell", "-NoProfile", "-Command", f"Stop-Process -Id {a.pid} -Force"], check=False)
    fails = 0; rows = []
    while time.monotonic() - t0 < a.duration:
        r, ok = call(a.port)
        dt = int((time.monotonic()-t0)*1000)
        rows.append((dt, r, ok)); fails += (0 if ok else 1)
        print(f"  +{dt:>5}ms {r}"); time.sleep(a.interval)
    print(f"== 共 {len(rows)} 次，失败 {fails} 次 ==")
    print("  指纹集合:", sorted({r for _, r, ok in rows if ok}))

main()

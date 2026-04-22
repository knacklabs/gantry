#!/usr/bin/env python3
"""
CDP driver for the shared MyClaw browser profile.

The MyClaw MCP only exposes browser_launch/status/close. This helper connects
to that same Chrome via its CDP port (returned by browser_launch) so scripts
can navigate, read the DOM, click, and screenshot — reusing the persistent
`myclaw` profile so cookies/logins carry across runs.

Usage:
  python3 browser_cdp.py status
  python3 browser_cdp.py goto https://example.com
  python3 browser_cdp.py text               # innerText of body
  python3 browser_cdp.py screenshot out.png
  python3 browser_cdp.py tabs

The CDP port is read from argv (--port N) or the env var MYCLAW_CDP_PORT.
"""
import argparse, asyncio, base64, json, os, sys, urllib.request, urllib.error

try:
    import websockets
except ImportError:
    print("ERROR: pip install websockets", file=sys.stderr); sys.exit(1)


def find_port(explicit=None):
    if explicit:
        return int(explicit)
    env = os.environ.get("MYCLAW_CDP_PORT")
    if env:
        return int(env)
    raise RuntimeError("No CDP port configured. Launch browser via mcp__myclaw__browser_launch and pass --port N or set MYCLAW_CDP_PORT.")


def get_page_ws(port):
    tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list").read())
    pages = [t for t in tabs if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("No page targets. Open a tab first.")
    return pages[0]["webSocketDebuggerUrl"], pages[0]


async def cdp(ws_url, calls):
    """Send a sequence of CDP calls, return list of results."""
    results = []
    async with websockets.connect(ws_url, max_size=30_000_000) as ws:
        mid = 0
        async def send(method, params=None):
            nonlocal mid
            mid += 1
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == mid:
                    return m
        for method, params in calls:
            results.append(await send(method, params))
    return results


def cmd_status(port):
    ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version").read())
    tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list").read())
    print(json.dumps({"port": port, "browser": ver.get("Browser"), "tabs": len(tabs)}, indent=2))


def cmd_tabs(port):
    tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list").read())
    for t in tabs:
        print(f"{t.get('type'):10} {t.get('title','')[:50]:50} {t.get('url','')[:80]}")


def cmd_goto(port, url, wait=3):
    ws_url, _ = get_page_ws(port)
    async def run():
        await cdp(ws_url, [
            ("Page.enable", None),
            ("Page.navigate", {"url": url}),
        ])
        await asyncio.sleep(wait)
        r = await cdp(ws_url, [("Runtime.evaluate", {
            "expression": "({title: document.title, url: location.href})",
            "returnByValue": True,
        })])
        print(json.dumps(r[0].get("result", {}).get("result", {}).get("value"), indent=2))
    asyncio.run(run())


def cmd_text(port):
    ws_url, _ = get_page_ws(port)
    async def run():
        r = await cdp(ws_url, [("Runtime.evaluate", {
            "expression": "document.body.innerText",
            "returnByValue": True,
        })])
        print(r[0].get("result", {}).get("result", {}).get("value", ""))
    asyncio.run(run())


def cmd_screenshot(port, out):
    ws_url, _ = get_page_ws(port)
    async def run():
        r = await cdp(ws_url, [("Page.captureScreenshot", {"format": "png"})])
        data = r[0].get("result", {}).get("data")
        if not data:
            print("ERROR: empty screenshot", file=sys.stderr); sys.exit(1)
        with open(out, "wb") as f:
            f.write(base64.b64decode(data))
        print(f"wrote {out}")
    asyncio.run(run())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int)
    ap.add_argument("cmd", choices=["status", "tabs", "goto", "text", "screenshot"])
    ap.add_argument("arg", nargs="?")
    args = ap.parse_args()

    port = find_port(args.port)

    if args.cmd == "status":
        cmd_status(port)
    elif args.cmd == "tabs":
        cmd_tabs(port)
    elif args.cmd == "goto":
        if not args.arg: ap.error("goto needs URL")
        cmd_goto(port, args.arg)
    elif args.cmd == "text":
        cmd_text(port)
    elif args.cmd == "screenshot":
        cmd_screenshot(port, args.arg or "screenshot.png")


if __name__ == "__main__":
    main()

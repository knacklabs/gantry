---
name: agent-browser
description: Drive the persistent MyClaw Chrome profile (cookies, logins, sessions) via CDP so agents can navigate, read the DOM, click, and screenshot across runs. Use for any browser automation that needs a stable logged-in session — LinkedIn profile verification, X engagement, tender portals, SaaS dashboards. Triggers for "open browser", "navigate to", "check LinkedIn", "screenshot this page", "reuse logged-in session", or any task that needs the shared Chrome with persistent state.
homepage: https://chromedevtools.github.io/devtools-protocol/
user_invocable: false
metadata: {"openclaw":{"emoji":"🌐","os":["darwin","linux"],"requires":{"bins":["python3"],"packages":["websockets"]},"install":[{"id":"pip","kind":"pip","module":"websockets","label":"Install websockets (pip)"}]}}
---

# Agent Browser — Persistent CDP Session

Single shared Chrome, single persistent profile, driven over CDP. Same window / cookies / logins across every agent run — no re-authenticating on each cron tick.

## How it works

- MCP launches (or reuses) one Chrome with profile `myclaw` under `~/myclaw/data/browser-profiles/myclaw/user-data`.
- Launch returns a CDP port. That port is the same for the lifetime of the session — reconnect any time.
- Cookies, localStorage, and auth state persist on disk between launches.
- MyClaw MCP only manages lifecycle (launch / status / close). Actual page driving goes through `browser_cdp.py` (bundled in this skill), which speaks CDP directly.

## Launch sequence

1. Check status:
   ```
   mcp__myclaw__browser_status
   ```
2. If `running: false`, launch (headless by default):
   ```
   mcp__myclaw__browser_launch
   ```
   Pass `headless: false` for interactive login sessions.
3. Read the returned `port` — export it so the helper can find it:
   ```bash
   export MYCLAW_CDP_PORT=<port-from-launch>
   ```

## Driving the page

All via `~/myclaw/.claude/skills/agent-browser/browser_cdp.py`:

```bash
SKILL=~/myclaw/.claude/skills/agent-browser
python3 $SKILL/browser_cdp.py status                         # port + tab count
python3 $SKILL/browser_cdp.py tabs                           # list open tabs
python3 $SKILL/browser_cdp.py goto https://linkedin.com/...  # navigate + print title/url
python3 $SKILL/browser_cdp.py text                           # innerText of body
python3 $SKILL/browser_cdp.py screenshot page.png            # PNG of viewport
```

Pass the port explicitly with `--port N` or set `MYCLAW_CDP_PORT`. The helper does not scan local ports and does not expose arbitrary JavaScript eval in the npm package.

## Logging into a site once (LinkedIn, X, etc.)

1. Launch headful: call `mcp__myclaw__browser_launch` with `headless: false`.
2. In the Chrome window that opens, sign in normally and pass any 2FA.
3. Close the tab. **Do not close the browser** — let MCP manage lifecycle.
4. The cookie is now persisted in `user-data/`. Future headless launches reuse it.

## Using it from a cron job

Cron prompts should:

1. Call `mcp__myclaw__browser_launch` and capture `port` from the result.
2. Run the helper with `MYCLAW_CDP_PORT=<port>` or `--port <port>`.
3. Do not call `browser_close` — the session stays warm for the next slot. MyClaw manages idle cleanup.

## Known limitations

- Headless Chrome is fingerprinted by Cloudflare and some anti-bot services. Expected failures on pages like openai.com, courthousenews.com, and X login-walls.
- For those, either log in once (persistent cookie carries), or layer a stealth wrapper (not bundled).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `running: false` after launch | Check `~/myclaw/logs/myclaw.log` for Chrome spawn errors |
| Helper says "No CDP port configured" | Pass `--port <port-from-browser_launch>` or set `MYCLAW_CDP_PORT` |
| Site shows logged-out view | No session yet — do the one-time headful login above |
| Stale tab | Use `goto` to navigate the existing page instead of opening new tabs |
| Profile corrupted | Close browser, delete `~/myclaw/data/browser-profiles/myclaw/user-data`, relaunch, log in again |

## Files bundled by this skill

- `SKILL.md` — this doc
- `browser_cdp.py` — CDP driver (supports `status`, `tabs`, `goto`, `text`, `screenshot`)

# Boondi/Gantry UAT Deployment — Single EC2 Box

**Goal:** stand up one cloud server so a client can test Boondi. **No scaling**
(that's `scale-out-aws-readiness-plan.md`, deferred). One VM, Postgres in Docker
on the same box, the **only** public surface is the admin dashboard behind HTTPS,
and **push-to-`UAT` rolling deploys** (§12) keep it on the latest code without an
outage.

This is a reference. The live box + its logs are the source of truth.

---

## 1. Topology — what runs where

Everything runs on one EC2 instance. Only the admin dashboard faces the world.

```
                         Client / testers
                               │  HTTPS (443)
                               ▼
   ┌──────────────────────── ONE EC2 BOX ───────────────────────────┐
   │  Caddy (80/443, auto-TLS)  ──►  admin dashboard  :3000          │
   │                                      │ localhost                 │
   │                                      ▼                           │
   │  Gantry core  127.0.0.1:4710  ◄── Control API (admin drives it) │
   │     │ localhost          │ localhost                             │
   │     ▼                    ▼                                       │
   │  mcp-shopify :8081    mcp-crm :8082                              │
   │     │                    │                                       │
   │     └─────────► Postgres 127.0.0.1:5432 (Docker, pgvector) ◄─────┘
   │  (Interakt webhook on core: NOT exposed — see §10 to enable)     │
   └─────────────────────────────────────────────────────────────────┘
```

**Public surface = exactly one thing:** Caddy → admin dashboard (your app, your
auth). Core, both MCP servers, Postgres, and the WhatsApp webhook all stay bound
to `127.0.0.1`.

**UAT input loop (no real WhatsApp yet):** your admin dashboard injects a test
customer message into core's Control API over localhost → the agent runs *for
real* (real guardrail, real model call, real Shopify lookups) → reply is
generated and persisted → `GANTRY_OUTBOUND_DRYRUN=1` skips the actual WhatsApp
send → your dashboard reads the transcript and shows the conversation. Real
product behaviour, zero WhatsApp plumbing. Flip to real WhatsApp later (§10).

---

## 2. Provision the EC2 instance

| Choice | Value | Why |
| --- | --- | --- |
| Instance type | `t3.medium` (2 vCPU, 4 GB) | Plenty for a few testers — each worker is mostly idle waiting on the model. Bump to `t3.large` if memory is tight. |
| AMI | Ubuntu 24.04 LTS | Standard, well-trodden. |
| Storage | 30 GB gp3 | Code + Docker images + Postgres data. |
| Elastic IP | Allocate + associate | A **stable** public IP — needed for the DuckDNS record (§9) and the Interakt webhook later. |
| Subnet | Public | It must reach the internet and be reachable on 443. |

**Security group (the whole point — keep it tight):**

| Port | Source | Purpose |
| --- | --- | --- |
| 22 (SSH) | **Your IP only** (`x.x.x.x/32`) | Admin access. Never `0.0.0.0/0`. |
| 80 (HTTP) | `0.0.0.0/0` | Let's Encrypt ACME challenge + HTTP→HTTPS redirect. |
| 443 (HTTPS) | `0.0.0.0/0` (or client IPs) | The admin dashboard. Restrict to client office IPs if you can. |

**Do NOT open** 4710 / 8081 / 8082 / 3000 / 5432. They're localhost-only.

**Hostname:** you don't need to own a domain — §9 uses a free DuckDNS subdomain
pointed at this Elastic IP.

---

## 3. Install the base stack

SSH in, then:

```bash
# Docker (for Postgres)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# Node 24 (matches prod)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

# pm2 (keeps the Node processes alive + restarts on crash/reboot)
sudo npm i -g pm2

# Caddy (auto-HTTPS reverse proxy)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

---

## 4. Get the code

> **Blocker first:** your scaling work lives on the `scaling-architecture` branch
> and is **uncommitted**. The box can only run what it can pull. Commit it, branch
> `UAT` off it (§12), and push — then clone here.

```bash
sudo mkdir -p /opt/boondi && sudo chown $USER /opt/boondi
cd /opt/boondi
git clone -b UAT <your-gantry-repo-url> Agent.Gantry
cd Agent.Gantry
npm install
npm run build          # builds core + contracts + sdk + migrations into dist/
npm run build --workspace @gantry/mcp-crm
npm run build --workspace @gantry/mcp-shopify
```

The admin dashboard is your separate app — clone/build it under
`/opt/boondi/admin` per its own README.

---

## 5. Runtime home + secrets (`.env`)

`GANTRY_HOME` is the runtime state dir (separate from the code), same split as
your local `~/gantry`. Fastest path: `rsync` your **working** local
`~/gantry/{settings.yaml,agents/}` to the box, then set box-specific secrets.

```bash
export GANTRY_HOME=/home/ubuntu/gantry
mkdir -p $GANTRY_HOME
# rsync -av ~/gantry/settings.yaml ~/gantry/agents  <box>:/home/ubuntu/gantry/
```

Create `/home/ubuntu/gantry/.env` (secrets only — **no** model keys here; see §6):

```env
GANTRY_HOME=/home/ubuntu/gantry
GANTRY_DATABASE_URL=postgres://gantry:<STRONG_PW>@127.0.0.1:5432/gantry?schema=gantry
SECRET_ENCRYPTION_KEY=<base64 32-byte — openssl rand -base64 32>
GANTRY_IPC_AUTH_SECRET=<openssl rand -hex 32>

# Control API — the admin dashboard authenticates to core with this.
GANTRY_CONTROL_API_KEYS_JSON=[{"kid":"admin","token":"<openssl rand -base64 24>","appId":"default","scopes":["sessions:read","sessions:write"]}]
GANTRY_CONTROL_APP_ID=default
GANTRY_CONTROL_HOST=127.0.0.1     # localhost ONLY — admin talks over loopback
GANTRY_CONTROL_PORT=4710

# Postgres container password (docker-compose reads this) — match <STRONG_PW> above
POSTGRES_PASSWORD=<STRONG_PW>

# Shopify MCP (UAT store)
SHOPIFY_ENV=dev
SHOPIFY_DEV_SHOP_DOMAIN=...
SHOPIFY_DEV_CLIENT_ID=...
SHOPIFY_DEV_CLIENT_SECRET=...
SHOPIFY_MCP_PORT=8081
MCP_IDENTITY_SECRET=<openssl rand -hex 32>     # HMAC between core and the MCP
SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY=true

# Background extractor token seam (optional; falls back to the shared
# Gantry model credential when unset — fine for UAT)
GANTRY_BACKGROUND_ANTHROPIC_TOKEN=
```

> Confirm the exact mcp-crm env keys in `packages/mcp-crm/src/env.ts` (it opens its
> own Postgres pool + reads the background token). It shares this same `.env`.

---

## 6. Bring up Postgres + the model credential

```bash
cd /opt/boondi/Agent.Gantry
docker compose --env-file /home/ubuntu/gantry/.env up -d postgres
docker compose ps      # wait for healthy
```

**Model credential (NOT in `.env`)** — the runtime strips `ANTHROPIC_*` env and
reads model creds from the encrypted Credential Center in Postgres. Use a **real
Anthropic API key** for UAT, not your personal Claude Code OAuth token (a client
hammering a shared 5-hour window will see throttling and bad latency):

```bash
node dist/cli/index.js credentials model set      # paste sk-ant-api... key
node dist/cli/index.js model use-preset anthropic
node dist/cli/index.js credentials model doctor   # verify
```

---

## 7. settings.yaml — workers + Boondi agent

In `/home/ubuntu/gantry/settings.yaml`, set your "few workers" and confirm the
Boondi agent block came across in the rsync:

```yaml
runtime:
  workers:
    total_workers: 4          # max concurrent customer chats — your "few workers"
    warm_reserve_workers: 1   # pre-booted runners, carved out of total
```

Validate: `node dist/cli/index.js settings validate`

---

## 8. Run the stack (pm2)

Mirrors `scripts/boondi-runtime-stack.sh` launch order, **productionized**: no
dry-run-test scaffolding, control bound to localhost, pm2 for restart-on-crash +
start-on-boot. Create `/opt/boondi/ecosystem.config.js`:

```js
const cwd = '/opt/boondi/Agent.Gantry'
const env_file = '/home/ubuntu/gantry/.env'
module.exports = {
  apps: [
    { name: 'mcp-shopify', cwd, env_file,
      script: 'packages/mcp-shopify/dist/index.js' },
    { name: 'mcp-crm', cwd, env_file,
      script: 'packages/mcp-crm/dist/index.js' },
    { name: 'gantry-core', cwd, env_file,
      script: 'dist/index.js',
      kill_timeout: 30000,           // give core time to drain in-flight chats on reload
      env: {
        GANTRY_HOME: '/home/ubuntu/gantry',
        GANTRY_CONTROL_HOST: '127.0.0.1',
        GANTRY_CONTROL_PORT: '4710',
        GANTRY_IPC_SOCKET_PATH: '/run/gantry/core.sock',
        GANTRY_OUTBOUND_DRYRUN: '1',  // UAT: generate+persist replies, skip real WhatsApp send
      } },
    { name: 'boondi-admin', cwd: '/opt/boondi/admin', script: 'npm', args: 'start',
      env: { PORT: '3000',
        GANTRY_CONTROL_BASE_URL: 'http://127.0.0.1:4710',
        GANTRY_CONTROL_API_KEY: '<the token from CONTROL_API_KEYS_JSON>' } },
  ],
}
```

```bash
mkdir -p /run/gantry
pm2 start /opt/boondi/ecosystem.config.js
pm2 save && pm2 startup     # run the printed command so it survives reboot
pm2 logs                    # watch boot
```

Health check (all should answer):

```bash
curl -s localhost:4710/ -o /dev/null -w '%{http_code}\n'   # core
curl -s localhost:8081/healthz                              # shopify -> {"ok":true}
curl -s localhost:8082/healthz                              # crm     -> {"ok":true}
```

> If a package has no `dist/` build, run it via tsx instead (exactly as your stack
> script does): `script: 'node', args: '--import tsx packages/mcp-crm/src/index.ts'`.

### Auto-restart on crash (already covered — nothing custom to build)

| Process | Supervisor | Restart on crash | Restart on reboot |
| --- | --- | --- | --- |
| Postgres | Docker | ✅ `restart: unless-stopped` (already in `docker-compose.yml`) | ✅ Docker daemon starts at boot |
| core, mcp-shopify, mcp-crm, admin | pm2 | ✅ pm2 relaunches any process that exits | ✅ via `pm2 startup` + `pm2 save` |

Verify it actually works:

```bash
pm2 status                                         # all four 'online'
kill $(pm2 pid gantry-core); sleep 2; pm2 status   # core back, ↺ restart count +1
sudo reboot                                        # after boot: all four online again
```

Optional crash-loop guard (per app): `max_restarts: 10`, `min_uptime: 10000`,
`restart_delay: 3000`.

> **Gantry also ships `gantry service install`** — a built-in auto-restart daemon
> (systemd `Restart=always` on Linux, launchd `KeepAlive` on macOS). But it supervises
> **core only**, and on Linux installs a *user* service that needs
> `loginctl enable-linger <user>` to survive logout on a headless box. So for this
> four-process stack, pm2 (one supervisor for everything) is simpler.

---

## 9. Free hostname + HTTPS — DuckDNS + Caddy ($0)

Let's Encrypt won't issue a cert for a bare IP, so you need a hostname. DuckDNS
gives one free; Caddy turns it into HTTPS automatically. No domain, no cost.

1. **DuckDNS** (https://www.duckdns.org) → sign in with GitHub → create a
   subdomain, e.g. `boondi-uat` → set its IP to your EC2 **Elastic IP** → Save.
   You now own `boondi-uat.duckdns.org`. No API token needed — Caddy uses the
   HTTP-01 challenge, which just needs port 80 reachable (it is).
2. **Security group:** ports **80 + 443** open (already in §2).
3. **`/etc/caddy/Caddyfile`:**
   ```caddy
   boondi-uat.duckdns.org {
       encode gzip
       reverse_proxy 127.0.0.1:3000
       # Optional second lock on top of your dashboard's own login:
       # basic_auth { tester $2a$14$<bcrypt-hash> }
   }
   ```
4. ```bash
   sudo systemctl reload caddy   # issues the Let's Encrypt cert on first request
   ```

That's the entire public footprint — free and stable. Visit
`https://boondi-uat.duckdns.org`, log in with your dashboard's auth, drive a test
conversation, watch the agent respond. **UAT is live.**

> Buy a real domain only when you want a polished client URL — and you'll need one
> for AWS production anyway (ACM certs also require a domain).

---

## 10. When you want REAL WhatsApp (later, one change)

Today the Interakt webhook is closed. To accept real WhatsApp inbound:

1. Create a second free DuckDNS subdomain (e.g. `hooks-boondi-uat`) pointed at the
   same Elastic IP, and add a route so only the webhook path reaches core:
   ```caddy
   hooks-boondi-uat.duckdns.org {
       reverse_proxy /v1/ingresses/* 127.0.0.1:4710
   }
   ```
2. Register the Interakt ingress secret in Gantry (signed ingress record) and set
   the Interakt webhook URL to `https://hooks-boondi-uat.duckdns.org/v1/ingresses/...`.
3. Configure Interakt **outbound** creds and set `GANTRY_OUTBOUND_DRYRUN=0` so
   replies actually send.

Interakt requires a **3-second ACK** and **disables the webhook after 5 fails in
10 min** — keep it out of UAT until the path is stable.

---

## 11. Gotchas (recap)

1. **Commit `scaling-architecture` first** — the box runs pulled code; your two-knob +
   background-isolation work isn't committed.
2. **Real Anthropic API key, not personal OAuth** — §6.
3. **Direct Postgres only** — work dispatch uses LISTEN/NOTIFY + advisory locks; a
   transaction-mode pooler silently breaks it. Postgres-in-Docker-on-the-box is direct.
4. **Admin auth is yours** — Gantry exposes nothing public; the dashboard's login is
   the perimeter. Don't expose it bare.
5. **This box = your first prod node** — AWS, EC2, exactly the README deploy model.

---

## 12. Continuous deploy from the `UAT` branch (rolling, minimal downtime)

**Goal:** push to `UAT` → the box runs the new code, without a visible outage.

### One-time setup

1. Commit the scaling work, then create + push the branch:
   ```bash
   git add -A && git commit -m "UAT baseline"
   git checkout -b UAT && git push -u origin UAT
   ```
2. The deploy script lives at **`agents/boondi_support/docs/uat-deploy.sh`** (full copy below) — it pulls
   `UAT`, rebuilds, and `pm2 reload`s the stack. `set -e` aborts *before* the reload
   if the build fails, so a broken commit never replaces running code.
3. core is tuned for graceful reload (`kill_timeout: 30000` in §8) so it drains
   in-flight chats before the new process takes over.

### `agents/boondi_support/docs/uat-deploy.sh`

```bash
#!/usr/bin/env bash
# Rolling UAT deploy: pull latest UAT, rebuild, graceful pm2 reload.
# Safe to run on a timer (poll) or from a push hook. Paths override via env.
set -euo pipefail
APP_DIR="${UAT_APP_DIR:-/opt/boondi/Agent.Gantry}"
ADMIN_DIR="${UAT_ADMIN_DIR:-/opt/boondi/admin}"
ECOSYSTEM="${UAT_ECOSYSTEM:-/opt/boondi/ecosystem.config.js}"
BRANCH="${UAT_BRANCH:-UAT}"
log() { echo "[$(date -u +%FT%TZ)] $*"; }

cd "$APP_DIR"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] && exit 0   # nothing new -> quiet no-op

log "deploy $LOCAL -> $REMOTE   (rollback: git reset --hard $LOCAL && npm run build && pm2 reload $ECOSYSTEM)"
git reset --hard "origin/$BRANCH"

# Build to dist BEFORE reloading; a failure exits here with old processes untouched.
npm ci
npm run build
npm run build --workspace @gantry/mcp-crm
npm run build --workspace @gantry/mcp-shopify

if [ -d "$ADMIN_DIR/.git" ]; then
  log "deploy admin"
  git -C "$ADMIN_DIR" fetch --quiet origin "$BRANCH"
  git -C "$ADMIN_DIR" reset --hard "origin/$BRANCH"
  ( cd "$ADMIN_DIR" && npm ci && npm run build )
fi

pm2 reload "$ECOSYSTEM" --update-env   # graceful rolling reload
log "deploy OK -> $REMOTE"
```

### Trigger — pick one

**(A) Poll (simplest, $0, nothing to secure) — recommended.**
The box checks `UAT` every minute and deploys when it changes.

```ini
# /etc/systemd/system/uat-deploy.service
[Service]
Type=oneshot
User=ubuntu
ExecStart=/opt/boondi/Agent.Gantry/agents/boondi_support/docs/uat-deploy.sh
```
```ini
# /etc/systemd/system/uat-deploy.timer
[Timer]
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl enable --now uat-deploy.timer
journalctl -u uat-deploy -f      # watch deploys
```
Push to `UAT` → live within ~60s. No inbound ports, no secrets, no runner.

**(B) Instant push-trigger — GitHub Actions self-hosted runner (optional).**
Install a self-hosted runner on the box (repo → Settings → Actions → Runners),
supervise it with pm2, then add `.github/workflows/uat-deploy.yml`:
```yaml
name: uat-deploy
on: { push: { branches: [UAT] } }
jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - run: /opt/boondi/Agent.Gantry/agents/boondi_support/docs/uat-deploy.sh
```
Deploys the instant you push, still no inbound ports (the runner dials out).
> Avoid the "GitHub-cloud runner SSHes in" pattern — it needs port 22 open to GitHub's
> dynamic IP ranges, which fights your locked-down security group.

### The honest zero-downtime picture

- **Client-facing admin dashboard:** a graceful `pm2 reload` is a ~2–5s swap — for a
  client clicking around a UAT dashboard (and *you* control when you push), that's no
  meaningful downtime. For **true** zero-downtime, run two admin instances on 3000/3001
  and let Caddy load-balance (`reverse_proxy 127.0.0.1:3000 127.0.0.1:3001`); the
  deploy reloads them one at a time.
- **core / MCP:** a few-second graceful blip as the new process takes over. In-flight
  conversations drain (`kill_timeout`); nothing is lost. Invisible unless someone is
  mid-message at that instant.
- **Full zero-downtime for core** needs blue-green (run a 2nd core, cordon + drain the
  old one). Your lease model already makes that *safe*; the `cordon` flag it needs is
  the not-yet-built Phase C of `scale-out-aws-readiness-plan.md`. Add it later only if
  UAT ever needs hot core swaps.

### Migrations & rollback

- Keep DB migrations **backward-compatible** (old code must tolerate the new schema
  during the swap). Your migrations are already idempotent/boot-run, so additive
  changes are safe — avoid destructive column drops in a UAT deploy.
- **Rollback:** the deploy log prints the previous SHA. To revert:
  ```bash
  cd /opt/boondi/Agent.Gantry && git reset --hard <PREV_SHA> && npm run build && pm2 reload /opt/boondi/ecosystem.config.js
  ```
- **Bulletproof upgrade (optional):** release-dir + symlink deploys (build each release
  in `/opt/boondi/releases/<sha>`, atomically repoint a `current` symlink, reload) give
  atomic swaps + instant rollback. Ask if you want it wired.

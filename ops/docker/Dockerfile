# syntax=docker/dockerfile:1.7

# Gantry runtime image — multi-stage build.
#
# Node 24 LTS ("Krypton") is the only supported runtime line for this repo
# (package.json engines: ">=24 <26"; docs/architecture/current-verification-commands.md).
# The base is pinned by manifest-list digest for reproducibility across a rolling
# deploy. Refresh the digest deliberately (see docs/deployment/aws-terraform.md).
#
#   node:24-bookworm-slim @ 2026-06 (Node 24.16.0 "Krypton" LTS)
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

# ---------------------------------------------------------------------------
# Stage 1: deps — install ALL dependencies (incl. dev) for the build.
# Workspace package manifests are copied before the lockfile install so Docker
# can cache the npm layer when only source changes.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Copy only manifests + lockfile first for cacheable `npm ci`.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY examples/nextjs-workflows/package.json examples/nextjs-workflows/package.json

# Full install (dev deps included) — needed for tsc + workspace builds.
# `--ignore-scripts` keeps install hermetic; the prepare hook (husky) is a no-op
# in CI/containers and we never want lifecycle scripts running unreviewed.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2: build — compile contracts, SDK, core, and copy migrations into dist.
# `npm run build:runtime` runs: clean → build:contracts → build:sdk → tsc →
# copy:migrations → chmod cli. Migrations land in dist/.../migrations so the
# runtime image can migrate without the source tree. The examples workspace
# (`build:examples`) is deliberately NOT built here — examples are dev/docs
# surface, never shipped in the runtime image, and their source is not copied.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm run build:runtime

# Prune to production dependencies for the runtime stage. The workspace
# file: links (@gantry/contracts, @gantry/sdk) resolve to packages/*/dist,
# which the build produced above.
RUN npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 3: runtime — minimal, non-root, production-only.
# Contains: production node_modules, dist/ (incl. migration SQL and migrator),
# the built contracts/sdk workspace dist, and the entrypoint.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    GANTRY_HOME=/var/lib/gantry \
    GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING=1

# Skill-script interpreters. Skills are distributed as data artifacts in any
# language; the image carries the interpreters their scripts need at runtime.
# python3 covers the common non-Node skill payload. Deliberately NOT included:
# pip usage at runtime (fleet workers never run a package manager — Python
# package installs belong to a future bake lane, see TODOS.md) and the Go
# toolchain (Go-built tools ship as binaries: add the binary here per tool).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      libatomic1 \
      bubblewrap \
      socat \
      ripgrep \
      gosu \
    && rm -rf /var/lib/apt/lists/*
# bubblewrap backs runtime.sandbox.provider=sandbox_runtime (the whole-runner
# OS sandbox on Linux). Creating its namespaces inside Docker additionally
# requires a user-namespace-capable seccomp profile on `docker run`; fleet
# rehearsal and Terraform launch configs pass that container runtime option.
# socat backs the sandbox-runtime egress proxy, ripgrep is the expected fast
# search binary for agent turns, and libatomic1 is required by newer Node builds
# on small Ubuntu/Debian hosts.

# The runtime image never installs packages. Drop the package-manager payload
# inherited from the Node base image so bundled npm CVEs do not fail image scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Non-root runtime user. The base image already ships a `node` user (uid 1000);
# create the default runtime-state dir owned by it. The entrypoint also prepares
# runtime-mounted GANTRY_HOME values such as /srv/reagent/home before dropping
# privileges, which ECS/EBS mounts need because they arrive root-owned.
RUN install -d -o node -g node "${GANTRY_HOME}"

WORKDIR /app

# Production dependency closure + built artifacts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/package.json

# Ops scripts: fleet settings seed + entrypoint.
COPY ops/docker/fleet-settings-seed.mjs ./ops/docker/fleet-settings-seed.mjs
COPY ops/docker/entrypoint.sh /usr/local/bin/gantry-entrypoint
RUN chmod +x /usr/local/bin/gantry-entrypoint

# Control port (liveness /healthz, readiness /readyz, internal /metrics) is
# set by the deployment via GANTRY_CONTROL_PORT; documented, not hardcoded.
ENTRYPOINT ["/usr/local/bin/gantry-entrypoint"]
CMD ["node", "dist/index.js"]

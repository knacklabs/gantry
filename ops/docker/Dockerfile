# syntax=docker/dockerfile:1.7

# Gantry runtime image — multi-stage build.
#
# Node 24 LTS ("Krypton") is the only supported runtime line for this repo
# (package.json engines: ">=24 <26"; docs/architecture/current-verification-commands.md).
# The base is pinned by manifest-list digest for reproducibility across a rolling
# deploy. Refresh the digest deliberately (see docs/deployment/aws-terraform.md).
#
#   node:24-trixie-slim @ 2026-10 (Node 24.22.0 "Krypton" LTS; Debian 13.7)
ARG NODE_IMAGE=node:24-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c
ARG UBUNTU_IMAGE=ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:cf50a4f6ac4f026458b08d5222023d700ac806410dff5e9ca8728fa44f2b850f

# Full Chrome (including headed/CDP support), not the headless-only shell.
# This production image targets linux/amd64; Google publishes linux64 here.
FROM ${PYTHON_IMAGE} AS chrome-for-testing
ADD --checksum=sha256:e6c94490f0b6b337225aeb2d2a5034858516b7017356980ba94f5176d8774a50 \
  https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-linux64.zip /tmp/chrome.zip
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && mkdir -p /opt/chrome-for-testing \
    && unzip -q /tmp/chrome.zip -d /opt/chrome-for-testing \
    && rm -rf /tmp/chrome.zip /var/lib/apt/lists/*

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
COPY vendor/braces-3.0.3.tgz ./vendor/braces-3.0.3.tgz
COPY vendor/node-forge-1.4.0.tgz ./vendor/node-forge-1.4.0.tgz

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
FROM ${PYTHON_IMAGE} AS python-runtime

FROM ${UBUNTU_IMAGE} AS runtime

COPY --from=python-runtime /usr/local /usr/local
RUN ldconfig

# Refresh pip's vendored urllib3/msgpack as well; provenance/reproducer lives in
# ops/docker/security/pip. Preserve pip's real version and wheel RECORD hashes.
COPY vendor/pip-26.2.2-py3-none-any.whl /tmp/pip-26.2.2-py3-none-any.whl
RUN echo 'e2ea38fcf3cac60020a6bce296e7f4af9f729501c8271f0eab202e6d9adb8fd2  /tmp/pip-26.2.2-py3-none-any.whl' | sha256sum -c - \
    && python3 -m pip install --no-cache-dir --no-deps --upgrade --force-reinstall /tmp/pip-26.2.2-py3-none-any.whl \
    && rm -f /usr/local/lib/python3.13/ensurepip/_bundled/pip-*.whl \
    && cp /tmp/pip-26.2.2-py3-none-any.whl /usr/local/lib/python3.13/ensurepip/_bundled/ \
    && chmod 0644 /usr/local/lib/python3.13/ensurepip/_bundled/pip-26.2.2-py3-none-any.whl \
    && sed -i 's/_PIP_VERSION = "26\.2\.1"/_PIP_VERSION = "26.2.2"/' /usr/local/lib/python3.13/ensurepip/__init__.py \
    && grep -qx '_PIP_VERSION = "26.2.2"' /usr/local/lib/python3.13/ensurepip/__init__.py \
    && rm -f /tmp/pip-26.2.2-py3-none-any.whl

COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=chrome-for-testing /opt/chrome-for-testing /opt/chrome-for-testing
RUN ln -s /opt/chrome-for-testing/chrome-linux64/chrome /usr/local/bin/chromium \
    && ln -s /opt/chrome-for-testing/chrome-linux64/chrome /usr/local/bin/chromium-browser \
    && ln -s /opt/chrome-for-testing/chrome-linux64/chrome /usr/bin/chromium \
    && ln -s /opt/chrome-for-testing/chrome-linux64/chrome /usr/bin/chromium-browser

ENV NODE_ENV=production \
    GANTRY_HOME=/var/lib/gantry \
    GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING=1

# Retain Python and default venv support from the pinned Python image. The pip
# seed is updated above as well as the installed pip so fresh venvs stay patched.
# Supply browser shared libraries without installing Debian's older Chromium,
# desktop helper programs or systemd services. Go-built tools ship as binaries.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      libstdc++6 \
      libssl3t64 \
      libbz2-1.0 \
      liblzma5 \
      libsqlite3-0 \
      libffi8 \
      libreadline8t64 \
      zlib1g \
      libatomic1 \
      libasound2t64 \
      libatk-bridge2.0-0t64 \
      libatk1.0-0t64 \
      libatspi2.0-0t64 \
      libcairo2 \
      libcups2t64 \
      libdbus-1-3 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0t64 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libudev1 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      fonts-liberation \
      bubblewrap \
      socat \
      ripgrep \
    && rm -rf /var/lib/apt/lists/*
# bubblewrap backs runtime.sandbox.provider=sandbox_runtime (the whole-runner
# OS sandbox on Linux). Creating its namespaces inside Docker additionally
# requires a user-namespace-capable seccomp profile on `docker run`; fleet
# rehearsal and Terraform launch configs pass that container runtime option.
# socat backs the sandbox-runtime egress proxy, ripgrep is the expected fast
# search binary for agent turns, and libatomic1 is required by newer Node builds
# on small Ubuntu/Debian hosts.

# Ubuntu 26.04 supplies an official libxml2 line unaffected by CVE-2026-6653.
# Do not install the older Debian local backport in this runtime.

# The runtime image never installs packages. Drop the package-manager payload
# inherited from the Node base image so bundled npm CVEs do not fail image scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Non-root runtime user. The base image already ships a `node` user (uid 1000);
# create the default runtime-state dir owned by it. Mounted state directories
# must be prepared offline; the entrypoint never starts as root or changes owners.
RUN if getent passwd 1000 >/dev/null; then userdel -r "$(getent passwd 1000 | cut -d: -f1)"; fi \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/bash --create-home node \
    && install -d -o node -g node "${GANTRY_HOME}"

WORKDIR /app

# Production dependency closure + built artifacts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/package.json

# Ops scripts: settings revision seed/import + entrypoint.
COPY ops/docker/fleet-settings-seed.mjs ./ops/docker/fleet-settings-seed.mjs
COPY ops/docker/workstation-settings-import.mjs ./ops/docker/workstation-settings-import.mjs
COPY ops/docker/entrypoint.sh /usr/local/bin/gantry-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/gantry-entrypoint \
    && chmod +x /usr/local/bin/gantry-entrypoint

# Control port (liveness /healthz, readiness /readyz, internal /metrics) is
# set by the deployment via GANTRY_CONTROL_PORT; documented, not hardcoded.
# The Ubuntu minimal base has no CA bundle. Retain verified Python/HTTPS access.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/bin/pebble
# Gantry uses its own entrypoint; Ubuntu's bundled Pebble init is unused.
USER node
ENTRYPOINT ["/usr/local/bin/gantry-entrypoint"]
CMD ["node", "dist/index.js"]

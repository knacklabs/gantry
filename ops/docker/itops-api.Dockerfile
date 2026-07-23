# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable

COPY products/itops/package.json products/itops/pnpm-lock.yaml products/itops/pnpm-workspace.yaml products/itops/tsconfig.base.json ./
COPY products/itops/apps ./apps
COPY products/itops/packages ./packages
COPY products/itops/scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @itops/itops-api... build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    ITOPS_API_HOST=0.0.0.0 \
    ITOPS_API_PORT=4000
WORKDIR /app
RUN corepack enable

COPY --from=build /app ./

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "pnpm --filter @itops/db db:migrate && pnpm --filter @itops/itops-api start"]

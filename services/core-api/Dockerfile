# core-api: multi-stage build, non-root runtime, health check.
# Build from the repo root: docker build -f services/core-api/Dockerfile .
ARG NODE_IMAGE=node:22.22-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
# Manifests first, so dependency layers are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/core-api/package.json services/core-api/
RUN pnpm install --frozen-lockfile --filter @invoiceiq/core-api...
COPY packages/contracts packages/contracts
COPY services/core-api services/core-api
RUN pnpm --filter @invoiceiq/core-api run build \
 && pnpm --filter @invoiceiq/core-api deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/services/core-api/dist ./dist
COPY --from=build --chown=node:node /repo/services/core-api/migrations ./migrations
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]

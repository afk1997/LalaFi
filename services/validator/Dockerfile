# syntax=docker/dockerfile:1.7
# xpool Validator node.
# Build context: the repository root (see infra/docker-compose.yml):
#   docker build -f services/validator/Dockerfile .
FROM node:22-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

WORKDIR /app
COPY . .
# Only this service and its workspace deps (@xpool/service-common); no dependency build scripts.
RUN pnpm install --frozen-lockfile --prod --filter "@xpool/validator..." \
 && mkdir -p /data && chown node:node /data

USER node
WORKDIR /app/services/validator
ENV XPOOL_ROOT=/app STATE_DIR=/data METRICS_PORT=9100
VOLUME ["/data"]
# Runs from TypeScript source via tsx (no separate build step). Keys come from env vars only.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"]

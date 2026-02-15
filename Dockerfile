
FROM node:25-slim AS pnpm-base
RUN npm i -g pnpm@10

FROM pnpm-base AS build-base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

FROM build-base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml ./
RUN pnpm i --frozen

FROM deps AS builder
COPY . .
RUN pnpm build

FROM build-base AS server_deps
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
RUN pnpm i --frozen --prod

FROM pnpm-base AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS runner
ENV PORT=9000 \
  MEDUSA_WORKER_MODE=server \
  DISABLE_MEDUSA_ADMIN=false
COPY --from=server_deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.medusa/server ./
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER node
EXPOSE 9000
ENTRYPOINT ["./docker-entrypoint.sh"]

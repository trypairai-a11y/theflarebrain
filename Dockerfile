FROM node:20.11.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/prompts/package.json packages/prompts/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/prompts/node_modules ./packages/prompts/node_modules
COPY . .
RUN pnpm --filter @brain/shared build 2>/dev/null || true
RUN pnpm --filter @brain/prompts build 2>/dev/null || true
RUN cd apps/api && npx prisma generate
RUN pnpm --filter @brain/api build

FROM base AS production
ENV NODE_ENV=production
RUN apk add --no-cache wget tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/infra ./infra
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./
USER node
EXPOSE 3000
WORKDIR /app/apps/api
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/apps/api/src/server.js"]

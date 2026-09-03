# ---------------------------------------------------------------------------
# Production image for apps/api. Build from the repo root:
#   docker build -f docker/api.Dockerfile -t project-river-api .
# Dev does NOT use this - run the API on the host with `pnpm --filter @river/api dev`.
# Fly builds this remotely on `fly deploy`.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
# OpenSSL is needed for Prisma's query engine to pick the right binary.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo

# ---- deps: install workspace dependencies with a warm pnpm store ----
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/config/package.json packages/config/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/poker-engine/package.json packages/poker-engine/package.json
COPY apps/api/package.json apps/api/package.json
# apps/api's postinstall runs `prisma generate`, so the schema must be present.
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm --filter @river/api... build
RUN pnpm --filter @river/api --prod deploy /out

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/prisma ./prisma
COPY --from=build --chown=node:node /out/package.json ./package.json
USER node
EXPOSE 3000
# Migrations run once per deploy via the platform's release step
# (fly.toml [deploy] release_command). This just starts the server.
CMD ["node", "dist/main.js"]

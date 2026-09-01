# ---------------------------------------------------------------------------
# Production image for apps/api. Build from the repo root:
#   docker build -f docker/api.Dockerfile -t project-river-api .
# Dev does NOT use this - run the API on the host with `pnpm --filter @river/api dev`.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install workspace dependencies with a warm pnpm store ----
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/config/package.json packages/config/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/poker-engine/package.json packages/poker-engine/package.json
COPY apps/api/package.json apps/api/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm --filter @river/api... build
RUN pnpm --filter @river/api --prod deploy /out

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/prisma ./prisma
COPY --from=build /out/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/main.js"]

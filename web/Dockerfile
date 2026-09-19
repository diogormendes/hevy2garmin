FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must be able to validate the production shape without connecting to
# the runtime database. All routes remain dynamic and use the real DATABASE_URL
# only when the container is running.
ENV DATABASE_URL=postgresql://ci:ci@localhost:5432/ci \
    H2G_PASSWORD=build-password \
    H2G_SECRET=build-session-secret \
    HEVY2GARMIN_SECRET=build-csrf-secret \
    NEXT_TELEMETRY_DISABLED=1

# Webpack is more portable for the standalone image build. Turbopack remains
# available for local development and CI's regular web checks, but can require
# a worker port that is unavailable in restricted build environments.
RUN npm run build -- --webpack

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8096 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8096
CMD ["node", "server.js"]

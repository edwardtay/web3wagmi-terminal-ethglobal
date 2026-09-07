FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund --loglevel=error

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Resolve A records before AAAA. Node prefers IPv6, and on a host whose IPv6
# route is advertised but dead, every outbound call to an upstream hangs until
# undici's ten second connect timeout and surfaces as a bare "fetch failed",
# which is indistinguishable from the upstream being down. Nothing this app
# talks to is IPv6 only.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next

USER nextjs
EXPOSE 3000

# Every configuration value is read from the runtime environment. Pass them with
# `docker run --env-file`, or through whatever your platform uses for secrets.
# Nothing is baked into the image, so the same image is safe to publish and to
# promote between environments.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/ready || exit 1
CMD ["node", "server.js"]

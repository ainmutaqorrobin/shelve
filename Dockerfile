# syntax=docker/dockerfile:1.7
# Goes at the ROOT of your shelve fork. Two published stages:
#   runner  -> ghcr.io/<you>/shelve-app      (ships only .output, ~200MB)
#   builder -> ghcr.io/<you>/shelve-migrate  (full workspace, runs drizzle migrations)

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# builder: installs the whole pnpm workspace and builds @shelve/app.
# Also published as the migrate image -- `nuxt db migrate` needs drizzle-kit
# and the migration SQL, neither of which exist in the runtime image.
# ---------------------------------------------------------------------------
FROM base AS builder

# Shelve validates env at build time; there are no real secrets to give it here.
ENV SKIP_ENV_VALIDATION=true

# ssr:false => NUXT_PUBLIC_* is baked into the SPA bundle at BUILD time, not read
# at runtime. Anything public must arrive as a build arg.
ARG NUXT_PUBLIC_GITHUB_APP_NAME=""
ENV NUXT_PUBLIC_GITHUB_APP_NAME=$NUXT_PUBLIC_GITHUB_APP_NAME

# NuxtHub picks its DB driver (postgres-js vs PGlite) by detecting this var at
# BUILD time, and bakes the choice into .output. This placeholder steers
# driver selection toward postgres-js -- it is never a real connection target.
# apps/shelve/nuxt.config.ts sets applyMigrationsDuringBuild: false, so
# NuxtHub does NOT attempt to actually connect with it; without that flag it
# tries to apply migrations against this URL during the build and fails with
# ECONNREFUSED, since nothing is listening on it in the builder container.
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=$DATABASE_URL

# apps/shelve/modules/auth/index.ts bakes isEmailEnabled (which login.vue uses
# to decide whether to render the OTP login form at all) into the client
# bundle at this same BUILD time, based only on whether this var is non-empty
# -- it never reads the actual key value at build time. This placeholder just
# needs to exist; the real key (used server-side, at runtime, to actually call
# Resend) lives only in the VPS's runtime .env, never here.
ARG NUXT_PRIVATE_RESEND_API_KEY="re_build_placeholder"
ENV NUXT_PRIVATE_RESEND_API_KEY=$NUXT_PRIVATE_RESEND_API_KEY

COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build:app

# ---------------------------------------------------------------------------
# runner: the Nitro server output and nothing else.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_PORT=3000 \
    NITRO_HOST=0.0.0.0
COPY --from=builder /app/apps/shelve/.output ./.output
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]

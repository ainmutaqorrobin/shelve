# Self-hosting Shelve — company deployment guide

Everything learned while getting this fork of [HugoRCD/shelve](https://github.com/HugoRCD/shelve)
running on a self-managed Docker host, written up so it can be repeated for a
company deployment instead of a personal VPS. Every bug below was hit for
real, on a real deploy — this is not speculative.

## 1. Architecture

```
GitHub Actions (build) -> GHCR (private) -> your host pulls
                                                |
                          nginx/reverse proxy -> 127.0.0.1:<port>
                                                |
                                     docker compose: app + postgres
```

The host never checks out source and never builds anything. CI builds two
images and pushes them to GHCR; the host only pulls and runs. Two images
come out of one `Dockerfile`, both from the same `builder` stage:

- **`shelve-app`** (`runner` target) — the Nitro server output only (`.output`),
  ~90–100MB. This is what actually serves traffic.
- **`shelve-migrate`** (`builder` target) — the full workspace, including
  `drizzle-kit` and the migration SQL. Only used to run `nuxt db migrate` as
  a one-off container. The `runner` image deliberately does **not** ship
  drizzle-kit or the migration files, so migrations cannot run inside it.

## 2. Files this repo already has vs. files you must still create

**Already in this fork's repo root** (copy these into your own fork as-is —
they're the product of everything in section 3):

- `Dockerfile`
- `.dockerignore`
- `.github/workflows/deploy.yml`

**You must create these yourself, on the host** — they are host-specific and
were never added to the repo (correctly — they hold no app logic, only your
infra's specifics):

- `/opt/docker/shelve/compose.yml` (or wherever your company's Docker hosts
  keep app deployments) — services for `app`, `postgres`, and a `migrate`
  one-off under a `tools` profile. Minimal shape:

  ```yaml
  # Cap container logs. Unbounded json-file logs are the most common way a
  # small host fills its disk, and the BotID warning in §3.7 fires on every
  # protected POST, so this stack is noisier than most.
  x-logging: &default-logging
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"

  services:
    postgres:
      image: postgres:17-alpine
      restart: unless-stopped
      logging: *default-logging
      environment:
        POSTGRES_USER: ${POSTGRES_USER}
        POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
        POSTGRES_DB: ${POSTGRES_DB}
      volumes:
        - postgres-data:/var/lib/postgresql/data
      healthcheck:
        test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
        interval: 5s
        timeout: 5s
        retries: 10

    app:
      # To roll back, point this at an immutable sha tag — see section 5.
      image: ghcr.io/<your-org>/shelve-app:production
      restart: unless-stopped
      logging: *default-logging
      depends_on:
        postgres:
          condition: service_healthy
      ports:
        # Loopback ONLY. A plain "${APP_PORT}:3000" binds 0.0.0.0, and Docker's
        # iptables rules bypass UFW/firewalld — a firewall deny rule does NOT
        # protect it. Only the reverse proxy should be able to reach this.
        - "127.0.0.1:${APP_PORT}:3000"
      env_file: ./app/.env

    migrate:
      image: ghcr.io/<your-org>/shelve-migrate:production
      profiles: ["tools"]
      logging: *default-logging
      depends_on:
        postgres:
          condition: service_healthy
      env_file: ./app/.env
      working_dir: /app/apps/shelve
      command: ["pnpm", "run", "db:migrate"]

  volumes:
    postgres-data:
  ```

- `/opt/docker/shelve/app/.env` — real runtime secrets (section 4), `chmod 600`.
- Reverse proxy config (nginx, Caddy, Traefik — whatever your company
  standardizes on) fronting `127.0.0.1:${APP_PORT}` with TLS.

## 3. Bugs already found and fixed in this fork — do not reintroduce them

These are the actual mistakes made while building this, in the order they
were found. If you're setting this up fresh, the current `Dockerfile` /
`deploy.yml` / `nuxt.config.ts` in this repo already have the fixes — this
section exists so you know **why** they look the way they do, and don't
"simplify" them back into a broken state.

### 3.1 The PGlite trap

**Symptom:** container healthy, app serves the SPA shell fine, but every API
call 500s with `ENOENT: no such file or directory, mkdir '.../pglite'`.

**Why:** `@nuxthub/core` picks its DB driver by checking for
`POSTGRES_URL` → `POSTGRESQL_URL` → `DATABASE_URL` **at build time**, falling
back to the embedded PGlite database if none are present. A CI build with no
database URL visible compiles PGlite permanently into the image; no runtime
env var fixes it after the fact, because the decision already happened
during `nuxt build`.

**Fix in this repo:** `apps/shelve/nuxt.config.ts` sets `hub.db.driver`
explicitly via a build-time marker flag (see 3.3) instead of relying on env
detection, so the choice is made deliberately rather than falling through to
whatever happened to be in the build environment.

### 3.2 Setting a placeholder `DATABASE_URL` seemed like the fix — it wasn't

**What was tried first:** pass a fake `DATABASE_URL` build-arg
(`postgresql://build:build@localhost:5432/build`) purely to make step 3.1's
env-detection pick `postgres-js` instead of falling back to PGlite.

**Why it broke everything anyway:** `@nuxthub/core`'s `setupDatabaseClient()`
does not just use a present `DATABASE_URL` to pick a driver — it **hard-codes
that exact value as a literal string** into the compiled server's DB client,
permanently. It only generates a _live_ `process.env.DATABASE_URL` lookup
(its own comment calls this "lazy env resolution for Docker/multi-deploy
scenarios") when the resolved connection URL is **empty** at build time. Every
image built with the placeholder shipped with
`postgresql://build:build@localhost:5432/build` as its real, permanent
runtime connection target — completely deaf to whatever real `DATABASE_URL`
the host's `compose.yml` set. This is what caused silent 500s on every
DB-touching endpoint (OTP send included), with **zero error logging**,
because the failure happened before any of the app's own logging code ran.

**Fix in this repo:** the Dockerfile passes `NUXT_HUB_DB_DRIVER=postgres-js`
— a **plain marker flag, deliberately not shaped like a connection string** —
and `nuxt.config.ts` reads that to set `hub.db.driver` directly. The actual
`DATABASE_URL`/`POSTGRES_URL`/`POSTGRESQL_URL` env vars stay completely unset
during the build, so `@nuxthub/core` falls back to generating the live
lookup. **Never set a real-looking `DATABASE_URL` at build time again** —
even a fake one gets baked in as if it were real.

**How to verify this is still correct**, if you ever touch this again:

```bash
docker build --target runner -t shelve-verify .
docker run --rm --entrypoint sh shelve-verify -c \
  "cat .output/server/node_modules/@nuxthub/db/db.mjs"
```

You want to see `process.env.POSTGRES_URL || process.env.POSTGRESQL_URL ||
process.env.DATABASE_URL` in that file. If you instead see a literal
`postgres://...` string, the build baked in a fake connection and every
deployed container will silently fail every DB call.

### 3.3 Turborepo silently drops env vars it doesn't know about

**Symptom:** passed `NUXT_HUB_DB_DRIVER=postgres-js` as a Docker build-arg,
confirmed it was set as an `ENV` in the Dockerfile — and the build still
logged `hub:db using postgresql database with pglite driver`, as if the var
were never set.

**Why:** the actual build command is `pnpm run build:app`, which runs through
**Turborepo**. Turbo filters environment variables for cache correctness —
any var not explicitly listed in `turbo.json`'s `build` task `env` array is
stripped before the underlying `nuxt build` process ever sees it, even
though it's genuinely present in the shell.

**Fix:** `turbo.json`'s `build.env` array must list every custom env var
your build depends on. This repo's list currently includes
`NUXT_HUB_DB_DRIVER`, `SKIP_ENV_VALIDATION`, `NUXT_PRIVATE_RESEND_API_KEY`,
`DATABASE_URL`, and the full set of `NUXT_PRIVATE_*`/`NUXT_OAUTH_*` vars. **If
you ever add a new build-time env var to the Dockerfile, add it here too, or
it will silently do nothing.**

### 3.4 `applyMigrationsDuringBuild` — one flag, two conflicting needs

**Symptom (attempt 1 of the fix):** disabling build-time migrations
unconditionally (to stop the Docker build from trying to connect to the fake
placeholder and failing with `ECONNREFUSED`) broke the CI **Tests** job
instead — `@nuxt/test-utils`'s e2e tests also do a real build (against
PGlite, no `DATABASE_URL` in that job), and that build-time migration step is
exactly what creates the schema those tests seed against. Disabling it there
made every test's `seed()` call 500 with `relation "users" does not exist`.

**Fix:** the flag is conditional on the same `NUXT_HUB_DB_DRIVER` marker —
`false` (skip) only for the real Docker build, `true` (apply) for local/test
builds using PGlite. Real production migrations never run via this flag at
all; they run separately, deliberately, via the one-off `migrate` container
(section 5) — this flag only controls whether `nuxt build` _itself_ tries to
touch a database, which it should never do in the Docker build (nothing to
connect to) and always should in a local/test build (PGlite needs seeding).

### 3.5 `SKIP_ENV_VALIDATION` silently breaks the login page

**Symptom:** every page reading `useAppConfig().auth` (login, invite, CLI
authorize) crashed client-side with `Cannot read properties of undefined
(reading 'isGithubEnabled')`.

**Why:** `apps/shelve` is `ssr:false` — a pure SPA. `nuxt.options.appConfig`
is computed **once, at build time**, and baked into the client bundle
forever; there is no per-request server render to compute it lazily later.
The app's own `@shelve/auth` module (`apps/shelve/modules/auth/index.ts`)
returns early, without ever setting `appConfig.auth`, whenever
`SKIP_ENV_VALIDATION` is set — which the Dockerfile sets deliberately,
because the CI/Docker build environment legitimately has none of the real
production secrets (`NUXT_SESSION_PASSWORD`, etc.) the strict schema
requires. That left `auth` permanently `undefined` in every image, and
`login.vue` destructures `auth: { isGithubEnabled, ... }` straight off
`useAppConfig()` at the top of its `setup()`.

**Fix:** the early-return branch in `apps/shelve/modules/auth/index.ts` now
still assigns `appConfig.auth`, computed leniently from raw `process.env`
presence checks instead of the strict schema.

**This is a real, general lesson for anything you add later:** any Nuxt
module that writes to `nuxt.options.appConfig` in a `ssr:false` app must
**always** produce a complete object, on every code path, including
early-return/error paths — a partially-set or unset `appConfig` key isn't a
"missing feature," it's a guaranteed client-side crash for anyone who reads it.

### 3.6 Feature-availability flags need a build-time signal too, not just runtime

**Symptom:** even after fixing 3.5, the OTP/email login form didn't render
at all — no crash, just nothing.

**Why:** `login.vue` gates the entire email form behind
`v-if="isEmailEnabled"`, and that flag is computed from
`NUXT_PRIVATE_RESEND_API_KEY`'s _presence_ at the same build time as 3.5 —
not at runtime. The Dockerfile never passed one, so it baked to `false`.

**Fix:** the Dockerfile passes a **build-time-only placeholder**,
`NUXT_PRIVATE_RESEND_API_KEY=re_build_placeholder`. This is safe: it's never
used to actually send anything (that happens at runtime, server-side, using
whatever real key the host's `.env` sets), and it never leaves the build
stage. It only exists to flip a boolean baked into the client bundle. If you
enable GitHub/Google OAuth later, you'll need the same treatment for
`NUXT_OAUTH_GITHUB_CLIENT_ID`/`NUXT_OAUTH_GITHUB_CLIENT_SECRET` (and Google's
equivalents) or those login buttons won't appear either — a placeholder
client ID/secret pair is enough to flip the flag; the real pair still has to
be set at runtime for the OAuth flow to actually work.

**Consequence worth stating plainly:** the image is opinionated about which
login methods exist. Every build with the Resend placeholder bakes
`isEmailEnabled = true`, so a deployment that configures OAuth only at runtime
will still render the email/OTP form — and every OTP send will 500 because
there's no real Resend key behind it. The runtime `.env` must match the
build-time placeholders. If you need different auth mixes for different
deployments, build one image variant per mix; there is no way to turn a baked
flag off at runtime.

### 3.7 The Vercel BotID warning is noise, not an error

You will see this in `docker compose logs app` on every protected `POST`:

```
Possible misconfiguration of Vercel BotId.
Ensure that the client-side protection is properly configured for 'POST <endpoint>'.
```

This is harmless off Vercel. `server/utils/auth.ts`'s `requireHuman()` passes
`developmentOptions: { isDevelopment: process.env.VERCEL_ENV !== 'production',
bypass: 'HUMAN' }` — since `VERCEL_ENV` is unset on any non-Vercel host, this
always takes the dev-bypass path and returns "human" without ever throwing.
Confirmed by reading the `botid` package source directly: the bypass check
happens before any code path that could throw. **Do not** try to "fix" this
by stripping the `botid/nuxt` module — it isn't broken, it's just noisy.

## 4. Required environment variables

### 4.1 Build-time only (Docker build-args, set in `deploy.yml`)

| Var                           | Value                                      | Why it's needed at build time specifically                                                                                          |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_PUBLIC_GITHUB_APP_NAME` | your GitHub App's name, or blank           | `ssr:false` bakes all `NUXT_PUBLIC_*` into the client bundle at build time; it's never read at runtime                              |
| `NUXT_HUB_DB_DRIVER`          | `postgres-js`                              | Marker flag only (§3.2/3.3) — selects the driver without touching the real connection string                                        |
| `NUXT_PRIVATE_RESEND_API_KEY` | `re_build_placeholder`                     | Placeholder only (§3.6) — flips `isEmailEnabled` in the baked client config; never used to send anything                            |
| `SKIP_ENV_VALIDATION`         | `true` (Dockerfile `ENV`, not a build-arg) | The build environment has none of the real secrets the strict schema demands; see §3.5 for the crash this alone doesn't fully solve |

### 4.2 Runtime only (host's `.env`, real secrets — never put these in the repo or CI)

| Var                                       | Notes                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` **and** `POSTGRES_URL`     | Set both to the same value, pointing at the `postgres` compose service, **not** `localhost`. `@nuxthub/core` checks `POSTGRES_URL` first (§3.1); setting both means the driver resolves identically wherever the lookup happens                                                        |
| `NUXT_SESSION_PASSWORD`                   | ≥32 chars                                                                                                                                                                                                                                                                              |
| `NUXT_PRIVATE_ENCRYPTION_KEY`             | ≥32 chars. **This is the KEK that seals every project's secrets. It cannot be rotated (no rotation feature exists yet). Losing it makes every stored secret permanently unreadable — back it up offline, separately from database dumps, before you consider this deployment "live."** |
| `NUXT_PRIVATE_ADMIN_EMAILS`               | Comma-separated; whoever signs up with one of these becomes admin                                                                                                                                                                                                                      |
| `NUXT_PRIVATE_ALLOWED_ORIGINS`            | Comma-separated URLs                                                                                                                                                                                                                                                                   |
| `NUXT_PRIVATE_RESEND_API_KEY`             | The **real** key this time — used server-side for actual sending                                                                                                                                                                                                                       |
| `NUXT_PRIVATE_SENDER_EMAIL`               | Must be on a domain verified in your Resend account. An unverified Resend account can only send to the account owner's own address — if OTP emails silently never arrive, check this first                                                                                             |
| `NUXT_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` | Optional — only if you want GitHub login (needs the build-time placeholder too, §3.6)                                                                                                                                                                                                  |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | Optional — same caveat                                                                                                                                                                                                                                                                 |

## 5. Deploy flow — exact commands

### One-time GitHub setup

- Repo variable (Settings → Actions → Variables): `NUXT_PUBLIC_GITHUB_APP_NAME`.
- Repo secrets (Settings → Actions → Secrets), for the SSH deploy step in
  `deploy.yml`: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `VPS_PORT`
  (optional, defaults 22), `SSH_PASSPHRASE` (optional), `VPS_APP_DIR` (e.g.
  `/opt/docker/shelve`).
- `GITHUB_TOKEN` is automatic — used to push to GHCR.

### On the host, first time only

Two things about the deploy user before anything else, both of which bit the
first deployment:

- **`VPS_USER` must own `/opt/docker/shelve`** (or at minimum be able to read
  `compose.yml`, `.env`, and the `chmod 600` `app/.env`) **and** be in the
  `docker` group. If the directory was created as root and CI connects as
  someone else, `docker compose` fails with `permission denied` on `env_file`
  and the workflow goes red on the very first `pull`.
- **The same user must do the GHCR login below.** The credential lands in
  that user's `~/.docker/config.json`; a login as root does nothing for a
  deploy user, and vice versa. CI logs in on its own during the SSH step
  (with `GITHUB_TOKEN`), but a manual pull needs a real login on the box.

```bash
mkdir -p /opt/docker/shelve/app
# create compose.yml (section 2), .env, and app/.env (section 4.2) here; chmod 600 app/.env
cd /opt/docker/shelve

# The images are private. Without this, `docker compose pull` fails with
# "denied". Use a classic PAT scoped to read:packages only — never a token
# with write scope on the host.
echo "$GHCR_READ_PAT" | docker login ghcr.io -u <github-user> --password-stdin

docker compose pull
docker compose up -d postgres
# wait for postgres healthcheck, then apply the schema for the first time:
docker compose --profile tools run --rm migrate
docker compose up -d app
```

### Every subsequent deploy (this is what `deploy.yml`'s SSH step already runs)

```bash
cd /opt/docker/shelve
docker compose pull
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose up -d app
docker image prune -f
```

Order matters: `postgres` up (and healthy) **before** `migrate`, and
`migrate` completing **before** `app` restarts — the app assumes the schema
it needs already exists.

### Rolling back

`deploy.yml` tags every image twice: the moving `:production` tag the compose
file references, and an immutable `:sha-<commit>` tag. That second tag is the
rollback mechanism. On the host:

```bash
cd /opt/docker/shelve
# find the last good commit's short sha, then:
sed -i 's|shelve-app:production|shelve-app:sha-<good-sha>|' compose.yml
docker compose up -d app
```

Swap it back to `:production` once a fixed build has shipped, or the next CI
deploy will silently leave you pinned.

**Migrations do not roll back.** If the bad deploy shipped a schema change,
swapping the image alone leaves a newer schema under an older app — restore
the database from the pre-deploy dump (section 6.2) or roll forward with a
fix instead. This is the reason to take a `pg_dump` immediately before any
deploy that includes new files under `server/db/migrations/`.

### Verifying a deploy actually worked

```bash
# 1. No PGlite anywhere (see §3.1 if this isn't empty)
docker compose logs app --tail=100 | grep -i pglite

# 2. Confirm the compiled DB client reads env at runtime, not a baked literal (see §3.2).
#    Do NOT check this with `docker compose exec app env | grep DATABASE_URL`:
#    §3.2 is precisely the case where that var is present and ignored, so a
#    green result there proves nothing.
docker compose exec app grep -oE 'process\.env\.POSTGRES_URL[^;]*|postgres(ql)?://[^"'"'"']+' \
  .output/server/node_modules/@nuxthub/db/db.mjs
# expect: the `process.env.POSTGRES_URL || ...` chain.
# any literal postgres:// URL here is the §3.2 bug — every DB call will fail silently.

# 3. Confirm the schema actually matches what the app expects
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d users"

# 4. The real functional test
curl -i -X POST http://127.0.0.1:<APP_PORT>/api/auth/otp/send \
  -H "Content-Type: application/json" \
  -d '{"email":"you@yourcompany.com"}'
# expect: HTTP 200, {"success":true,"message":"OTP sent successfully"}
```

If step 4 500s with no useful message, check `docker compose logs app
--tail=50` immediately after — `server/services/resend.ts` logs the real
Resend error right before re-throwing it as a generic "Failed to send OTP".
`server/api/auth/otp/send.post.ts`'s outer catch does **not** log anything
before its own generic 500, so a failure _earlier_ in the request (DB writes
in `generateOTPForEmail`/`handleEmailUser`) will produce total silence in
the logs — that silence is itself informative: it means the problem is
before the email step, most likely §3.2.

## 6. Still not done — do these before calling this production

1. **Back up `NUXT_PRIVATE_ENCRYPTION_KEY` offline, separately from database
   dumps.** This is the one step that is unrecoverable if skipped — do it
   before real company data goes into this.
2. Set up nightly `pg_dump` on a timer, sent offsite, and actually test
   restoring it once into a throwaway database. A backup you haven't
   restored from is a guess, not a backup.
3. Prove the CI → deploy path end-to-end with zero manual steps — every
   deploy so far involved at least one hand-run command on the host.
4. If fronting with Cloudflare: set SSL/TLS mode to **Full (strict)**, and
   confirm the HTTP→HTTPS redirect comes from your own reverse proxy, not
   Cloudflare's edge (`curl -I` against the origin directly, bypassing
   Cloudflare, to check).
5. Decide on GitHub/Google OAuth. If wanted, register OAuth apps, add real
   `NUXT_OAUTH_*` secrets at runtime, and add build-time placeholders for
   them the same way `NUXT_PRIVATE_RESEND_API_KEY` was handled (§3.6) so the
   buttons actually render.
6. GitHub App integration (org-wide secret sync) and the `apps/vault`
   secure-sharing app are both optional, unstarted upstream features —
   `vault` additionally needs Redis/KV, a second image, and a second
   subdomain. Not required for a working self-host.

## 7. Security notes specific to self-hosting a fork

- **This repo may be public.** Never commit real secrets to it — not to
  `deploy.yml`, not to a repo variable, not to a markdown file like this one.
  Real secrets belong in exactly two places: GitHub Actions _secrets_ (not
  _variables_ — variables aren't meant to be sensitive) for anything CI
  needs, and the host's `app/.env` for anything the running container needs.
- The placeholder values in `Dockerfile`/`deploy.yml`
  (`re_build_placeholder`, the old fake `DATABASE_URL` this repo no longer
  uses) are fine to have in a public repo precisely because they are never
  real — don't let that normalize putting a real-looking value there "just
  for now."
- If you fork this again for a second company/deployment, grep the whole
  repo for the literal strings `re_build_placeholder` and
  `NUXT_HUB_DB_DRIVER` before you touch anything — that'll take you straight
  to every place §3.2/3.6 matter.

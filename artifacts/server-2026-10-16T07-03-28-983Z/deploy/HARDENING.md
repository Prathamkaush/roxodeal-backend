# Request protection, caching, and lean deployment

Redis is required for distributed abuse protection. Counters and expiry are updated atomically with Lua, so limits are shared across API instances and concurrent requests. If Redis is unavailable, protected requests return 503; quotas never silently reset into an in-memory fallback. Health checks, signed payment webhooks, and immutable public-image GETs are exempt from visitor quotas. Webhooks still verify the gateway signature. Limit responses use HTTP 429, `Retry-After`, a JSON `retryAfter` in seconds, and `Cache-Control: no-store`.

| Operation | Default budget |
| --- | --- |
| Traffic, before authentication | 600 requests/minute/IP |
| Requests after authentication | 300/minute/account (public traffic: per IP) |
| Writes | 60/minute/account (public writes: per IP) |
| Authentication | 30 attempts/15 minutes/IP; 15/15 minutes/email or phone |
| Verification/reset email requests | One/minute and five/hour/email, separately per purpose |
| Requirements, across both creation routes | 10/hour and 30/day/account |
| Enquiries and product quotes combined | 30/hour and 100/day/account; one request/10 seconds to the same seller |
| Enquiry responses | 60/hour/account |
| Product creation | 30/hour/account |
| Claim/protection creation combined | 10/hour/account |
| Private/public file uploads combined | 20/15 minutes/account |
| Payment-order creation | 20/15 minutes/account |
| Lead unlocking | 30/15 minutes/account |
| Contact/newsletter | Five/hour/IP, separately per endpoint |
| Feedback/reviews | Ten/hour/account, separately per endpoint |

The `RATE_*` settings documented in `.env.example` override the main budgets. Keep the API bound to loopback behind Nginx. Set `TRUST_PROXY=1` only for that single trusted reverse proxy, so the IP limiter uses the client address without trusting arbitrary forwarding headers from direct clients. Case variants and trailing slashes share the same policy. Invalid submissions also consume quota.

## Data caching

All buyer, seller, and admin list pages that use `/workspace` share the backend cache automatically. Cache keys contain a hash of the authenticated user ID, role, URL and sorted query parameters. Private data is never shared between accounts or sent with a public browser-cache header. Session validity, account activation, and permissions are checked against PostgreSQL on every protected request before the cache is consulted.

Redis cache entries are namespaced by a hash of `DATABASE_URL`, isolating databases and test environments. Set the same explicit `CACHE_NAMESPACE` on replicas if they use different database connection URLs for the same deployment; use a different namespace for every separate application/database environment.

| Response | Redis TTL |
| --- | --- |
| Public catalogue | 30 seconds |
| Products, categories, plans, CMS, public reviews | 60 seconds |
| Buyer/seller/admin workspace, requirements, leads, payments, notifications | 10 seconds |
| Admin lists, KYC details, contact/feedback inbox, `/auth/me` | 15 seconds |
| Business analytics and admin reports | 30 seconds |

Responses larger than 2 MiB are served live rather than filling Redis with oversized snapshots. Concurrent identical misses within an API instance share the pending read. Writes invalidate cached lists across API instances using a new Redis generation, including partial-success errors. Older in-flight reads cannot repopulate the new generation. Old entries expire naturally within 60 seconds; no `KEYS`, Redis flush, or unbounded cache deletion is used.

Authentication tokens, password/OTP operations, payment reconciliation, receipts, health checks and private-file streams are not cached. Private JSON uses `private, no-store`. Public JSON requires HTTP revalidation; Redis handles repeated reads. `X-Cache: HIT`, `MISS`, or `BYPASS` reports cache behavior. Cache storage failures fall back to database reads; a failed invalidation bypasses that API instance's caches for the maximum TTL. Redis rate-protection availability is checked separately and remains required. Out-of-band database changes and background reminders become visible within the relevant TTL.

Uploaded product images use new UUID filenames, one-year immutable public caching, ETag/Last-Modified revalidation, and conditional 304 responses. Missing images use `no-store`. KYC/evidence documents remain private and uncached. Redis stores JSON data, not image bytes. Put a CDN in front of the public image route when deploying globally; never cache `/files/private` in Nginx/CDN rules.

## Smaller server deployment

The multi-stage Docker runtime uses Alpine with Prisma's musl engines, OpenSSL, Sharp and Argon2. The test target compiles the application and runs the regression suite plus real native image conversion and password hash/verification. Runtime keeps compiled JavaScript, production dependencies, Prisma migrations/schema, and the compiled seed. Prisma's CLI remains available for migrations. npm/yarn, development dependencies, source/test files, local diagnostic scripts, secrets, uploads and backups are excluded from runtime. Uploads remain on the existing persistent volume.

Byte-identical Prisma query-engine copies share one native engine through relative symlinks. Incompatible glibc-only optional Sharp binaries are excluded from the musl image. The build compares engine bytes before linking and tests the resulting native libraries; required migration tooling and the database query engine remain included.

From `backend/`, run:

```powershell
npm.cmd run package:server
```

This creates a new `artifacts/server-<timestamp>/` directory and, when the system `tar` command is available, a matching `.tar.gz` upload archive. Both contain only the files needed to build and run the backend on a server. `DEPLOYMENT-CONTENTS.json` lists the contents and size. Copy this bundle instead of the entire development backend. Provision `.env`/`.env.docker` privately on the server; they are never copied into the bundle. Migrate existing uploads through the persistent volume/bind mount separately. The source bundle intentionally excludes repository tests; run `docker build --target test .` from the full repository during CI, then deploy the runtime target.

The existing Compose and immutable-image deployment pipeline remain supported. Inside the lean runtime, use `node dist/main.js`, `node prisma/seed.js`, and `/app/node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma`; npm/yarn are build-time tools. Do not upload `node_modules`, `dist`, backups, or local environment files from your workstation. Keep tests, migrations, backups and development tools locally; excluding them from deployment does not require deleting valuable project or business data.

# Backend Docker and GitHub Actions deployment

Requires Docker Engine/Desktop with Linux containers and Docker Compose 2.24.4+ (`!reset` and optional env files). The frontend continues to run separately. PostgreSQL 17, Redis 7.4, the migration runner and NestJS each run in their own container.

## Local development (PowerShell)

From the backend folder (`cd backend`):

```powershell
node scripts/setup-docker-env.mjs
docker compose --env-file .env.docker -f compose.yml -f compose.dev.yml up -d --build --wait
docker compose --env-file .env.docker -f compose.yml -f compose.dev.yml run --rm --no-deps backend node prisma/seed.js
```

The setup script preserves an existing `.env.docker`; it generates independent random database, Redis and JWT secrets when creating the file. Never commit it. The backend also loads optional SMTP, Razorpay and SMS settings from `backend/.env` (the backend-local `.env`). Compose overrides its DATABASE_URL, REDIS_URL, JWT_SECRET, port and upload paths for container use. `.env.example` files are examples only.

Endpoints:

| Service | Local address |
| --- | --- |
| Backend | http://localhost:4000/api |
| Swagger | http://localhost:4000/api/docs |
| Readiness (PostgreSQL and Redis) | http://localhost:4000/api/health/ready |
| PostgreSQL | 127.0.0.1:15432 |
| Redis | 127.0.0.1:16379 |

Database name/user are `mandisetu`; passwords are in `.env.docker`. Docker services connect internally through `postgres:5432` and `redis:6379`. For a backend running directly on your host, set `backend/.env` (the backend-local `.env`) DATABASE_URL to `postgresql://mandisetu:<POSTGRES_PASSWORD>@127.0.0.1:15432/mandisetu` and REDIS_URL to `redis://:<REDIS_PASSWORD>@127.0.0.1:16379/0`. Do not run the host backend and container backend on the same port.

Buyer and seller login requires email verification in every environment. Configure SMTP before registration testing. SMS OTP functions are retained but disconnected from active authentication routes. Redis supports authentication rate limits, view deduplication and readiness. OTP challenges, revocable sessions and notification delivery jobs persist in PostgreSQL. See [the integration guide](../../BACKEND-INTEGRATION.md) for service configuration and the full verification workflow.

```powershell
# View status/logs; stop without removing stored data.
docker compose --env-file .env.docker -f compose.yml -f compose.dev.yml ps
docker compose --env-file .env.docker -f compose.yml -f compose.dev.yml logs --tail=100 backend
docker compose --env-file .env.docker -f compose.yml -f compose.dev.yml stop
```

Named volumes persist PostgreSQL, Redis AOF data and uploads. Do not use `down -v` on development or production data. Passwords initialize PostgreSQL on the first start; changing .env.docker does not change credentials in an existing database volume. Update database credentials deliberately when rotating them.

## Migrations and seed data

`migrate` applies committed Prisma migrations before the API starts. Future schema changes must include a generated and reviewed migration under `prisma/migrations/` in this backend project. Use `prisma migrate dev` against a development database, then commit the generated SQL. Do not use `db push` for production deployments.

If an existing database was created with `db push`, verify it matches the baseline schema and back it up before marking `20261009000000_initial` applied with `prisma migrate resolve --applied 20261009000000_initial`. Do not apply the initial CREATE TABLE migration over an existing populated schema.

Seeding is explicit and repeatable; it creates categories and plans. To create the first production admin, put ADMIN_EMAIL, ADMIN_PHONE and a password of at least 12 characters in the VPS `backend/.env` (the backend-local `.env`), then run the seed command with the production Compose files. Remove bootstrap credentials afterward. No default admin password is shipped.

## Pipeline behavior

[.github/workflows/backend.yml](../../.github/workflows/backend.yml) runs for backend-related pull requests, pushes to `main`, and manual dispatches. It:

1. Builds the Docker test stage and runs TypeScript checks and backend unit tests.
2. Starts an isolated PostgreSQL/Redis/backend stack, applies migrations and seeds it.
3. Checks readiness and runs isolated PostgreSQL integration tests for email verification, role authorization, concurrent five-slot lead purchases, private documents, signed payment webhooks, protected claims, CMS/report access and session/reset behavior. SMTP uses a local test server; email authentication makes no SMS calls. It also verifies Redis outage handling and reconnection without restarting the API.
4. On `main`, publishes the tested runtime image to `ghcr.io/<owner>/<repository>-backend:<commit SHA>` using GITHUB_TOKEN.
5. If ENABLE_DEPLOY is `true`, deploys the immutable image digest to the VPS over SSH.

GitHub Actions only removes its own disposable CI volumes. Fork pull requests do not publish or deploy. Images currently target Linux amd64, matching the hosted runner; adapt the build for an ARM VPS.

## Prepare your Ubuntu VPS once

Install Docker Engine and the Compose plugin from Docker's Ubuntu instructions. Give the deployment account Docker access. Provision `/srv/mandisetu/backend` owned by that account, and upload `compose.yml`, `compose.prod.yml`, `scripts/setup-docker-env.mjs`, and `deploy/backend-deploy.sh` with the same folder structure. Run `node scripts/setup-docker-env.mjs` once in that directory (requires Node.js), or securely provision `.env.docker` from the example with newly generated secrets. Set WEB_ORIGINS to the three exact frontend HTTPS origins, separated by commas. Configure a public API hostname, Nginx/TLS, frontend NEXT_PUBLIC_API_URL, reset-link origins, TRUST_PROXY=1 and PUBLIC_FILE_BASE_URL as described in the integration guide.

```bash
cd /srv/mandisetu/backend
mkdir -p /srv/mandisetu/uploads/private /srv/mandisetu/uploads/public
sudo chown -R 1000:1000 /srv/mandisetu/uploads
chmod 700 /srv/mandisetu/uploads/private
chmod 600 .env.docker
# Provision .env separately for SMTP, Razorpay, SMS and admin bootstrap.
```

The image runs as UID 1000. Public uploads remain readable by Nginx; private uploads are served only through authorized NestJS routes. The API is bound to host loopback port 4000. Production PostgreSQL and Redis publish no host ports. Use the supplied Nginx configuration with HTTPS; keep the frontend process separate. Stop the old backend PM2 process before the first Docker deployment to free port 4000.

If the GHCR package is private, authenticate Docker **on the VPS deployment account** with a token that can read the package (and has required organization access):

```bash
read -rsp 'GHCR token: ' ghcr_token; echo
printf '%s' "$ghcr_token" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
unset ghcr_token
```

Configure the following GitHub repository/environment settings:

| Type | Name | Value |
| --- | --- | --- |
| Secret | SSH_HOST | VPS hostname/IP |
| Secret | SSH_USER | Deployment account |
| Secret | SSH_PRIVATE_KEY | Private deploy key |
| Secret | SSH_KNOWN_HOSTS | Verified VPS SSH host key line(s); use `[host]:port` for a custom port |
| Variable | SSH_PORT | Optional, defaults to 22 |
| Variable | DEPLOY_PATH | Optional, defaults to /srv/mandisetu/backend; absolute path with letters, digits, underscores, hyphens and slashes |
| Variable | ENABLE_DEPLOY | `true` after VPS provisioning |

The workflow uses the GitHub `production` environment. GITHUB_TOKEN is automatic; allow package publishing in repository settings. Verify the VPS SSH host key out of band before storing SSH_KNOWN_HOSTS. Deployment uses strict host verification.

The deploy script pulls the published image, waits for PostgreSQL and Redis, runs migrations, replaces the API container and waits for readiness. A failed migration stops before replacing the existing API. A readiness failure fails the job; database changes are not automatically rolled back. Back up before migrations and keep schema changes compatible with the previous API during deployment. Successful deployments record their image digest in private `.env.release`.

After the first deploy, seed once:

```bash
docker compose --env-file .env.docker --env-file .env.release -f compose.yml -f compose.prod.yml run --rm --no-deps backend node prisma/seed.js
```

Use both env files for subsequent production status/restart/backup commands; `.env.release` selects the deployed image instead of the local development tag.

## Backups

Back up PostgreSQL through its container and separately archive `/srv/mandisetu/uploads`. Copy backups to another server/location; Redis persistence is not a substitute for PostgreSQL backups.

```bash
cd /srv/mandisetu/backend
umask 077
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file .env.docker --env-file .env.release -f compose.yml -f compose.prod.yml exec -T postgres sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "backups/database-$stamp.dump"
tar -czf "backups/uploads-$stamp.tar.gz" -C /srv/mandisetu uploads
# Copy both artifacts off-server and periodically rehearse a restore.
```

References: [Docker startup health dependencies](https://docs.docker.com/compose/how-tos/startup-order/), [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [GitHub container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry/), [Redis Node.js client](https://redis.io/docs/latest/develop/clients/nodejs/connect/).

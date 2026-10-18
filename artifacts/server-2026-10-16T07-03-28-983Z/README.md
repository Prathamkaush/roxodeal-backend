# Backend

Independent NestJS project with its own dependencies and lockfile. API source, authentication, payments and private-file handling are in `src/`. Prisma schema and migrations are in `prisma/`, Docker configuration is here, and deployment files are in `deploy/`.

Request quotas, cache TTLs/invalidation, image caching, and the `npm.cmd run package:server` deployment bundle are documented in [deploy/HARDENING.md](deploy/HARDENING.md). Redis-backed protection and user-scoped list caching apply to all three frontends.

From the project root:

```powershell
Copy-Item backend/.env.example backend/.env
# Set DATABASE_URL and JWT_SECRET in backend/.env.
npm.cmd run db:generate
npm.cmd run db:push
npm.cmd run db:seed
npm.cmd run dev:api
```

API: `http://localhost:4000/api`; Swagger: `http://localhost:4000/api/docs`.
See the root README for the current API foundation's scope and pending live integrations.

For Docker PostgreSQL, Redis, backend containers and the GitHub Actions deployment pipeline, follow [deploy/DOCKER.md](deploy/DOCKER.md). From this folder, production migrations use `npm.cmd run db:migrate` with committed migrations rather than `db:push`.

## Buyer support, reviews, and direct requests

Migration `20261015000000_buyer_requests_feedback` adds direct-request kind/quantity fields plus contact and feedback storage. Run `npm.cmd run db:migrate`, `npm.cmd run db:generate`, then `npm.cmd run build` before restarting the API. Stop the API first on Windows if its Prisma DLL is locked during generation.

- `POST /api/contact`: public, validated and rate limited; returns a saved message reference.
- `POST /api/feedback`: signed-in private feedback.
- `POST /api/reviews`: buyer rating/review, upserted once per buyer and target.
- `GET /api/reviews`: paginated public reviews; optional `sellerId` or `productId` filters, public author name/city only. No filter returns marketplace reviews.
- `GET /api/admin/contact-messages` and `GET /api/admin/feedback`: admin-only inboxes, newest 100 records. Contact messages are stored for the support team; submission does not automatically email a response.
- `ENQUIRY_CREATE` workspace action: `kind=QUOTE` requires the chosen seller's active product and a positive integer quantity; `kind=ENQUIRY` handles general questions. Only the targeted seller receives the notification. These actions do not create marketplace leads.
- `NOTIFICATION_DELETE` workspace action: deletes the given ID only when owned by the signed-in user.

`npm.cmd test` includes direct-request validation, notification ownership, private/public feedback separation, and review privacy regression tests.

## Buyer requirement lifecycle

Migration `20261015010000_buyer_requirement_lifecycle` adds `Lead.deletedAt`. `BUYER_LEAD_STATUS` accepts Closed or Fully Sold for an owned requirement; it cannot approve pending leads. `BUYER_LEAD_DELETE` closes and archives the owned requirement. Archived requirements are omitted from buyer/admin lists and new supplier discovery; previous purchases and transaction records remain intact. New contact unlocks retain their capacity limit but no longer change buyer fulfilment status.

For a Docker-backed localhost API, rebuilding `dist/` on Windows does not update the running container. Rebuild the backend/migrate image, apply migrations, and recreate the backend service through the existing Compose configuration. Notification deletion must appear in the active container's action validator, not only in local source.

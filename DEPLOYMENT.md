# Render deployment preparation

Create a separate V2 web service from this repository first. Do not replace the existing V1 service or change its database settings during initial deployment.

- Build command: `npm ci`
- Start command: `npm run start:v2`
- Health check: `/healthz`
- Environment: `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, and `V2_DATABASE_HOST`.
- Set `DATABASE_URL` to the existing V2 branch connection string, and `V2_DATABASE_HOST` to that URL's exact hostname. Use the existing V2 signing secret or a dedicated hosted secret. Secrets belong in Render environment settings, never Git.
- Render supplies `PORT`; hosted V2 preserves it.

The V2 schema has already been applied to its Neon branch. Future migrations use `npm run migrate:v2` with the same hosted configuration.

Before changing the live employee portal, reconcile any V1 attendance or employee changes made since the V2 database branch was created. V1 and V2 do not synchronize automatically. Keep the V2 opening balances and payroll records when planning that transition.

Existing uploaded payslip files live on disk, outside PostgreSQL. A new service does not automatically inherit V1's uploaded files. Durable upload storage must be configured if using file uploads in the hosted V2 service.

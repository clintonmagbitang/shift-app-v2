# Render deployment preparation

Create a separate V2 web service from this repository first. Do not replace the existing V1 service or change its database settings during initial deployment.

- Build command: `npm ci`
- Start command: `npm run start:v2`
- Health check: `/healthz`
- Environment: `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, and `V2_DATABASE_HOST`.
- Set `DATABASE_URL` to the existing V2 branch connection string, and `V2_DATABASE_HOST` to that URL's exact hostname. Use the existing V2 signing secret or a dedicated hosted secret. Secrets belong in Render environment settings, never Git.
- Render supplies `PORT`; hosted V2 preserves it.

The V2 schema has already been applied to its Neon branch. Future migrations use `npm run migrate:v2` with the same hosted configuration.

The payroll worksheet and dated-rate release requires migration `004_pay_rates.sql` before deploying. It adds a rate-history table and captures existing rates as the baseline without changing payroll snapshots or ledger entries. Rate changes are saved through the dated-rate action in employee profiles. Every payroll workday uses its effective rate; existing finalized snapshots remain immutable. Earlier rate changes that were never recorded cannot be reconstructed automatically.

The worksheet and individual forms use the same draft/finalize routes. Saves include the revision returned by preview to reject stale edits. Reload forms opened before this release before saving. Worksheet batch actions save each employee independently and report failures on the affected row; successful employees remain saved. Reference and remarks columns can be expanded in the worksheet.

The prospective deduction release requires `005_withholding_defaults.sql`. This migration only creates the defaults table. Defaults begin September 2026 or later and only prefill unsaved payrolls; all existing drafts and finalized records retain their values. Each SSS/PhilHealth/Pag-IBIG default has a first/second/both-half schedule and remains in force until a newer effective entry. The amount is per selected half. Vale defaults to the positive cutoff balance capped at 1,000; loan defaults to the saved amount for the immediately preceding cutoff (zero if none exists). Both balances are shown inclusive of cutoff-date ledger entries, including posted payroll repayments.

Both payroll pages autosave edited fields through `/admin/payroll-fields`, merging against the latest draft under the same payroll lock. They refresh changed records on tab focus and at eight-second intervals when idle. Finalized records reject autosave. Opening or refreshing a payroll does not create or change a draft. Full finalization still uses a revision check. Defaults-page changes do not update payroll records.

Before changing the live employee portal, reconcile any V1 attendance or employee changes made since the V2 database branch was created. V1 and V2 do not synchronize automatically. Keep the V2 opening balances and payroll records when planning that transition.

Existing uploaded payslip files live on disk, outside PostgreSQL. A new service does not automatically inherit V1's uploaded files. Durable upload storage must be configured if using file uploads in the hosted V2 service.

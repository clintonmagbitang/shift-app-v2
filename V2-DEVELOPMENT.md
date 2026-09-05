# Shift App V2

The local V2 app runs at http://localhost:4001 using the separate Neon branch `shift-app-v2-dev`. The original `.env` is unchanged. `.env.v2` is ignored by Git.

## Running

- `npm run migrate:v2` applies the ordered migrations to the development endpoint.
- `npm run start:v2` starts the V2 app.
- The V2 scripts refuse the same database hostname as `.env`, including pooled hostname variants.

## Features

- Advances and Loans: admin entry, dated debits and credits, references, remarks, running balances, safe submission retries, and employee ownership enforced by the API.
- Payroll: manual advance/loan deductions, tax, SSS, PhilHealth, Pag-IBIG, other deductions, signed additional adjustment, bank reference, and remarks.
- Draft saving does not post to ledgers. Finalization calculates net pay on the server and saves an immutable daily snapshot, then posts both repayments atomically.
- Finalized payroll must be unlocked before editing. Unlock removes only its linked payroll postings and changes its snapshot status to draft in the same transaction. Re-finalization posts the revised deductions once. Concurrent finalizations serialize by employee and cutoff.
- Employee `payslip.html` and `payslips.html` share the payroll layout and JavaScript. All payroll fields are disabled, employee selection is hidden, and save/finalize/unlock actions are unavailable. The server forces employee ownership and serves only finalized snapshots.
- Previous payroll records and uploaded payslips remain at `uploaded_payslips.html`. V1 payroll records are not automatically migrated into V2 snapshots or ledger postings.

## Verification

`npm test` checks API permissions, input validation, and safe retry/error behavior with a stub database.

With the development server running:

- `node scripts/verify-v2.js`: persisted advance/repayment and employee access checks.
- `node scripts/verify-loans-v2.js`: equivalent loan checks.
- `node scripts/verify-payroll-v2.js`: disposable unused 2099 cutoff; draft, net calculation, manual deductions, concurrent finalization, both postings, employee isolation, unlock/refinalize, and transaction rollback checks.

Integration scripts remove only their disposable test transactions. All three integration checks passed on the development branch. Browser checks verified payroll rendering and disabled payslip controls.

## Behavior to know

Existing attendance and cutoff computation is reused. Historical V1 payroll remains separate. Negative ledger balances represent employee credits; there is no repayment cap. Manual ledger entries cannot be edited or deleted through the UI; corrections use a compensating entry with a reference. Payroll-linked entries are removed on unlock. V2 payslips use the web layout; the existing legacy PDF endpoint remains for previous payroll records.

## Opening balances

Advances and Loans each accept one opening balance per employee as of close of business April 30, 2026, including zero or a negative employee credit. Opening entries cannot be overwritten; later corrections are separate dated transactions. An unset opening balance is clearly labeled in the admin form; totals then reflect only entered transactions.

Manual ledger transactions start May 1, 2026. Payroll ending on or before April 30 saves its deductions in the payslip without posting them to the ledgers. May-onward payroll posts normally. Cutoffs that straddle April 30 are rejected. Payroll selectors include May 2026 onward.

`node scripts/verify-openings-v2.js` verifies opening balances, retries, zero balances, employee permissions, and April/May posting behavior using disposable development records. It passed and removed its fixtures; actual opening balances still need to be entered by the admin.

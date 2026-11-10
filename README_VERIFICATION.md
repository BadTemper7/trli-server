## Billing stage and VAT follow-up

Refer to `../docs/BILLING_COLLECTION_CORRECTIONS.md`. The protected admin endpoint `POST /api/admin/invoices/:id/refresh-unpaid` is used only for repricing an **unpaid** Gate-in invoice and never modifies payment-submitted/verified/legacy VAT-inclusive invoices. New Gate-out invoices use currently active rates except original BOTH-stage allocations carried from the Gate-in invoice. No migration is required for this follow-up.

# VAT-exclusive rate update (November 6, 2026)

- New configured rates are **net of VAT**. Example: PHP 3,800 base + PHP 456 VAT (12%) = PHP 4,256 due.
- Existing issued invoice and payment snapshots are not rewritten. Issued `vatInclusive: true` invoices retain their original totals and print as VAT-included.
- `npm run migrate:vat-exclusive` is a **dry-run** settings-only check. With a backup, use `npm run migrate:vat-exclusive -- --apply` to update `sitesettings.tax.vatInclusive` to false. It does not change rate amounts or invoice records.
- Deploy all three apps together. Review mixed VATable/exempt charges, stage splits, manual rates, printed invoices/receipts and proof approval on staging.
- Source QA: backend tests and JS syntax checks; Vite production builds and live MongoDB/invoice verification require staging.

# Payment proof-only 409 verification note

- `npm run migrate:payment-evidence` is a read-only preview. It reports `paymentsubmissions` reference index definitions, an index migration plan and checks for duplicate *real* active references.
- After backing up and stopping payment writes, use `npm run migrate:payment-evidence -- --apply` to replace an obsolete `(method, reference)` unique index. It only modifies indexes, never payment documents. Do not run it without a backup or while payments are being processed.
- Approval of a pending payment with **an uploaded proof but no reference** must succeed when its other validations pass. The approved payment must have one receipt number and a consistent invoice, booking status and audit record.
- Submitting another pending payment with **the same nonempty method + reference** must still return 409, and the existing approved payment must remain unchanged.
- If the migration reports unrecognized reference indexes or duplicated real references, stop and review the situation. The migration intentionally avoids silently dropping custom indexes or modifying financial evidence.

# Backend verification

From `server/`, after installing the locked npm dependencies and configuring a MongoDB replica set:

```sh
npm ci
npm run check
npm test
```

The November 2026 source package passed 208 Node tests and server syntax checks. See `../README.md` for full deployment instructions and staging validation, including the mandatory Gate-out Condition Upon Release, optional approval remarks, payment verification, receipt numbering, and Reefer rate selection. Tests using stubbed utilities and source contracts do not prove that a production database, email outbox, browser or deployment is working.

## Realtime follow-up checks

`npm run check` and `npm test` cover the server test suite, including 12 added source/permission contracts for notifications and the release confirmation modal. They are not substitutes for end-to-end testing against a MongoDB replica set with the admin and client React apps running.

After backup, optional notification indexes can be previewed with `npm run migrate:notification-indexes` and applied with `npm run migrate:notification-indexes -- --apply`. Index creation does not change existing notification or financial documents.

Test the authenticated Socket.IO handshake on both frontends, per-module/admin unread state, persisted alerts after refresh, Gate-in payment proofs, combined Gate-out/payment requests, release-ready alerts, client approval/rejection alerts, physical release state propagation, and notification reconnect behavior. Confirm there is no cross-portal cookie confusion and test limited-permission administrators. Ensure the reverse proxy handles `/socket.io` Upgrade requests.


## Table diagnostics repair (November 4, 2026)

The index migration now verifies named table indexes via MongoDB `listIndexes()` and does not depend on the return value of `createIndexes()`. The aggregation explain uses MongoDB's read-only `explain` command without `writeConcern` to avoid the previous driver error. A new `idx_booking_created` global chronological index was added, so rerun `npm run migrate:table-indexes` in staging after backup. Set `BENCH_COMPANY_ID` for representative company-filtered analysis. The revised benchmark separates 20-row query cost from `countDocuments` and reports median/p95. See `../docs/TABLE_PAGINATION.md`. Live explain output still requires your configured database; source tests cannot verify the query planner under production data.

### November 10, 2026: Audit & Reports

- `npm run check`, `npm test`: backend/source regression suite passes 232 tests, including human-readable audit field labels, before/after snapshots, bulk deletion metadata, sensitive value redaction, report client scoping and signed payment/reversal queries.
- `npm run migrate:table-indexes` after backup to create/verify report-specific compound indexes. No historical records are rewritten by this command.
- Admin frontend syntax checked (along with client) using TypeScript parser. Full `npm ci && npm run build`, live Mongo integration, browser/mobile UI, permission checks, report/export equivalence and PDF/print behavior remain to be verified on staging.
- See `../docs/AUDIT_LOGS_CLIENT_REPORTS.md`.

## November 2026: historical storage, active inventory and manual financial entries

This release adds cross-source storage-slot claims, inventory queries and history updates. From this source workspace:

- `npm test`: **243 passed, 0 failed** (Node.js built-in test runner; includes new inventory, VAT-exclusive/manual-payment, storage claim/migration, and UI source-contract checks).
- `npm run check`: server JavaScript files passed `node --check`.
- Both React source folders: **216 JS/JSX files passed TypeScript syntax parsing** with no parse diagnostics.
- A live MongoDB connection, competing slot-assignment transactions, actual HTTP payment history/receipt verification, production frontend builds and responsive browser E2E checks **were not performed in this environment** and remain mandatory in staging.

**Database migration:** `npm run migrate:storage-claims` (read-only) then, after backup and pausing storage writes, `npm run migrate:storage-claims -- --apply` (adds unique slot indexes and idempotent active-claim backfill). See `../docs/STORAGE_INVENTORY_MANUAL_TRANSACTIONS.md` for acceptance tests and change log.

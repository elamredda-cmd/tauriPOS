# Dojo sandbox verification

Updated 8 October 2026. This is a test checklist, not a production certification.

See [the current UAT readiness record](DOJO_UAT_READINESS.md) for this build's fixes,
new native tests, release gates and unverified items. The September 23 evidence below
is historical and is not a claim that every scenario has been repeated on this build.

## Dedicated terminal / no MariaDB setup

In **Settings → Payments → Dojo**, choose **Dedicated to this till — no MariaDB needed** and register the terminal for that computer. New configurations default to this option. Do not assign the same physical terminal to two dedicated tills. Internet is still required for Dojo; this is not offline card acceptance.

An older saved registration remains shared until explicitly switched. Finish/recover its pending payments and connect its original MariaDB once so the app can verify that another till has no unfinished work. Do not delete its journal or credentials to bypass this handover. Fresh standalone registrations do not need MariaDB. This change does not remove MariaDB from multi-till business-data synchronization or shared customer-balance/refund checks.

For acceptance testing, use sandbox credentials only:

1. On a standalone till, register a dedicated virtual terminal without configuring MariaDB. Confirm **Test Terminal** can obtain its status.
2. Complete an ordinary card sale and compare the POS receipt/reference to **Test → Payment intents**. There must be exactly one sale and one capture.
3. Repeat with a declined/canceled simulator; the trolley remains available, and no completed sale is fabricated.
4. In multi mode after initial shop synchronization, repeat an ordinary dedicated card sale while MariaDB is unavailable but internet is working. It must save locally. Reconnect and confirm the sale appears once in shared reports.
5. Exercise recovery after approval/local completion interruption. Check that it restores the same allocated receipt without creating a second charge, stock movement, loyalty movement or payment. Never intentionally interrupt a live customer payment for this test.
6. Verify that pending work blocks terminal reassignment and Z close. Cancellation is a request; unknown provider results must remain protected.

Automated local tests use isolated SQLite or mocked provider boundaries, not live credentials. They do not replace native sandbox or Windows UAT. The historical native results below used shared coordination and are not evidence that this new dedicated mode has passed native provider testing.

### Dedicated-mode verification — 8 October 2026

- Frontend: **960 passed**, two environment-gated tests skipped. Type/Svelte checks: **zero errors and warnings**; command-permission audit and production frontend build passed.
- Native: **218 passed**; seven real-MariaDB integration tests excluded. Dedicated tests exercise real isolated SQLite, restart-safe dispatch protection, cross-process registration locking, local receipt recovery, strict financial matching and restore guards. No running shop database was modified for these tests.
- Independent review feedback fixed checkout/report connection gates, local/shared journal collision handling, interrupted-save receipt recovery, backup-restore protection and authoritative customer-balance caching.
- Browser UI check confirmed the new dedicated default and shared-mode warning on the payment settings forms. Native sandbox checkout and Windows end-to-end acceptance have **not** been run for this change. Saved keys and terminal registration were left unchanged.

## Corrected behavior

- A signature decision does not itself complete a sale. The POS continues checking the original payment intent until capture is confirmed.
- Signature dialogs do not stop polling or terminal-lease renewal. A late or rejected control request is reconciled with the authoritative payment result.
- A failed cancellation does not shorten the payment observation deadline. An unknown result stays blocked against a duplicate payment.
- The screen's **Cancel Terminal** uses Dojo's terminal-session cancellation endpoint with an explicitly empty, zero-length request. It is a cancellation request, not proof of cancellation; provider results still decide the outcome. Dojo permits it only before a card/payment has been attempted.
- Non-JSON provider failures display a concise HTTP error instead of raw HTML. A cancellation already requested cannot be submitted repeatedly from the same screen.
- Recovery can acknowledge lagging shared journal state without weakening final-state or provider-ID protections. Missing-provider evidence no longer resets its settlement period.
- A terminal with unresolved work shows a readable message instead of a raw unique-index error.
- Payment money objects are parsed and checked, including currency, whole minor units, total, tips, service charge and cashback.

## Accounting rules

Product totals and debt repayments exclude tips, service charges and cashback. These three amounts have separate default-zero fields on `payments` and `customer_account_entries`; old records are preserved during upgrade.

Actual card collection = product card allocation (or debt repayment) + tip + service charge + cashback.

Expected drawer cash = opening float + cash sales + cash account repayments + cash movements − cashback paid out.

Receipts, order payment details, reports, per-till totals, exports, saved Z-report text and outgoing owner-report payloads disclose the extra amounts. Account report totals retain their existing shop-wide scope; per-till totals are till-scoped.

Ordinary goods refunds refund the goods allocation only. They do **not** refund tips, service charges or already-handed-out cashback. Voiding a transaction with extras is blocked to avoid hiding those collections/payouts. Refunding extras separately or distributing tips to staff is not implemented by this change.

Cashback completion and recovery instructions require acknowledgement. Recovery never opens the drawer automatically: an operator must check whether cash was already handed over before paying it out again.

## Native sandbox cases

Use Sandbox credentials and these Dojo-provided virtual TIDs; never use a live terminal for this checklist. Training mode skips the real provider and is not an integration test.

| Terminal | Scenario | Expected POS result |
| --- | --- | --- |
| VCMLABJSIP0 | Successful chip/PIN | One completed sale, one payment reference |
| VCMLABJDIP0 | Declined chip/PIN | No sale, no debt reduction |
| VCMLABJSCN0 | Contactless/device verification | One completed sale |
| VCMLABJSIS0 | Signature | Accept/reject dialog; polling continues; capture wins over a late response |
| VCMLABJDIS0 | Declined signature | No sale unless the authoritative payment was actually captured |
| VCMLABJUIP0 | Unsuccessful | No falsely completed sale |
| VCMLABJTIP0 | Timed out | Administrator receipt-review prompt; explicit successful/failed decision, fresh provider checks and audit. Unreviewed results remain protected. |
| VCMLABJCIP0 | Canceled | No completed sale for confirmed cancellation |
| VCMLABJSIP1 | Successful +10% tip | For £6 goods: £6 goods, £0.60 tip, £6.60 card collection |

Check the Dojo portal **Test → Payment intents** and the POS order receipt/payment reference. A declined terminal session can leave its intent at `Created`; that alone is not a second sale or a captured charge.

For cashback, compare the card collection, separate payout instruction, receipt and cash-up expected amounts. Also test a refund of goods and verify that the original cashback remains recorded.

### Expired test payments blocking a Z close

An unresolved terminal payment is a journal entry, not an open terminal window. `Expired` means the terminal session timed out; a payment intent still at `Created` is not sufficient proof that the payment failed. The POS intentionally keeps the attempt uncertain and blocks Z closing so an eventual confirmed payment cannot be lost from the period.

Current checkout opens a receipt-review prompt for administrators; other staff are instructed to ask an administrator to use **Reports → Payment checks → Review expired payment**. Account repayments use that Reports workflow too. Automatic sandbox cleanup is no longer used in these collection flows, so UAT exercises the same explicit review decision as production. Native PIN verification, matching shared/local proof and a terminal reservation are required. A failed receipt decision retires the unused intent and requires confirmed cancellation. A successful receipt decision is saved with the administrator, note, receipt reference and separate extras, then the original ledger entry is recovered exactly once. An unverified result stays unresolved.

For older unresolved tests, use **Reports → Check payment results** after cancelling/releasing any in-progress whole-system close. Ordinary recovery reads provider results; it never starts a new charge. For an expired **sandbox** sale, an administrator can explicitly request **Cancel expired test payment**. The native command validates the saved sandbox key, durable attempt, terminal session and matching unused `Created` intent before asking Dojo to cancel it. It requires a fresh matching `Canceled` provider result; it does not force a local failure or delete the journal. Normal recovery needs a second matching observation at least 30 seconds later before releasing the block. Reports now performs that follow-up automatically while the page remains open and the administrator/connection is still valid; otherwise it keeps the record protected and offers a fresh check. Generate a new Z preview after verification finishes.

The separate **Cancel expired test payment** action remains unavailable for live credentials, captured/authorized payments, refunds or mismatched identities. For live expiry use the audited receipt review, not test cleanup; do not charge the customer again merely because the terminal timed out.

### Executed native checks — 23 September 2026

Tested the rebuilt macOS Tauri app, using the configured Sandbox API key, with training mode off. No live payments were run.

| Check | Observed result |
| --- | --- |
| `VCMLABJSIS0`, £6 signature sale | Signature prompt appeared. After **Accept Signature**, the app waited for capture, then completed receipt **1000064**. Intent `pi_sandbox_pUnK3HISekWepGEVEId9Jg`; goods/card £6, extras £0. |
| `VCMLABJDIP0`, £6 declined sale | Displayed “The card payment was not approved”; trolley retained for retry. Intent `pi_sandbox_ys0LeWvJQEK4OxB2enTlXw`; failed journal, no order/payment saved. |
| Shared/local journal | Both new results agree in SQLite and MariaDB. Both shared active-terminal keys are cleared. No duplicate-active-terminal error occurred. |
| Daily report | Loaded from live MariaDB: one sale, £6 goods and £6 card collection; declined test excluded. |
| Till Z-report preview | Loaded without closing the period, including separate tips, service-charge and cashback fields and receipt text. |

The original five tests were preserved: three completed receipts (**1000061–1000063**) and two failed attempts with no sale. The disposable declined-test trolley was cleared; the terminal selection was restored to **VCMLABJSIS0**.

Later on the same mock-data laptop, a £10.55 `VCMLABJTIP0` attempt was found with an `Expired` terminal session and `Created` intent. The rebuilt app's **Reports → Payment checks** showed the exact unresolved amount. The explicit sandbox cancellation action obtained Dojo's `Canceled` result; after the separated confirmation interval, both SQLite and MariaDB journals became `cancelled` and unresolved counts reached zero. No sale was fabricated: the existing 69 completed orders and total 128689 pence stayed unchanged.

The whole-system Z close then saved successfully with a 23 September 2026 03:19:12 local cutoff and £1036.84 period total. The immediate next till X preview started at that same cutoff and showed £0.00 / zero transactions, confirming that it did not repeat the previous period. No report was printed, and no live payment was taken. Terminal configuration was left unchanged.

**Native coverage limits:** terminal discovery returned eight devices, without **VCMLABJSIP1**, so a real virtual-terminal gratuity test could not be run. Ask Dojo to attach that simulator to this same sandbox API account. Cashback/service-charge and customer-account extras have automated coverage, but have not yet been exercised against a native provider simulator. An existing expired sandbox attempt was safely cancelled and recovered on this build, as recorded below. A fresh timeout session, the dedicated cancelled-result simulator, and signature rejection remain to be rerun through the complete native matrix.

## Automated checks

- `npm run check`
- `npx vitest run`
- `cd src-tauri && cargo test --lib dojo::tests`
- `cd src-tauri && cargo test --lib commerce::tests -- --skip real_mariadb`

Historical September 23 results: Svelte/type checks **0 errors / 0 warnings**; frontend suite **776 passed / 2 skipped**; native commerce suite **97 passed**; native Dojo suite **10 passed**. A separate isolated real-MariaDB whole-system-close integration test passed. Focused report, receipt, journal and persistent-notification regressions also passed after those edits. Current September 28 results are in [DOJO_UAT_READINESS.md](DOJO_UAT_READINESS.md). These checks do not certify live acquiring or physical cash-drawer behavior.

MariaDB upgrade tests use only a newly-created disposable `pos_test_...` database. Do not point destructive integration fixtures at a shop database. Both a fresh schema and an older schema with a retained £6 payment were tested; new fields defaulted to zero and the original amount/reference survived.

Mocked tests cover control-request races, lease renewal, failed cancellation, monetary validation, journal acknowledgement, missing-provider settlement, extras persistence/replay and cashback-recovery disclosure. September 28 adds same-intent decline retries, latest-session recovery and audited expired-receipt resolution tests. These are not a substitute for the native virtual-terminal cases or Dojo's approval. The separate test-cleanup cancellation action remains strictly sandbox-only.

## Official references

- [Dojo API schema, version 2026-02-27](https://docs.dojo.tech/api/v3/bundled.json)
- [Signature verification](https://docs.dojo.tech/payments/accept-payments/in-person-payments/pay-at-counter/terminals/signature-verification)
- [Pay-at-counter go-live checklist](https://docs.dojo.tech/payments/accept-payments/in-person-payments/pay-at-counter/go-live-checklist-f2f)
- [Expired terminal-session guidance](https://docs.dojo.tech/payments/accept-payments/in-person-payments/pay-at-counter/terminals#expired-state)
- [Cancel an unused payment intent](https://docs.dojo.tech/payments/manage-payments/cancelling-payments/cancel)

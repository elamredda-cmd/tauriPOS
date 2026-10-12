# Dojo sandbox verification

Updated 11 October 2026. This is a test checklist, not a production certification.

See [the current UAT readiness record](DOJO_UAT_READINESS.md) for this build's fixes,
new native tests, release gates and unverified items. The September 23 evidence below
is historical and is not a claim that every scenario has been repeated on this build.

## Dedicated terminal / no MariaDB setup

In **Settings → Payments → Dojo**, choose **Dedicated to this till — no MariaDB needed** and register the terminal for that computer. New configurations default to this option. Do not assign the same physical terminal to two dedicated tills. Internet is still required for Dojo; this is not offline card acceptance.

An older saved registration remains shared until explicitly switched. For **live** registrations, finish/recover pending payments and connect the original MariaDB once so the app can verify that another till has no unfinished work. For **sandbox** registrations blocked by old tests, use the administrator recovery workflow below. Do not delete journals or credentials to bypass payment checks. Fresh standalone registrations do not need MariaDB. This change does not remove MariaDB from multi-till business-data synchronization or shared customer-balance/refund checks.

### Old sandbox payments blocking key removal (Windows or macOS)

Install a build containing **Settings → Payments → Dojo → Resolve old sandbox payments**. Keep the existing sandbox key saved and internet available; MariaDB can stay off.

1. Sign in as a real administrator, open that action and enter your administrator PIN.
2. The native app reads the old shared journals and verifies their exact payment/reference, terminal-session and money details directly with Dojo. It does not initiate a new card payment. Unused `Created` intents with verified inactive sessions can be cancelled; active, captured, approved, account-payment, refund or ambiguous records stay protected for review.
3. Leave the dialog open. A matching final no-charge result is checked again after at least 30 seconds, then retained in the local journal with an audit record. A lost connection or changed staff profile stops confirmation safely; reopen and retry.
4. Once every local Dojo attempt is resolved and the selected sandbox terminal is available, the saved registration switches to **Dedicated**. Close the dialog and use **Remove Saved API Key**. Key removal is a separate explicit action; recovery itself keeps the key.
5. Save the key/terminal intended for this till with **Dedicated to this till — no MariaDB needed** selected. Never assign one physical terminal to multiple dedicated tills.

Confirmed sandbox recovery evidence survives ordinary history cleanup and journal pruning. If MariaDB is later reconnected, matching stale shared records are acknowledged without reopening the cancelled tests; contradictory shared evidence remains blocked. Portable shop-setup backups omit this machine-specific recovery evidence along with payment journals. This workflow is not a force-clear option and cannot resolve a provider result that cannot be verified.

### Legacy sandbox recovery verification — 12 October 2026

Automated checks: **1,018 frontend tests passed**, two skipped; **62 targeted native tests passed**, including 14 new provider/SQLite recovery tests. The native checks cover real isolated SQLite transactions and mocked HTTP request/response boundaries, legacy zero-default amount fields, mismatched/captured/active payments, missing latest-session evidence, sale-payload/accounting validation, two separated confirmations, staff/configuration races, history cleanup and portable backups. Reconnection tests cover Dedicated mode with no saved key, bounded acknowledgement, retries and restored shared-database epochs. `npm run check` reports zero errors/warnings; the native macOS debug app bundle builds successfully. Existing Rust dead-code and frontend bundle-size warnings are not new recovery failures.

Independent Sol 6.1 Ultra acceptance used the rebuilt **native macOS Tauri app**, not browser emulation, with the MariaDB service stopped and no TCP 3306 listener. A protected backup was taken before reproducing legacy state on the mock-data laptop: the previously cancelled sandbox attempt `69c6344a-6ac2-4ea6-873b-8f8881c23920` was marked `uncertain/shared` with the legacy zero amount hint; its actual provider IDs, amount and sale payload were unchanged.

- Before recovery, key removal was blocked. An incorrect administrator PIN left the journal unresolved, with no recovery receipt or audit entry.
- With the correct PIN, Dojo's `Canceled` result was verified at **00:03:00.948Z** and **00:03:36.085Z**, 35.137 seconds apart. One native recovery receipt and one audit entry were saved; the journal remained `shared` and became `cancelled`.
- The native dialog and saved settings confirmed **Dedicated** ownership with the original key retained. Explicit **Remove Saved API Key** then succeeded, disabled the integration and removed the key while MariaDB was still stopped.
- No new charge was initiated. Orders/payments stayed at **86 each**, both totals **137,907 pence**, and active terminal attempts were zero.
- MariaDB was restarted at **00:04:16Z** while the Dojo key was still removed. The running native app automatically acknowledged the confirmed receipt for the shared dataset. Its Sync Dashboard reported **Reachable / Ready / Pending 0 / Conflicts 0 / Schema Good**; a normal Sync Now also completed. The receipt/audit and unchanged financial totals were preserved.
- After testing, the original protected credential/configuration files were restored byte-for-byte. The verified cancelled journal, receipt, audit and shared acknowledgement were retained; the database was not rolled back. MariaDB was left running again, with no pending local queue or active payment attempts.

These results verify the native macOS flow; the Windows installer and physical-terminal UAT still require testing on Windows after rebuilding/installing this source.

For acceptance testing, use sandbox credentials only:

1. On a standalone till, register a dedicated virtual terminal without configuring MariaDB. Confirm **Test Terminal** can obtain its status.
2. Complete an ordinary card sale and compare the POS receipt/reference to **Test → Payment intents**. There must be exactly one sale and one capture.
3. Repeat with a declined/canceled simulator; the trolley remains available, and no completed sale is fabricated.
4. In multi mode after initial shop synchronization, repeat an ordinary dedicated card sale while MariaDB is unavailable but internet is working. It must save locally. Reconnect and confirm the sale appears once in shared reports.
5. Exercise recovery after approval/local completion interruption. Check that it restores the same allocated receipt without creating a second charge, stock movement, loyalty movement or payment. Never intentionally interrupt a live customer payment for this test.
6. Verify that pending work blocks terminal reassignment and Z close. Cancellation is a request; unknown provider results must remain protected.

Automated local tests use isolated SQLite or mocked provider boundaries, not live credentials. They do not replace native sandbox or Windows UAT. The October 11 results below cover dedicated-mode native testing; the September results used shared coordination.

### Native dedicated-mode verification — 11 October 2026

Tested the current-source macOS Tauri debug app bundle, not the built-in browser. The shop stayed in **multi** mode, training was off, and the existing sandbox key was unchanged. Switched the legacy registration to **dedicated** after resolving its older shared timeout through Reports. Then stopped the Homebrew MariaDB service and confirmed no TCP 3306 listener throughout payment and cancellation. Internet remained available.

| Native action with MariaDB stopped | Verified result |
| --- | --- |
| `VCMLABJSIP0`, £1.09 normal-goods sale | POS displayed success. Intent `pi_sandbox_ZB8x75pe2EqRWsa04CFJlw` and session `ts_sandbox_6acbf16fa7da208ec03b28fb` were **Captured**. One local receipt **1000079**, one payment of 109 pence, local recovery journal, and one stable `terminal-sale:` outbox entry. |
| `VCMLABJSIS0`, press **Cancel Terminal** immediately after sending | Session `ts_sandbox_6acbf1fda7da208ec03b28ff` recorded **CancelRequested → Canceled**. Intent `pi_sandbox_N-s1BWc52kyRBNtBkmq2Ag` remained **Created**, with the canceled session in its history. Local attempt `44628d7f-31b5-49db-b2b8-1ad477a97a30` was **cancelled**; no order/payment was saved; the £1.09 trolley remained available. |
| Earlier cancellation after simulated card entry | The simulator reached signature verification, so cancellation was not confirmed. Rejected the signature through the native dialog; attempt `fcf24c4d-70f6-43d1-b154-43d23e8376cb` finished **failed**, session **Declined**, with no order/payment. This is not counted as a successful cancel-button test. |
| Restart MariaDB and allow normal reconnect/sync | MariaDB contained exactly one order and one 109-pence payment for the successful attempt `f6754c74-0a3f-4f16-94c8-16b36e2e9e7e`, and zero orders/payments for both non-approved attempts. Native dashboard showed ready, zero pending writes and zero conflicts; the local queue was empty and no terminal attempts were unresolved. |

The older £6 timeout (`69c6344a-6ac2-4ea6-873b-8f8881c23920`) was canceled through **Cancel expired test payment** and the automatic second provider observation, not by deleting or forcing its journal. MariaDB was restarted, the disposable cancellation trolley cleared, and the original `VCMLABJTIP0` selection restored while retaining dedicated ownership. The app remained open. Local completed sale totals increased by exactly one sale / 109 pence.

Observations from this initial run, fixed and retested below: the first send during the online-to-offline transition was blocked by a missing staff shift before contacting Dojo. Signing in again with MariaDB stopped restored the local shift; subsequent payment, admin/settings navigation and cancellation worked without another login. The Sync Dashboard also falsely warned that SQLite schema version 4 should be 2; independent source review confirmed a stale diagnostic comparison, not a failed migration or sync gate. No application source was changed in this initial testing run.

Independent focused regression checks: **96 passed** (terminal ownership, session flow, local terminal safety and report recovery). These macOS sandbox results do not certify Windows, physical-terminal UAT, live credentials, internet-loss handling, refunds, tips/cashback, or every remaining simulator scenario.

### Staff-session and schema fixes: native retest — 11 October 2026

An independent **Sol 6.1 Ultra** agent retested the rebuilt native macOS Tauri debug app after both fixes. The shop remained in multi mode with dedicated terminal ownership, training off, internet available and the existing sandbox key unchanged. MariaDB was stopped at 20:43:02 UTC and restarted at 20:46:44 UTC; no TCP 3306 listener was present during the payment/cancellation tests.

| Check | Result |
| --- | --- |
| Existing staff session across server loss | Alan remained signed in through more than 49 seconds offline, Admin/Settings navigation, payment and cancellation. The original shift `95ebefa1-22b0-4f2c-83b1-2defbf9a0705` was retained. The audit contained one initial login and no subsequent logout/re-login. |
| `VCMLABJSIP0`, £1.09 sale on the first Send | Native success, receipt **1000080**, attempt `f437ab94-f934-4800-87d1-fc4f0ca246e3`. Intent `pi_sandbox_2qOlcJslsUSqSRqMFBow8g` and session `ts_sandbox_6acbf50b3be93414b201942a` were **Captured**. Exactly one local order/payment and one stable sale outbox entry. |
| `VCMLABJSIS0`, actual on-screen **Cancel Terminal** | Native cancellation confirmed. Attempt `a02ce801-a10b-4ede-a7fb-a28d8970989b` was **cancelled**; session `ts_sandbox_6acbf571a7da208ec03b2919` recorded **CancelRequested → Canceled**. Intent `pi_sandbox_A1CVL6MsTkKa_pKR-eT6vQ` remained **Created** with the canceled session in its history. No order/payment was created; the £1.09 trolley remained available. |
| Normal reconnect and independent shared-database reconciliation | Exactly one shared order and one 109-pence payment for receipt **1000080**; zero orders/payments for the canceled attempt. Local queue drained to zero; no terminal attempts remained unresolved. |
| Native Sync Dashboard | **Reachable**, **Ready**, **Pending 0**, **Conflicts 0**, **Schema Good**. The stale schema-version warning was gone. |

The disposable cancellation trolley was cleared normally. MariaDB and the original `VCMLABJTIP0` terminal selection were restored, dedicated ownership and the saved key were retained, and Tauri was left open at an empty checkout with the same cashier signed in and **Synced**.

Focused automated verification: **152 tests passed across 7 files**, covering staff-session security/races, schema diagnostics, sync concurrency and terminal/payment recovery. Svelte/TypeScript checks reported **0 errors and 0 warnings**; the command-permission audit and native debug app build passed. This retest verifies the two fixes and native MariaDB-unavailable payment/cancellation flow; it does not replace Windows or physical-terminal UAT.

### Dedicated-mode verification — 8 October 2026

- Frontend: **960 passed**, two environment-gated tests skipped. Type/Svelte checks: **zero errors and warnings**; command-permission audit and production frontend build passed.
- Native: **218 passed**; seven real-MariaDB integration tests excluded. Dedicated tests exercise real isolated SQLite, restart-safe dispatch protection, cross-process registration locking, local receipt recovery, strict financial matching and restore guards. No running shop database was modified for these tests.
- Independent review feedback fixed checkout/report connection gates, local/shared journal collision handling, interrupted-save receipt recovery, backup-restore protection and authoritative customer-balance caching.
- Browser UI check confirmed the new dedicated default and shared-mode warning on the payment settings forms. Native sandbox checkout and Windows end-to-end acceptance have **not** been run for this change. Saved keys and terminal registration were left unchanged.

## Corrected behavior

- An already authenticated cashier keeps the same local shift if a staff recheck encounters a transport failure and the connection manager confirms MariaDB is offline. The cached staff profile and authorization version must still match. New sign-ins remain strict, and deactivation/profile changes or non-transport verification failures still revoke the session.
- Sync diagnostics use the SQLite migration's current schema version and read connection readiness after their live probe, including whether startup recovery has finished.
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

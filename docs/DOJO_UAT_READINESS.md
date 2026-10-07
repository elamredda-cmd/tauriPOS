# Dojo / installer readiness — 28 September 2026

This is an engineering readiness record, **not Dojo approval to take live money**.
Scope: native desktop POS, in-person auto-capture payments, payment-intent refunds,
shared MariaDB recovery, and installer checks. No production credentials were changed.

**Follow-up:** [Native sandbox run and current blockers](DOJO_SANDBOX_RUN_2026_09_28.md)
records subsequent contactless/signature/cancellation/restart tests, refund-error fixes,
874 frontend and184 native test passes, and the provider's full/partial refund rejection.
Successful refunds are **not yet a UAT pass**. The earlier verification table below is
retained as dated evidence; use the follow-up for the latest run and terminal state.

## Changes in this review

- Declined checkout and customer-account payments offer **Try another card**, creating
  another terminal session against the original payment intent. The durable first-session
  reference remains unchanged; recovery follows the verified latest provider session.
- An ambiguous retry response stays unresolved instead of treating the earlier decline as
  proof that a later attempt failed. A late capture always takes precedence.
- Expired checkout payments open an administrator receipt-review dialog. Reports provides
  the same review for unresolved sales/account repayments. The native command requires an
  active administrator PIN, terminal reservation, matching shared/local journal and fresh
  Dojo expiry evidence. Decisions and receipt references are audited.
- A failed receipt decision requires Dojo to confirm intent cancellation before retry.
  A successful receipt decision recovers the original sale exactly once, with separately
  recorded tips, service charge and cashback. Never invent receipt evidence on a live till.
- Production configuration rejects sandbox IDs paired with a live key. Authentication,
  unavailable-terminal and invalid-stage errors now provide useful instructions.
- SQLite schema version 4 creates a pre-upgrade backup. MariaDB's migration marker was
  advanced for the new review column; repeat startups use the fast path again.
- The release workflow runs frontend checks/tests and native tests before packaging.
  macOS explicitly requests app/DMG bundles instead of inheriting the Windows NSIS target.
- Sign-in during first-upgrade database preparation explains that it must finish syncing.

## Verification

| Check | Evidence / status |
| --- | --- |
| Svelte / TypeScript | 0 errors and 0 warnings after final code edits |
| Frontend suite | 864 passed, 2 environment-gated tests skipped |
| Native unit suite | 183 passed; 7 `real_mariadb` tests excluded from this run |
| Actual MariaDB upgrade | Fresh schema, previous-marker upgrade, review-column addition and repeat-startup fast path passed in isolated `pos_test_dojo_uat_20260928`; only that agent-created fixture database was removed afterwards |
| macOS native package | Debug `.app` built and launched; first-upgrade backup/column migration and sign-in verified |
| Timeout + failed receipt review | `VCMLABJTIP0`, £1; intent `pi_sandbox_CrsM9I0gO0O5QIYtSqag_w`; journal `813f2af4-2b5c-4177-9587-fc52fdbf2dc0` became `cancelled`, one audit event, zero orders. Evidence explicitly labelled a simulated UAT receipt. Checkout reopened for another payment. |
| Terminal discovery | Eight sandbox devices returned. `VCMLABJSIP1` is still absent. |
| Decline / retry | `VCMLABJDIP0`, £1; **Try another card** started another session and reached the decline prompt again. Intent remained `pi_sandbox_c5S9kp2zAUGUPlPvvox0bA`; journal `3b1f1c9d-4fac-4b14-a92e-5ccab33a97b4` finalized `failed`; zero orders. The portal lists one intent at `Created`, not a captured charge; this list did not expose individual session history. |
| Paid receipt-review branch | Native `VCMLABJTIP0`, £2; simulated receipt `UAT-SIMULATED-PAID-20260928`, intent `pi_sandbox_Uy5-r3wIcUePtlhy0n_nxA`. Exactly one mock POS order/payment (`aac5a4c5-3d88-4d40-877a-1d7ea6a73026`) with £2 goods/card allocation and separate £0.20 tip; journal completed, audit retained and trolley cleared. This is a simulated manual receipt assertion, **not a provider-approved charge or a gratuity-simulator pass**. |
| Reports / payment checks | Native daily report: 1 sale, £2 goods, £0.20 tips and £2.20 recorded card collection. **Check payment results** reported no unresolved payments. Receipt number `1000068`. No Z period was closed during this audit. |
| Windows | Not built or installed on this Mac; Windows CI and a real till upgrade smoke test are still required |

Earlier native signature approval, decline, sandbox recovery, reports and Z-close evidence
is retained in [DOJO_TESTING.md](DOJO_TESTING.md); those September 23 runs are not a full
re-test of this build.

The Dojo developer portal initially required login, then became available. Its refreshed
Test payment-intent list confirmed all three new IDs/amounts: the failed receipt case is
`Canceled`; the declined retry and simulated paid receipt case remain `Created`. The
manual receipt path deliberately does not pretend the API reported capture. No portal
settings or credentials were changed. Native sandbox calls used the already-configured
key. Both receipt decisions were recorded through the app, not by editing payment status
in the database.

Test records were retained for UAT evidence. The saved sandbox terminal was restored
to `VCMLABJTIP0`, the trolley is empty, and the shared journal has zero unresolved
attempts. No actual card transaction or physical cash payout occurred.
The final rebuilt native app was restarted and signed in successfully, showing **Synced**
and an empty checkout. Only the disposable upgrade-test database was removed; test sales
and audit evidence in the mock shop database were retained.

## Remaining release gates

1. **Agree scope with Dojo.** The public checklist includes MOTO, item lines/modifiers and
   webhooks. This POS currently does not send item lines, expose MOTO or host a public
   webhook receiver. Ask Dojo to mark applicability explicitly; do not silently call these
   passed or optional. Manual preauthorisation and terminal-based refunds are not offered;
   the supported refund route is the original payment intent.
2. **Complete witnessed UAT.** The follow-up passed sandbox success/contactless, signature
   acceptance/rejection/80-second timeout, early cancellation and restart recovery. Late
   controls were API-injected and covered by monitor tests, not fully witnessed physical
   button races. Full/partial refunds were rejected by Dojo and require resolution before
   signoff. Physical-terminal busy and disconnection cases remain. Preserve intent IDs,
   app/API versions and expected ledger totals.
3. **Extras on a provider/device.** Ask Dojo to attach `VCMLABJSIP1` to this sandbox account
   and provide a cashback-capable scenario/device. Automated accounting tests do not prove
   device behaviour. Do not advertise unverified extras as certified.
4. **Windows installation/upgrade.** Build a draft installer in Windows CI, then test on a
   representative low-spec Windows till with WebView2, an existing database backup, printer,
   drawer, scanner, terminal and a second till. Verify clean install, in-place upgrade,
   restart during payment, network loss and recovery. Keep the old installer and backup;
   the older app must not be used on a newer SQLite schema without restoring its backup.
5. **Production onboarding.** Obtain Dojo's approval and assigned production software-house/
   reseller IDs, provision each till's live key/terminal through settings, and agree any
   supervised live test with Dojo. API version: `2026-02-27`; app version currently `0.1.1`.
   Choose and record the final release version before distributing an update; it was not
   automatically increased during this audit.

## Operator safety

- `Created` is not proof of failure. Never clear a payment journal to unblock selling.
- Check payment checks before closing the day. Unresolved attempts deliberately prevent a
  Z close or destructive maintenance from losing an eventual payment.
- Record a successful expired result only from a real matching terminal screen/receipt.
  This is an audited manual assertion, not a claim that the API reported `Captured`.
- Recovery does not automatically open the drawer. Check whether cashback was already
  handed over before paying it again.
- Never place API keys, PINs, card numbers or raw sensitive responses in UAT evidence.

## Official sources checked

- [Pay-at-counter go-live checklist](https://docs.dojo.tech/payments/accept-payments/in-person-payments/pay-at-counter/go-live-checklist-f2f), updated 24 September 2026.
- [Terminal states and expired-result handling](https://docs.dojo.tech/payments/accept-payments/in-person-payments/pay-at-counter/terminals).
- [Signature verification](https://docs.dojo.tech/payments/accept-payments/in-person-payments/pay-at-counter/terminals/signature-verification).
- [Dojo OpenAPI schema](https://docs.dojo.tech/api/v3/bundled.json).

The website reviewed was **Dojo's go-live documentation**, not a separate public shop website.

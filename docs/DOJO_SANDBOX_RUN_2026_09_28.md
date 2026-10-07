# Native sandbox follow-up — 28 September 2026

Available sandbox run completed, with the external blockers below. This is test evidence,
not Dojo go-live approval; unsuccessful/blocked cases are not marked passed.

- POS 0.1.1; Dojo API 2026-02-27; Sandbox only, existing local credentials.
- User-authorized mock shop database; no live charges or physical cash payouts.
- Baseline: zero unresolved payment attempts. Earlier attempts, sales and audit records retained.
- `npm run tauri dev` launched successfully, but macOS automation could not attach to its
  unbundled process. Native interaction uses the same-source debug `.app` instead.
- Portal session signed out. Results were independently verified through the official
  API using the app's configured sandbox account, not by assuming portal-list labels.
- Eight simulators available; gratuity terminal `VCMLABJSIP1` absent on discovery.

## Fixes

- Refund confirmation distinguishes integrated Dojo/SumUp refunds (sent by the POS;
  do not refund separately) from standalone card refunds (processed externally).
  Cash/account-only refunds no longer show irrelevant card-terminal instructions.
- Refund helper tests: 16 passed. Svelte check: zero errors, zero warnings.
- Provider error messages now accept PascalCase `Detail`/`Title` as well as lowercase,
  retaining bounded-text/HTML protections.
- An explicit provider refund `Failed` response is distinguished from transport uncertainty.
  Final rejection still requires a fresh matching intent with unchanged refunded total.
- Recent interrupted refunds can be reconciled under the recovery lease by replaying the
  exact persisted idempotency key/body, never creating a new refund key. Capture wins over
  a stale rejection; mismatched identity or ambiguous result remains protected. Requests
  older than 24 hours are not automatically replayed (a conservative application limit,
  not an assertion of Dojo's idempotency-key retention duration).
- Targeted recovery/refund frontend tests: 43 passed; native Dojo tests: 22 passed.

## Native test results

| Case | Result / evidence |
| --- | --- |
| Chip/PIN success | Native £5 sale on `VCMLABJSIP0`; receipt `1000070`, order `f22b8fba-c57e-4bf4-81b8-054f60c1e935`, intent `pi_sandbox_QySROJiP-06ybcxIYs3EFA`, session `ts_sandbox_6ab9e8cf1b9f3f38edb7a0d1`. One sale, empty trolley. Fresh provider GET: `Captured`, amount500 GBP, refunded0. |
| Full refund | Native attempt `577e4924-6fd1-4501-bd9b-db79f2764e1a`, £5 against the above sale. Dojo HTTP400 body `{"Status":400,"Detail":"Your refund request was not successful. Status: Failed.","Extensions":{}}`. Same-body/same-key diagnostic replays also rejected; fresh original intent unchanged, no refund ledger entry. **Successful-refund UAT blocked, not passed.** Payload/headers match current OpenAPI; Dojo must explain this sandbox refund rejection. |
| Rejected refund recovery | Restarted rebuilt app: original full-refund attempt finalized `failed` through provider-verified recovery; no SQL status override and no refund order. |
| Partial refund | Native £2 attempt `29335f73-ed40-4737-a70c-a65a5da9387b` against receipt1000070. Dojo again explicitly rejected it; updated native UI explains no refund recorded. Journal finalized `cancelled`, original £5 sale unchanged. **Successful partial-refund UAT blocked by provider rejection; rejection handling passed.** |
| Contactless | `VCMLABJSCN0`, £1; intent `pi_sandbox_elcqXTbto0W3cW_UFQs_vA`, order `cd9ae051-2d48-4fb8-9fa3-74bd082bbb08`, receipt1000071. Native success dialog and cleared trolley; journal completed once. |
| Signature accept | `VCMLABJSIS0`, £1; native Accept Signature; intent `pi_sandbox_CJBQMnnfZ0yfyH_2VUfLSg`, order `3a30a095-081e-4842-98d6-b6d34263f094`, receipt1000072. Cleared trolley, completed journal. |
| Signature reject | `VCMLABJSIS0`, £1; native Reject Signature then Return to payment. Intent `pi_sandbox_kPmqKRoNx0mzOimwipXPrw`, journal `98b66d9c-2da6-481f-8a3b-549bd21887a9` failed; zero orders. Fresh API GET: intent Created, latest session Declined, refunded0. |
| Signature 80-second timeout | `VCMLABJSIS0`, £1; no signature decision sent. Native dialog still present at56 seconds after observation, success displayed at93 seconds. Intent `pi_sandbox_sTAqlI-hXEClFM0xfL_AhQ`, journal `ae6792b8-6d91-4589-b199-d1726a79b4dd`, session `ts_sandbox_6ab9eb2b79fde949180693ec`; API Captured £1/refunded0. |
| Late signature rejection | After the above native completion removed the signature controls, a deliberate sandbox API PUT accepted=false on the same session returned422. Before/after GET remained Captured. Native stale-callback protections also covered by automated tests; this was an API-injected late request, not a click on a nonexistent button. |
| Early POS cancellation | Native Cancel Terminal pressed immediately after sending £1 on SIS0. Intent `pi_sandbox_ulLv7aBaLEWBfGE2sUjVMw`, journal `3fd90def-c75d-4cde-9a41-afb846f22a9c` cancelled, native cancellation message, zero orders. |
| Late-cancel timing attempts | Two additional SIP0 £1 sales completed before a late click could be issued: `pi_sandbox_TwTa5nVNy0_Z0tfD42G1mw`/receipt1000074 and `pi_sandbox_MwYwM4q1U0CmgQksSHy3lw`/receipt1000075. Retained as ordinary sandbox successes, **not native late-cancellation passes**. |
| Terminal cancellation simulator | CIP0 £1, intent `pi_sandbox_ZUvUUv9tbEWzm64Aaw-CJA`, journal `2d19e712-6c46-4fe5-805c-1ee6d1249572` cancelled. Native cancellation notice and zero orders. No physical PDQ X button was used. |
| Unsuccessful simulator | UIP0 £1, intent `pi_sandbox_upjg5J9-J0OdJuzPrFIoaQ`, journal `d751a64b-8d0c-4da6-838c-79af761d2880` cancelled, zero orders. Actual simulator outcome was Canceled, not Declined. |
| Declined-signature-labelled terminal | DIS0 presented signature verification. Accepting it **captured** £1, contrary to the provided description of an always-declining terminal. Intent `pi_sandbox_qe2Eq_psHE63OLh3afY0aA`, journal `98fe11a4-feb5-4af2-823c-18b9828e016b`, receipt1000076. Fresh API confirms Captured on terminal `tm_sandbox_6ab23a57ec6e67639fd2e1b8`. POS correctly followed provider truth; ask Dojo to clarify simulator behaviour. Signature rejection itself passed separately on SIS0. |
| Late cancellation API | SIS0 while native signature dialog open, intent `pi_sandbox_zJqEIiB0o0KYnq2zmbu8ag`, session `ts_sandbox_6ab9ed241b9f3f38edb7a0f4`. Direct sandbox PUT cancel with Content-Length0 returned422; before/after session stayed SignatureVerificationRequired. API-injected because signature overlay intentionally hides the underlying cancel control. |
| Native restart recovery | Closed Tauri during the above SIS0 signature prompt without sending a decision. Fresh API subsequently confirmed Captured. Reopened and signed in; after the existing180-second reservation and four-minute recent-work safety window, recovery completed journal `629a2206-283f-444d-81e8-e0324a1364b6` and receipt1000077 exactly once. Both MariaDB and SQLite show one £1 payment. Repeated Check payment results produced no duplicate and showed no unresolved payments. This tests process interruption, not physical network/power failure on a Windows till. |

Fresh API reads of early POS cancellation, CIP0 and UIP0 each returned intent Created
with latest terminal session Canceled. The final session, not the list's Created label,
established their non-payment outcome.

Fresh API reads independently confirmed the contactless and signature-accepted intents
as Captured with £1 GBP each and refunded0. Portal login is not required for these
checks; the already-configured sandbox key was used without displaying or copying it.

## Final reconciliation

- This follow-up created14 attempts: eight completed sandbox sales (£12 goods),
  three cancelled sales, one failed sale, and two rejected refunds. Zero orders for
  either rejected refund; no statuses were edited directly in SQL.
- Native daily report after refresh: ten sales, £15 goods/card sales, £0 refunds,
  £0.20 tips and £15.20 recorded card collection. These totals include two earlier
  mock sales, including the explicitly simulated receipt-review tip; they are not a
  settlement statement or proof that the gratuity simulator passed.
- MariaDB and SQLite: zero unresolved attempts. Recovered sale: exactly one payment
  for100p in each database. Test sales/audit records retained; no Z report closed.
- Original terminal `VCMLABJTIP0` restored, Sandbox still enabled, native checkout
  left open, Synced and empty.
- Final frontend suite:874 passed, two environment-gated skipped. Native unit suite:
  184 passed, seven real-MariaDB tests excluded. Svelte check zero errors/warnings;
  `git diff --check` clean. Native debug app rebuilt and exercised after fixes.
- Earlier September28 timeout receipt-review (paid and failed) and decline/retry
  evidence remains in [readiness record](DOJO_UAT_READINESS.md). Those cases were
  not unnecessarily recreated here; they should still be witnessed in final UAT.

## Questions for Dojo (not sent)

1. Why do full500p and partial200p payment-intent refunds of SIP0 capture
   `pi_sandbox_QySROJiP-06ybcxIYs3EFA` return HTTP400 with explicit `Status: Failed`?
   Is an account capability or different simulator/payment required? The request uses
   API2026-02-27, an integer amount, JSON content type and a stable idempotencyKey.
2. Please attach the promised gratuity terminal `VCMLABJSIP1` and provide a supported
   cashback test scenario. Only eight terminals were returned on final discovery.
3. Please clarify DIS0: accepting its signature captured the payment in this run.
   We have separately proved rejection on SIS0, but cannot label DIS0's supplied
   decline expectation passed when its actual result was Captured.
4. Confirm applicability of MOTO, itemLines and webhooks for this integration scope,
   and arrange witnessed physical-terminal / Windows UAT.

Native late-cancel button timing, real PDQ busy/menu/card interaction and real connection
loss remain hardware UAT cases. Early native cancellation passed, late API rejection
and captured-result precedence passed, and automated tests cover the UI-monitor race.

## External release gates

Physical-terminal busy/disconnection, real Windows hardware/upgrade, missing gratuity and
cashback simulations, and Dojo approval remain separate from these sandbox tests.
See [readiness record](DOJO_UAT_READINESS.md) for scope and production-onboarding gates.

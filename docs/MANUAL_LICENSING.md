# L&Bj POS Manual Licensing

## Purpose

The signed licence is bound to the shop, not to a till name. One licence can cover a standalone till or a multi-till shop up to its stated till allowance. Activation and licence validation on the POS work offline; licence issuance is available through the Firebase Cloud CRM or the separate local Licence Studio.

Till allowance uses active real register IDs. The obsolete `register-main` and `legacy-till` placeholders created by older builds are ignored; ordinary till records are never deduplicated merely because their display names match.

The POS contains only public verification keys. The Cloud CRM signs using Cloud KMS (`lbj-cloud-2026-07`); the older Licence Studio uses its separate local issuer key (`lbj-2026-07`). Neither private key belongs in a POS build. Do not replace an existing public key ID: that would invalidate codes already issued with it.

## Cloud CRM issuance (normal workflow)

The website is [L&Bj Cloud CRM — Licences](https://lbj-cloud-crm-prod.web.app/licences). Its source lives separately at `~/Desktop/L&Bj Cloud CRM`, not in this POS repository.

1. On the till, open **Settings > Shop Licence > Copy licence request**.
2. Sign in to the website with an active **owner** account. Ordinary CRM roles cannot issue or export licences. First-owner bootstrap requires a verified email address.
3. Choose **New licence**, paste/import the request, and validate it. Confirm the exact shop and customer; changing the request requires validation again.
4. Select the expiry date and a whole-number till allowance at least as large as the request's active till count. The server validates these terms before signing.
5. Choose **Issue signed licence**. Export the `.lbjlic` file or copy the `LBJ1...` code, then import/paste it in the POS. The QR contains the same signed token.

Website calendar dates use Europe/London. POS access ends at the start of the named expiry date on the till's local calendar; UK tills should use the correct UK time zone and clock. An expiry of 20 July means the last usable day is 19 July.

Renew from the shop's latest licence, even when starting from an older history row. Identical successful issue retries return the stored code, not a newly signed duplicate. Cancelled or superseded records cannot be reused as a fresh activation; obtain a new POS request when required by the website.

**Cancel record** is an administrative history change, not immediate remote revocation. An offline POS with a previously installed, valid signed code can continue until its signed expiry. No licence polling/revocation service is currently enforced by the POS.

## Trial and renewal notices

A newly created shop identity receives a 10-day trial. The trial begins from the identity's existing `createdAt` timestamp, so restarting the app, installing an update, renaming a till, adding another till, deleting sales history, or restoring setup data does not restart the trial.

During the final seven days of a trial or signed licence, the POS shows a renewal dialog after a staff member signs in. The reminder can be dismissed for the current app session. Once the trial or licence has expired, the post-login dialog requires a valid registration code and native sale commits are blocked until activation succeeds.

## First-time issuer setup

Start the private graphical issuer from its separate folder on the trusted development machine:

```bash
cd "$HOME/Desktop/L&Bj Licence Studio"
npm install
npm run dev
```

Licence Studio deliberately lives outside the POS Git repository, so it is not synchronized or shipped with customer POS builds.

Use **Security & backup** to confirm the signing key, choose the licence output directory, back up the local SQLite ledger, and create a separate private-key backup. Customer, shop, and issue history are stored locally in Licence Studio's `issuer.db`; the private key is deliberately not stored in that database.

The issuer key has already been generated on this development machine:

```text
~/.lbj-pos/licensing/issuer-private.pem
~/.lbj-pos/licensing/issuer.json
```

The private key has owner-only file permissions. Back up both files to an encrypted, access-controlled location before issuing commercial licences. Never put them in the project, an installer, cloud reporting data, or a customer backup.

To generate a key on a different secure issuer machine:

```bash
cd "$HOME/Desktop/L&Bj Licence Studio"
npm run license:keygen -- --kid lbj-2026-07
```

Set `LBJ_LICENSE_KEY_PASSWORD` before key generation when an encrypted PEM is required. Keep the password separately from the key backup.
If the POS repository is not at `~/Desktop/Tauri for Svelte POS`, set `LBJ_POS_PROJECT_ROOT` to its location before generating a key.

Key rotation must use a new key ID. Published key IDs are deliberately never replaceable because replacing one would invalidate every licence signed by the old key.

## Issue a licence

1. On the till, sign in as an administrator and open **Settings > Shop Licence**.
2. Press **Copy licence request** and transfer the `LBJREQ1...` value to the issuer machine.
3. In Licence Studio, open **Issue licence**, import or paste the request, select the customer and terms, then press **Generate licence**.

The expiry date is the first local calendar day on which sales are blocked. For example, a licence with an expiry date of 20 July remains usable through 19 July and is expired from local midnight at the start of 20 July.

The older command-line issuer remains available as a fallback:

```bash
cd "$HOME/Desktop/L&Bj Licence Studio"
npm run license:issue -- \
  --request "LBJREQ1..." \
  --customer "Example Shop" \
  --expires 2027-07-19 \
  --max-tills 2 \
  --output ~/Desktop/Example-Shop-2027
```

The command creates:

- `Example-Shop-2027.lbjlic` for file import.
- `Example-Shop-2027.txt` containing the same signed code.
- `Example-Shop-2027.png` containing a QR representation of the code.

It verifies its own signature before writing the files. Inspect an issued file at any time:

```bash
cd "$HOME/Desktop/L&Bj Licence Studio"
npm run license:inspect -- --license ~/Desktop/Example-Shop-2027.lbjlic
```

## Activate or renew

Return the `.lbjlic` file to the shop. Open **Settings > Shop Licence** and press **Import licence file**. Pasting the signed `LBJ1...` code is also supported.

For renewal, create a fresh request and issue another licence for the same shop ID with a later issue timestamp and expiry date. Importing it replaces the old signed token. Different signed claims cannot replace a newer installed entitlement, even if they reuse its licence ID; importing the identical licence again remains safe. Activation does not replace products, settings, orders, receipt numbers, or the SQLite database.

In multi-till mode, activation is saved on the current till and then shared through the shop identity. If sharing fails, the licence remains installed locally and the settings page shows a warning with a retry action; confirm the other tills receive it after reconnection. In standalone mode, it remains in that till's `pos.db`.

Licence synchronization compares verified, shop-bound signed issue times, not mutable database update times. A delayed old upload or download cannot replace a newer licence, and a pending old upload cannot hide a newer downloaded renewal. A newer expired entitlement remains authoritative over an older code with a longer expiry. Conflicting claims with an identical issue time keep the installed code; issue a fresh renewal to resolve the conflict. The existing trial start is preserved rather than restarted by synchronization.

## Registered tills

**Settings > Shop Licence** lists every real register counted by the licence. An administrator can retire an unused non-current till. Retirement marks the register inactive and preserves its sales, reports, sessions, and audit history.

The till currently running the app cannot retire itself. In multi-till mode, MariaDB must be connected and a till reported as online must be closed before it can be retired. If a retired till is opened again, it automatically registers itself as active and counts toward the allowance again.

## Updates, restore, and reinstall

- An application update does not change `pos.db`, the shop ID, or the installed licence.
- Current backup/restore logic preserves the destination shop identity, preventing a backup from cloning another shop's licence or till identity.
- Reinstalling over the same application data keeps the licence.
- Deleting application data or creating a genuinely new shop creates a new shop ID and requires a newly issued licence.
- Renaming a till or shop display label does not change the shop ID.

## Enforcement modes

Normal builds enforce the 10-day trial and signed licence. Rust checks new card-payment creation/retry as well as native sale commits. Provider status checks, cancellation and finishing an existing signature interaction remain available after expiry so an in-progress payment can be resolved.

An approved card payment that crosses the licence-expiry boundary can still require renewal before the POS commits its sale. The durable payment journal is retained for recovery: do not charge the card again or delete the journal. Fully automatic completion across expiry needs a native, persisted pre-payment authorisation tied to the exact sale; a renderer-supplied `approved` flag must not bypass licensing.

For temporary development or UI testing only, enforcement can be disabled at compile time:

```bash
LBJ_LICENSE_ENFORCEMENT=off npm run tauri -- dev
```

Never use the disabled setting for a customer build.

## Offline limitations

Cloud CRM provides hosted issuance and renewal records, but the POS does not consult it when validating an installed licence. It cannot immediately revoke an offline licence or automatically collect/confirm yearly payment. Marking an issue cancelled in Licence Studio or the CRM is an administrative record; a token already installed at a shop remains valid until its signed expiry date. Invalid or materially future trial dates are rejected, but expiry still relies on the till clock and a machine administrator can tamper with local data. Online revocation, trustworthy time and bounded offline grace require an additional protocol, not merely a website status toggle.

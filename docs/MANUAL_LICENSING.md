# L&Bj POS Manual Licensing

## Purpose

The manual licence is bound to the shop, not to a till name. One signed licence can cover a standalone till or a multi-till shop up to its stated till allowance. It works without a licensing server.

Till allowance uses active real register IDs. The obsolete `register-main` and `legacy-till` placeholders created by older builds are ignored; ordinary till records are never deduplicated merely because their display names match.

The POS contains only a public verification key. The matching private issuer key remains on the issuer's trusted machine and is the only thing capable of creating valid licences.

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

For renewal, create a fresh request and issue another licence for the same shop ID with a later expiry date. Importing it replaces the old signed token. It does not replace products, settings, orders, receipt numbers, or the SQLite database.

In multi-till mode, activation is written to the shared shop identity and synchronizes to the other tills. In standalone mode, it remains in that till's `pos.db`.

## Updates, restore, and reinstall

- An application update does not change `pos.db`, the shop ID, or the installed licence.
- Current backup/restore logic preserves the destination shop identity, preventing a backup from cloning another shop's licence or till identity.
- Reinstalling over the same application data keeps the licence.
- Deleting application data or creating a genuinely new shop creates a new shop ID and requires a newly issued licence.
- Renaming a till or shop display label does not change the shop ID.

## Enforcement modes

Normal builds enforce the 10-day trial and signed licence. The check is in Rust rather than only in the Svelte interface, so hiding or bypassing the dialog cannot commit a native sale after access expires.

For temporary development or UI testing only, enforcement can be disabled at compile time:

```bash
LBJ_LICENSE_ENFORCEMENT=off npm run tauri -- dev
```

Never use the disabled setting for a customer build.

## Offline limitations

Because there is no vendor server, an offline licence cannot be revoked immediately and cannot automatically collect or confirm yearly payment. Expiry relies on the machine's date, so determined clock tampering is not fully preventable. The next commercial stage can add a small vendor API for renewal, revocation, recovery, and bounded offline grace while retaining signed local verification.

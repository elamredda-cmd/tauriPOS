# Private Cash Control

Cash Control is an administrator-only daily drawer reconciliation, not a sales adjustment. Open **Settings → Administration → Cash Control** in the installed Tauri app. It is hidden from other staff roles and support sessions; native commands independently verify the administrator's active profile and fresh PIN on every read/save.

## Workflow

1. Finish trading on the selected till and synchronize it. Complete or recover pending card payments first.
2. Choose the till and business date, then enter the administrator PIN.
3. Enter the cash at the start of that date (opening float), the cash physically counted now, and a private note. Expected cash is not shown in the initial counting form.
4. Re-enter the PIN to save. The private result shows expected cash, counted cash and the difference.
5. To correct a counting/float mistake, use **Correct count**, supply a reason and verify the PIN again. Each correction appends a new revision; the original record and cash-flow snapshot remain unchanged.

Expected cash = opening cash + cash sales net of cash refunds + cash account repayments + signed cash movements − sale/account cashback payouts. Pay Later charges and card sales are not drawer cash. Money removed from the drawer must be recorded as a cash movement, not disguised as a correction to sales.

One count chain exists per till/business date. Dates use this computer's local timezone, including daylight-saving changes. For today's count, the snapshot ends at save time; later sales are **not** added to that snapshot. Count after trading ends. A correction changes the declared count/float, not the captured cash-flow period. This is independent of till-shift and Z-report closing.

## Privacy and reporting

Private entries are not written to sales, payments, cash movements or Z-close markers. Counts, corrections, private reasons and differences do not appear on ordinary reports, customer receipts, exports or owner-dashboard reporting. They remain visible in the private Cash Control history. This is application access control, not encryption from a database administrator or someone with unrestricted access to the computer.

PIN values stay only in transient input/request memory; they are not saved in the count ledger or browser storage. Inputs use the page's own masked PIN pad, not the global keyboard buffer. Private access locks on app focus/visibility loss, navigation, staff/source changes or five minutes of inactivity. A submitted native save may finish after the screen locks: unlock and inspect history before trying again.

## Storage and recovery

- Standalone mode: stored in `private_cash_control_entries` in the local SQLite database; included in a full local database backup.
- Shared mode: stored authoritatively in MariaDB and read only after PIN verification. A local till-cache backup does **not** include this shared ledger; back up MariaDB separately.
- No offline writes to the shared ledger. Failed/ambiguous submissions retain the same request ID for a safe retry. Concurrent corrections must reference the current revision.
- Normal **Delete History** and **Wipe Local Cache & Pull** exclude the private tables. After sales history is deleted, saved counts can still be corrected from their original snapshots, but a new expected-cash total cannot be reconstructed for a deleted period.
- Changing from standalone to shared mode does not migrate private local records automatically. Database-file replacement, dropping MariaDB or restoring an older full database is different from ordinary sales-history cleanup and may replace private records too.

## Verification

Automated checks cover input validation, administrator-only routing, native PIN verification, exact cash arithmetic, returns, split payments, cashback, account repayments, till/date scope, append-only corrections, same-request retries, stale revisions, purge/pending-payment guards and 23/25-hour daylight-saving dates. Shared SQL is also exercised against an empty disposable MariaDB test schema, never the shop database.

Browser preview verification confirms this page refuses private access outside Tauri. The related checkout scan test confirmed that a full keyboard-wedge barcode closes the ordinary sale-complete prompt, adds the next item once, and does not duplicate it on a second Enter.

Native macOS verification on 23 September 2026 used the user's explicitly authorized mock-data laptop: administrator unlock, fresh-PIN save of a labelled £11 count with £0 opening float, then a labelled correction to £12. Both revisions were retained, expected cash stayed £11 and the private difference became £1 over. The 69 completed orders and their 128689-pence combined total were unchanged; the saved whole-system report remained 103684 pence and contained no Cash Control note. The two mock revisions were deliberately retained as append-only history.

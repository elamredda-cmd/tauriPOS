# Till and whole-system reporting periods

## Operating rule

- **X / preview:** reads the current period without closing it.
- **This till Z:** covers this till from its latest own Z **or** the latest whole-system Z, whichever is later, up to the displayed cutoff.
- **Whole-system Z:** covers all tills from the previous whole-system Z up to its coordinated cutoff. Individual till closes do not remove their sales from this shop-wide report.
- A successful whole-system close advances every till's next report. Existing saved reports are not rewritten.
- Date-range sales reports are independent historical queries; closing a Z does not erase sales from them.

Example: a shop close on Monday followed by a till close on Thursday starts that till's report at Monday's shop cutoff, not an earlier individual till close. A till closed on Wednesday can still contribute its Wednesday sales to the next whole-shop report. **Do not add till Z totals to whole-system Z totals:** these are different views of overlapping business activity.

Periods are start-inclusive and end-exclusive (`start <= transaction < cutoff`), so a transaction exactly at the cutoff enters the next period once.

## Research

The [Epos Now cash-up guide](https://www.eposnow.com/uk/resources/how-to-balance-a-cash-register-till/) distinguishes an X snapshot without reset from a Z closing/resetting a trading period. [Lightspeed's register closure documentation](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534252854043-Using-the-register-closure-report) describes fixed register open/close windows and server-time closure boundaries. The cross-scope rule above is this app's explicit design choice: a whole-shop close closes all tills, while individual till closes do not truncate the shop's independent cumulative period.

## Concurrency, offline tills and cash counts

In multi-till mode the authoritative cutoff is MariaDB server time. A whole-system close waits for active tills, financial outboxes, unresolved terminal payments and retained financial conflicts to be ready; it freezes financial writes while the final snapshot is built. Another close cannot silently commit an already-reviewed old period. A cached/offline report may be read, but must not be presented as a completed authoritative multi-till Z.

Late offline writes from a closed reporting epoch are rejected for review, not inserted silently into an immutable closed report. Bring tills online and synchronize before closing; do not bypass a stuck close by deleting its marker or journal.

Standalone/browser closes also check that the displayed preview still starts at the latest effective marker, so an old window cannot close the same period again after a whole-system close.

Private cash counts/corrections are separate from these sales periods. They must not change revenue, payment totals, printed Z totals or close markers.

## Regression coverage

- `reportMarkers.test.ts`: effective till/system scope, mixed timestamp comparison, stale/invalid close rejection.
- `reportPeriodBoundaries.test.ts`: multi-day whole-system close → till X/Z, exact-cutoff sale, independent shop total and unchanged saved report.
- Native real-MariaDB whole-system close regression: coordinator and writer fences, no repeat sales in the next till close, later till marker leaves system and other-till markers unchanged, and late pre-close write rejection.

The native integration regression is run only against a dedicated disposable test schema, never the shop database.

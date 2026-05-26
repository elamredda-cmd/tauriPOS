<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { shiftsDB, cashMovementsDB, ordersDB, formatMoney, getEmployeeName } from '$lib/stores/db';

    let expandedId = '';
    function toggle(id: string) { expandedId = expandedId===id ? '' : id; }
    function getMovements(shiftId: string) { return $cashMovementsDB.filter(m => m.shiftId===shiftId); }
    function getShiftOrders(shiftId: string) { return $ordersDB.filter(o => o.shiftId===shiftId); }
    function shiftSales(shiftId: string) { return getShiftOrders(shiftId).filter(o=>o.status==='completed').reduce((s,o)=>s+o.total,0); }
</script>

<MgmtPage title="Shift History">
    <table class="tbl">
        <thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Status</th><th>Opening</th><th>Sales</th><th>Difference</th></tr></thead>
        <tbody>
            {#each $shiftsDB.slice().reverse() as s}
            <tr on:click={() => toggle(s.id)} class="cursor-pointer">
                <td class="font-semibold">{getEmployeeName(s.employeeId)}</td>
                <td>{new Date(s.openedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                <td>{s.closedAt ? new Date(s.closedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '-'}</td>
                <td><span class="tag" style="color:{s.status==='open'?'var(--success)':'var(--text-muted)'}">{s.status}</span></td>
                <td>{formatMoney(s.openingFloat)}</td>
                <td class="money">{formatMoney(shiftSales(s.id))}</td>
                <td style="color:{s.cashDifference>=0?'var(--success)':'var(--danger)'}">{s.status==='closed'?formatMoney(s.cashDifference):'-'}</td>
            </tr>
            {#if expandedId===s.id}
            <tr><td colspan="7" class="!p-0">
                <div class="px-6 py-4 bg-bg-base grid grid-cols-3 gap-6">
                    <div>
                        <h4 class="text-[0.9rem] text-accent-primary mb-3">Cash Summary</h4>
                        <div class="flex justify-between py-1 text-[0.9rem]"><span>Opening Float</span><span>{formatMoney(s.openingFloat)}</span></div>
                        <div class="flex justify-between py-1 text-[0.9rem]"><span>Expected Cash</span><span>{formatMoney(s.expectedCash)}</span></div>
                        <div class="flex justify-between py-1 text-[0.9rem]"><span>Actual Cash</span><span>{formatMoney(s.actualCash)}</span></div>
                        <div class="flex justify-between py-1 text-[0.9rem]"><span>Over/Short</span><span style="color:{s.cashDifference>=0?'var(--success)':'var(--danger)'}">{formatMoney(s.cashDifference)}</span></div>
                    </div>
                    <div>
                        <h4 class="text-[0.9rem] text-accent-primary mb-3">Cash Movements</h4>
                        {#each getMovements(s.id) as m}
                        <div class="flex justify-between py-1 text-[0.9rem]"><span>{m.reason}</span><span style="color:{m.amount>=0?'var(--success)':'var(--danger)'}">{formatMoney(m.amount)}</span></div>
                        {/each}
                        {#if getMovements(s.id).length===0}<p class="text-text-muted">None</p>{/if}
                    </div>
                    <div>
                        <h4 class="text-[0.9rem] text-accent-primary mb-3">Orders ({getShiftOrders(s.id).length})</h4>
                        <p class="text-text-muted">Total sales: {formatMoney(shiftSales(s.id))}</p>
                    </div>
                </div>
            </td></tr>
            {/if}
            {/each}
            {#if $shiftsDB.length===0}<tr class="empty-row"><td colspan="7">No shifts recorded yet.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>



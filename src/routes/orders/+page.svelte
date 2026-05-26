<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { ordersDB, orderLinesDB, paymentsDB, formatMoney, getEmployeeName } from '$lib/stores/db';

    let expandedId = '';
    function toggle(id: string) { expandedId = expandedId === id ? '' : id; }
    function getLines(orderId: string) { return $orderLinesDB.filter(l => l.orderId === orderId); }
    function getPayments(orderId: string) { return $paymentsDB.filter(p => p.orderId === orderId); }
    function statusColor(s: string) {
        if (s==='completed') return 'var(--success)';
        if (s==='hold') return 'var(--warning)';
        if (s==='voided'||s==='returned') return 'var(--danger)';
        return 'var(--text-muted)';
    }
</script>

<MgmtPage title="Order History">
    <table class="tbl">
        <thead><tr><th>#</th><th>Date</th><th>Type</th><th>Status</th><th>Cashier</th><th>Items</th><th>Total</th></tr></thead>
        <tbody>
            {#each $ordersDB.slice().reverse() as o}
            <tr on:click={() => toggle(o.id)} class="cursor-pointer">
                <td class="mono">{o.orderNumber}</td>
                <td>{new Date(o.createdAt).toLocaleString('en-GB', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                <td><span class="tag">{o.type}</span></td>
                <td><span class="tag" style="color:{statusColor(o.status)}">{o.status}</span></td>
                <td>{getEmployeeName(o.employeeId)}</td>
                <td>{getLines(o.id).length}</td>
                <td class="money">{formatMoney(o.total)}</td>
            </tr>
            {#if expandedId === o.id}
            <tr><td colspan="7" class="!p-0">
                <div class="px-6 py-4 bg-bg-base flex flex-col gap-4">
                    <div>
                        <h4 class="text-[0.9rem] text-accent-primary mb-2">Line Items</h4>
                        <table class="tbl">
                            <thead><tr><th class="!bg-bg-panel">Product</th><th class="!bg-bg-panel">Qty</th><th class="!bg-bg-panel">Unit</th><th class="!bg-bg-panel">Discount</th><th class="!bg-bg-panel">Tax</th><th class="!bg-bg-panel">Line Total</th></tr></thead>
                            <tbody>
                                {#each getLines(o.id) as line}
                                <tr>
                                    <td>{line.productName}{line.isPriceOverride?' ⚡':''}</td>
                                    <td>{line.quantity}</td>
                                    <td>{formatMoney(line.unitPrice)}</td>
                                    <td>{line.discountAmount>0?formatMoney(line.discountAmount):'-'}</td>
                                    <td>{formatMoney(line.taxAmount)}</td>
                                    <td class="money">{formatMoney(line.lineTotal)}</td>
                                </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                    <div>
                        <h4 class="text-[0.9rem] text-accent-primary mb-2">Payments</h4>
                        {#each getPayments(o.id) as p}
                        <div class="flex items-center gap-3 py-1.5"><span class="tag">{p.method}</span><span class="money">{formatMoney(p.amount)}</span>{p.changeGiven>0?`(Change: ${formatMoney(p.changeGiven)})`:''}</div>
                        {/each}
                        {#if getPayments(o.id).length===0}<p class="text-text-muted">No payments recorded.</p>{/if}
                    </div>
                    {#if o.notes}<div><h4 class="text-[0.9rem] text-accent-primary mb-2">Notes</h4><p>{o.notes}</p></div>{/if}
                </div>
            </td></tr>
            {/if}
            {/each}
            {#if $ordersDB.length===0}<tr class="empty-row"><td colspan="7">No orders yet.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>



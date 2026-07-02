<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import {
        productsDB,
        suppliersDB,
        inventoryLogDB,
        formatMoney,
        now,
        uuid,
        type Product,
    } from '$lib/stores/db';
    import { adjustStock, getAll, upsert } from '$lib/stores/database';
    import { currentEmployee } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';

    type ReceiptLine = {
        id: string;
        productId: string;
        productName: string;
        quantity: number;
        unitCost: number;
    };

    let search = '';
    let supplierId = '';
    let reference = '';
    let notes = '';
    let lines: ReceiptLine[] = [];
    let saving = false;
    let history: any[] = [];

    $: supplierOptions = [
        { label: 'No supplier', value: '' },
        ...$suppliersDB.map((supplier) => ({ label: supplier.name, value: supplier.id })),
    ];
    $: availableProducts = $productsDB
        .filter((product) => product.isActive)
        .filter((product) => {
            const q = search.trim().toLowerCase();
            if (!q) return true;
            return [product.name, product.sku, product.barcode, product.scalePlu]
                .some((value) => String(value || '').toLowerCase().includes(q));
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);
    $: totalCost = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);

    function addProduct(product: Product) {
        const existing = lines.find((line) => line.productId === product.id);
        if (existing) existing.quantity += 1;
        else {
            lines = [
                ...lines,
                {
                    id: uuid(),
                    productId: product.id,
                    productName: product.name,
                    quantity: 1,
                    unitCost: product.costPrice || 0,
                },
            ];
        }
        lines = [...lines];
    }

    function updateLine(id: string, patch: Partial<ReceiptLine>) {
        lines = lines.map((line) => line.id === id ? { ...line, ...patch } : line);
    }

    function removeLine(id: string) {
        lines = lines.filter((line) => line.id !== id);
    }

    async function loadHistory() {
        try {
            history = (await getAll('stock_receipts'))
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, 20);
        } catch {
            history = [];
        }
    }

    async function saveReceipt() {
        if (!$currentEmployee) {
            toast('Sign in before receiving stock', 'error');
            return;
        }
        const validLines = lines.filter((line) => line.quantity > 0);
        if (validLines.length === 0) {
            toast('Add at least one product and quantity', 'error');
            return;
        }
        saving = true;
        const receiptId = uuid();
        const stamp = now();
        try {
            await upsert('stock_receipts', {
                id: receiptId,
                supplierId,
                employeeId: $currentEmployee.id,
                reference: reference.trim(),
                notes: notes.trim(),
                totalCost,
                status: 'received',
                createdAt: stamp,
                updatedAt: stamp,
            });
            for (const line of validLines) {
                await upsert('stock_receipt_lines', {
                    id: line.id,
                    receiptId,
                    productId: line.productId,
                    quantity: line.quantity,
                    unitCost: line.unitCost,
                    createdAt: stamp,
                    updatedAt: stamp,
                });
                await adjustStock(line.productId, line.quantity);
                const log = {
                    id: uuid(),
                    productId: line.productId,
                    quantityChange: line.quantity,
                    type: 'restock',
                    referenceId: receiptId,
                    employeeId: $currentEmployee.id,
                    notes: reference.trim() ? `Stock receipt ${reference.trim()}` : 'Stock receipt',
                    createdAt: stamp,
                    updatedAt: stamp,
                };
                await upsert('inventory_logs', log);
                inventoryLogDB.update((existing) => [...existing, log as any]);
                productsDB.update((items) => items.map((product) =>
                    product.id === line.productId
                        ? { ...product, stockLevel: (product.stockLevel || 0) + line.quantity, updatedAt: stamp }
                        : product,
                ));
            }
            toast('Stock received', 'success');
            lines = [];
            reference = '';
            notes = '';
            await loadHistory();
        } catch (error) {
            toast(`Could not save stock receipt: ${error}`, 'error');
        } finally {
            saving = false;
        }
    }

    onMount(loadHistory);
</script>

<MgmtPage title="Stock Receiving">
    <button slot="actions" class="btn btn-primary" disabled={saving || lines.length === 0} on:click={saveReceipt}>
        {saving ? 'Saving...' : 'Receive Stock'}
    </button>

    <div class="h-full overflow-y-auto p-5">
        <div class="grid gap-5 xl:grid-cols-[1fr_420px]">
            <section class="rounded-2xl border border-border-flat bg-bg-card p-5">
                <div class="mb-4 grid gap-3 lg:grid-cols-3">
                    <div class="field">
                        <CustomSelect label="Supplier" bind:value={supplierId} options={supplierOptions} />
                    </div>
                    <div class="field">
                        <label>Reference</label>
                        <input bind:value={reference} placeholder="Invoice or delivery note" />
                    </div>
                    <div class="field">
                        <label>Notes</label>
                        <input bind:value={notes} placeholder="Optional notes" />
                    </div>
                </div>

                <div class="mb-4 grid gap-3 lg:grid-cols-[1fr_180px]">
                    <div class="field">
                        <label>Find Product</label>
                        <input class="search-input !min-h-11" bind:value={search} placeholder="Search name, SKU, barcode, PLU..." />
                    </div>
                    <div class="rounded-xl border border-border-flat bg-bg-panel p-3 text-right">
                        <span class="block text-xs font-black uppercase tracking-[0.14em] text-text-muted">Receipt Total Cost</span>
                        <strong class="text-2xl text-success">{formatMoney(totalCost)}</strong>
                    </div>
                </div>

                <div class="mb-5 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {#each availableProducts as product}
                        <button
                            type="button"
                            class="rounded-xl border border-border-flat bg-bg-panel p-3 text-left transition hover:border-accent-primary hover:bg-bg-card-hover"
                            on:click={() => addProduct(product)}
                        >
                            <strong class="block truncate">{product.name}</strong>
                            <span class="text-xs text-text-muted">Stock {product.stockLevel || 0} · Cost {formatMoney(product.costPrice || 0)}</span>
                        </button>
                    {/each}
                </div>

                <div class="overflow-x-auto rounded-xl border border-border-flat">
                    <table class="w-full min-w-[700px] text-left">
                        <thead class="bg-bg-panel text-sm text-text-muted">
                            <tr>
                                <th class="p-3">Product</th>
                                <th class="p-3 w-32">Qty</th>
                                <th class="p-3 w-40">Unit Cost</th>
                                <th class="p-3 w-40">Line Cost</th>
                                <th class="p-3 w-24"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each lines as line}
                                <tr class="border-t border-border-flat">
                                    <td class="p-3 font-bold">{line.productName}</td>
                                    <td class="p-3">
                                        <input class="!h-11" type="number" min="1" value={line.quantity} on:change={(event) => updateLine(line.id, { quantity: Math.max(1, Number(event.currentTarget.value) || 1) })} />
                                    </td>
                                    <td class="p-3">
                                        <input class="!h-11" type="number" min="0" step="0.01" value={(line.unitCost / 100).toFixed(2)} on:change={(event) => updateLine(line.id, { unitCost: Math.max(0, Math.round((Number(event.currentTarget.value) || 0) * 100)) })} />
                                    </td>
                                    <td class="p-3 font-bold">{formatMoney(line.quantity * line.unitCost)}</td>
                                    <td class="p-3 text-right"><button class="btn btn-danger !min-h-10 !px-3" on:click={() => removeLine(line.id)}>Remove</button></td>
                                </tr>
                            {/each}
                            {#if lines.length === 0}
                                <tr><td colspan="5" class="p-8 text-center text-text-muted">Add products to receive stock.</td></tr>
                            {/if}
                        </tbody>
                    </table>
                </div>
            </section>

            <aside class="rounded-2xl border border-border-flat bg-bg-card p-5">
                <h2 class="m-0 mb-3 text-xl">Recent Receipts</h2>
                {#if history.length === 0}
                    <p class="text-text-muted">No stock receipts yet.</p>
                {:else}
                    <div class="grid gap-3">
                        {#each history as receipt}
                            <article class="rounded-xl border border-border-flat bg-bg-panel p-3">
                                <strong>{receipt.reference || 'Stock receipt'}</strong>
                                <p class="m-0 mt-1 text-sm text-text-muted">{new Date(receipt.createdAt).toLocaleString('en-GB')}</p>
                                <p class="m-0 mt-1 text-sm font-bold text-success">{formatMoney(receipt.totalCost || 0)}</p>
                            </article>
                        {/each}
                    </div>
                {/if}
            </aside>
        </div>
    </div>
</MgmtPage>

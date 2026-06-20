<script lang="ts">
    import { formatMoney, type Order, type Store } from '$lib/stores/db';
    import { defaultReceiptDesign, type ReceiptDesign } from '$lib/receipt';
    import { getScaleSaleDisplay } from '$lib/scaleSale';

    interface ReceiptLine {
        productName: string;
        quantity: number;
        unitPrice: number;
        lineTotal?: number;
        originalPrice?: number;
        notes?: string;
        sku?: string;
    }

    export let store: Store;
    export let order: Order;
    export let lines: ReceiptLine[] = [];
    export let cashierName = '';
    export let tillName = '';
    export let design: ReceiptDesign = defaultReceiptDesign;
    export let preview = false;

    $: width = design.paperWidth === '58mm' ? '58mm' : '80mm';
    $: textSize = design.textSize === 'small' ? '10px' : design.textSize === 'large' ? '14px' : '12px';
    $: lineGap = design.density === 'compact' ? '2px' : '5px';
    $: receiptFont = design.fontFamily === 'standard'
        ? 'Arial, Helvetica, sans-serif'
        : design.fontFamily === 'condensed'
            ? 'Arial Narrow, Helvetica Condensed, Arial, sans-serif'
            : 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    $: divider = design.paperWidth === '58mm' ? '------------------------' : '--------------------------------';
</script>

<div
    class="receipt-document"
    class:receipt-preview={preview}
    style="--receipt-width:{width}; --receipt-text-size:{textSize}; --receipt-line-gap:{lineGap}; --receipt-font:{receiptFont};"
>
    <div class="receipt-center">
        <h3>{design.headerText || store.name}</h3>
        {#if order.type === 'return'}
            <h4 class="receipt-reversal-title">{order.notes?.startsWith('Void of') ? 'VOID RECEIPT' : 'REFUND RECEIPT'}</h4>
        {/if}
        {#if design.showAddress && store.address}<p>{store.address}</p>{/if}
        {#if design.showPhone && store.phone}<p>{store.phone}</p>{/if}
        {#if design.showEmail && store.email}<p>{store.email}</p>{/if}
        {#if design.customMessage}<p class="receipt-message">{design.customMessage}</p>{/if}
    </div>

    <div class="receipt-divider">{divider}</div>
    <div class="receipt-meta">
        {#if design.showReceiptNumber}<div><span>Receipt</span><span>#{order.orderNumber || '—'}</span></div>{/if}
        {#if design.showDateTime}<div><span>Date</span><span>{new Date(order.completedAt || Date.now()).toLocaleString('en-GB')}</span></div>{/if}
        {#if design.showCashier}<div><span>Cashier</span><span>{cashierName || order.employeeId || '—'}</span></div>{/if}
        {#if design.showTill}<div><span>Till</span><span>{tillName || order.tillNumber || '—'}</span></div>{/if}
        {#if order.type === 'return' && order.notes}<div><span>Reference</span><span>{order.notes}</span></div>{/if}
    </div>

    <div class="receipt-divider">{divider}</div>
    <div class="receipt-lines">
        {#each lines as line}
            {@const scaleDisplay = getScaleSaleDisplay(line.notes, line.quantity, line.unitPrice, line.originalPrice)}
            {@const isPartialRefundLine = line.quantity === 0 && line.notes?.includes('Proportional partial refund')}
            <div class="receipt-line">
                <span>{isPartialRefundLine ? 'Part' : scaleDisplay.label}</span>
                <span>
                    {line.productName}
                    {#if scaleDisplay.kind === 'weight' && line.originalPrice}
                        <small>{formatMoney(line.originalPrice)}/kg</small>
                    {/if}
                    {#if design.showSku && line.sku}<small>{line.sku}</small>{/if}
                </span>
                <span>{formatMoney(line.lineTotal ?? line.unitPrice * line.quantity)}</span>
            </div>
        {/each}
    </div>

    <div class="receipt-divider">{divider}</div>
    <div class="receipt-totals">
        {#if (order.discountAmount || 0) !== 0}
            <div><span>Subtotal</span><span>{formatMoney(order.subtotal || 0)}</span></div>
            <div><span>Discount</span><span>{formatMoney(-(order.discountAmount || 0))}</span></div>
        {/if}
        <div class="receipt-total"><span>Total</span><span>{formatMoney(order.total || 0)}</span></div>
        {#if design.showPayment}
            <div><span>{(order.paymentMethod || 'cash').toUpperCase()}</span><span>{formatMoney(order.amountTendered || order.total || 0)}</span></div>
            {#if (order.amountTendered || 0) > order.total}
                <div><span>Change</span><span>{formatMoney((order.amountTendered || 0) - order.total)}</span></div>
            {/if}
        {/if}
    </div>

    <div class="receipt-divider">{divider}</div>
    <div class="receipt-center">
        <p>{design.footerText || store.receiptFooter}</p>
        {#if design.showBarcode}<div class="receipt-barcode">||| |||| | || |||</div>{/if}
    </div>
</div>

<style>
    .receipt-document {
        width: var(--receipt-width);
        max-width: 100%;
        box-sizing: border-box;
        padding: 5mm;
        background: white;
        color: black;
        font-family: var(--receipt-font);
        font-size: var(--receipt-text-size);
        line-height: 1.3;
    }
    .receipt-preview { box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25); }
    .receipt-center { text-align: center; }
    h3 { margin: 0 0 4px; font-size: 1.25em; }
    .receipt-reversal-title { margin: 5px 0 2px; font-size: 1.1em; letter-spacing: .08em; }
    p { margin: 1px 0; white-space: pre-line; }
    .receipt-message { margin-top: 5px; }
    .receipt-divider { overflow: hidden; white-space: nowrap; margin: 5px 0; text-align: center; }
    .receipt-meta, .receipt-totals, .receipt-lines { display: flex; flex-direction: column; gap: var(--receipt-line-gap); }
    .receipt-meta > div, .receipt-totals > div { display: flex; justify-content: space-between; gap: 8px; }
    .receipt-meta > div span:last-child { text-align: right; }
    .receipt-line { display: grid; grid-template-columns: min-content 1fr min-content; gap: 5px; align-items: start; }
    .receipt-line > span:first-child, .receipt-line > span:last-child { white-space: nowrap; }
    .receipt-line > span:last-child { text-align: right; }
    small { display: block; opacity: 0.7; }
    .receipt-total { font-size: 1.15em; font-weight: 800; }
    .receipt-barcode { margin-top: 6px; font-size: 1.5em; letter-spacing: 2px; }

    @media print {
        :global(body *) { visibility: hidden !important; }
        :global(.receipt-print-target), :global(.receipt-print-target *) { visibility: visible !important; }
        :global(.receipt-print-target) {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: auto !important;
            max-height: none !important;
            overflow: visible !important;
            padding: 0 !important;
            margin: 0 !important;
            border: 0 !important;
            box-shadow: none !important;
        }
        .receipt-document { box-shadow: none; }
        @page { margin: 0; }
    }
</style>

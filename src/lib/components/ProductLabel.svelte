<script lang="ts">
    import Code39Barcode from './Code39Barcode.svelte';
    import { formatMoney, type Product, type Store } from '$lib/stores/db';
    import type { LabelDesign } from '$lib/labels';

    export let product: Product;
    export let store: Store;
    export let design: LabelDesign;
    export let preview = false;

    $: barcodeValue = product.barcode || product.sku || product.scalePlu || product.id.slice(0, 12);
    $: barcodeHeight = design.heightMm >= 50 ? 70 : design.heightMm >= 30 ? 42 : 28;
    $: labelFont = design.fontFamily === 'serif'
        ? 'Georgia, Times New Roman, serif'
        : design.fontFamily === 'condensed'
            ? 'Arial Narrow, Helvetica Condensed, Arial, sans-serif'
            : 'Arial, Helvetica, sans-serif';
    $: textScale = design.textScale === 'small' ? 0.86 : design.textScale === 'large' ? 1.18 : 1;
</script>

<article
    class="product-label template-{design.template}"
    class:preview
    style="--label-width:{design.widthMm}mm;--label-height:{design.heightMm}mm;--label-font:{labelFont};--label-text-scale:{textScale};"
>
    {#if design.showStore}<small class="store">{store.name}</small>{/if}
    {#if design.showName}<h2>{product.name}</h2>{/if}
    {#if design.showPrice}<strong class="price">{formatMoney(product.price)}</strong>{/if}
    <div class="barcode"><Code39Barcode value={barcodeValue} height={barcodeHeight} /></div>
    <footer>
        {#if design.showBarcodeText}<span>{barcodeValue}</span>{/if}
        {#if design.showSku && product.sku}<span>SKU {product.sku}</span>{/if}
        {#if design.showPlu && product.scalePlu}<span>PLU {product.scalePlu}</span>{/if}
    </footer>
</article>

<style>
    .product-label { width: var(--label-width); height: var(--label-height); padding: 2mm; overflow: hidden; display: grid; grid-template-rows: auto auto 1fr auto; align-content: start; color: #000; border: .25mm solid #000; background: #fff; font-family: var(--label-font); page-break-after: always; break-after: page; }
    .product-label.preview { max-width: 100%; transform-origin: top center; }
    .store { overflow: hidden; font-size: calc(2.4mm * var(--label-text-scale)); font-weight: 800; text-align: center; text-transform: uppercase; white-space: nowrap; }
    h2 { margin: .4mm 0; overflow: hidden; font-family: var(--label-font); font-size: clamp(8px, calc(3.3mm * var(--label-text-scale)), 22px); line-height: 1.05; text-align: center; white-space: nowrap; text-overflow: ellipsis; }
    .price { margin: .2mm 0; font-size: clamp(13px, calc(6mm * var(--label-text-scale)), 44px); line-height: 1; text-align: center; }
    .barcode { min-height: 0; overflow: hidden; display: flex; align-items: stretch; justify-content: center; }
    .barcode :global(.loyalty-barcode) { width: 100%; padding: .5mm; border-radius: 0; }
    .barcode :global(strong) { display: none; }
    footer { display: flex; justify-content: center; flex-wrap: wrap; gap: 1mm 2mm; overflow: hidden; font-size: calc(2mm * var(--label-text-scale)); font-family: ui-monospace, monospace; white-space: nowrap; }
    .template-compact { grid-template-columns: 1fr auto; grid-template-rows: auto 1fr auto; }
    .template-compact h2 { text-align: left; }
    .template-compact .price { grid-column: 2; grid-row: 1 / span 2; align-self: center; padding-left: 1mm; }
    .template-compact .barcode { grid-column: 1; }
    .template-compact footer { grid-column: 1 / -1; }
    .template-barcode .price { font-size: 4mm; }
    .template-shelf { grid-template-columns: 1fr auto; grid-template-rows: auto auto 1fr; }
    .template-shelf h2 { text-align: left; white-space: normal; }
    .template-shelf .price { grid-column: 2; grid-row: 1 / span 2; align-self: center; font-size: clamp(18px, 9mm, 54px); }
    .template-shelf .barcode, .template-shelf footer { grid-column: 1 / -1; }
    @media print {
        .product-label { margin: 0; border: none; }
    }
</style>

<script lang="ts">
    import Code39Barcode from './Code39Barcode.svelte';
    import { formatMoney, type Product, type Store } from '$lib/stores/db';
    import type { LabelDesign } from '$lib/labels';

    export let product: Product;
    export let store: Store;
    export let design: LabelDesign;
    export let preview = false;

    $: labelWidth = Math.max(15, Number(design.widthMm) || 50);
    $: labelHeight = Math.max(15, Number(design.heightMm) || 30);
    $: isWideLabel = labelWidth >= 70;
    $: isTallLabel = labelHeight >= 45;
    $: labelPadding = labelWidth >= 70 ? 3 : labelWidth <= 32 ? 1.4 : 2;
    $: nameLines = isWideLabel && isTallLabel ? 2 : 1;
    $: barcodeValue = product.barcode || product.sku || product.scalePlu || product.id.slice(0, 12);
    $: barcodeHeight = labelHeight >= 70 ? 92 : labelHeight >= 50 ? 70 : labelHeight >= 30 ? 44 : 28;
    $: labelFont = design.fontFamily === 'serif'
        ? 'Georgia, Times New Roman, serif'
        : design.fontFamily === 'condensed'
            ? 'Arial Narrow, Helvetica Condensed, Arial, sans-serif'
            : 'Arial, Helvetica, sans-serif';
    $: textScale = design.textScale === 'small' ? 0.86 : design.textScale === 'large' ? 1.18 : 1;
    $: nameScale = design.nameTextScale === 'small' ? 0.86 : design.nameTextScale === 'large' ? 1.18 : 1;
    $: priceScale = design.priceTextScale === 'small' ? 0.86 : design.priceTextScale === 'large' ? 1.18 : 1;
</script>

<article
    class="product-label template-{design.template}"
    class:wide={isWideLabel}
    class:tall={isTallLabel}
    class:preview
    style="--label-width:{labelWidth}mm;--label-height:{labelHeight}mm;--label-padding:{labelPadding}mm;--label-name-lines:{nameLines};--label-font:{labelFont};--label-text-scale:{textScale};--label-name-scale:{nameScale};--label-price-scale:{priceScale};"
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
    .product-label { width: var(--label-width); height: var(--label-height); padding: var(--label-padding); overflow: hidden; display: grid; grid-template-rows: auto auto 1fr auto; align-content: start; color: #000; border: .25mm solid #000; background: #fff; font-family: var(--label-font); page-break-after: always; break-after: page; }
    .product-label.preview { max-width: 100%; transform-origin: top center; }
    .store { overflow: hidden; font-size: calc(2.4mm * var(--label-text-scale)); font-weight: 800; text-align: center; text-transform: uppercase; white-space: nowrap; }
    h2 { margin: .4mm 0; overflow: hidden; display: -webkit-box; font-family: var(--label-font); font-size: clamp(8px, calc(3.3mm * var(--label-name-scale)), 22px); line-height: 1.05; text-align: center; text-overflow: ellipsis; -webkit-line-clamp: var(--label-name-lines); -webkit-box-orient: vertical; }
    .price { margin: .2mm 0; font-size: clamp(13px, calc(6mm * var(--label-price-scale)), 44px); line-height: 1; text-align: center; }
    .barcode { min-height: 0; overflow: hidden; display: flex; align-items: stretch; justify-content: center; }
    .barcode :global(.loyalty-barcode) { width: 100%; padding: .5mm; border-radius: 0; }
    .barcode :global(strong) { display: none; }
    footer { display: flex; justify-content: center; flex-wrap: wrap; gap: 1mm 2mm; overflow: hidden; font-size: calc(2mm * var(--label-text-scale)); font-family: ui-monospace, monospace; white-space: nowrap; }
    .template-compact { grid-template-columns: 1fr auto; grid-template-rows: auto 1fr auto; }
    .template-compact h2 { text-align: left; }
    .template-compact .price { grid-column: 2; grid-row: 1 / span 2; align-self: center; padding-left: 1mm; }
    .template-compact .barcode { grid-column: 1; }
    .template-compact footer { grid-column: 1 / -1; }
    .template-barcode .price { font-size: calc(4mm * var(--label-price-scale)); }
    .template-shelf { grid-template-columns: 1fr auto; grid-template-rows: auto auto 1fr; }
    .template-shelf h2 { text-align: left; }
    .template-shelf .price { grid-column: 2; grid-row: 1 / span 2; align-self: center; font-size: clamp(18px, calc(9mm * var(--label-price-scale)), 54px); }
    .template-shelf .barcode, .template-shelf footer { grid-column: 1 / -1; }
    .wide:not(.template-compact):not(.template-shelf) { grid-template-rows: auto auto minmax(0, 1fr) auto; }
    .wide h2 { font-size: clamp(10px, calc(3.8mm * var(--label-name-scale)), 26px); }
    .wide .price { font-size: clamp(20px, calc(8mm * var(--label-price-scale)), 54px); }
    .wide footer { font-size: calc(2.25mm * var(--label-text-scale)); }
    @media print {
        .product-label { margin: 0; border: none; }
    }
</style>

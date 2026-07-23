<script lang="ts">
    import { onMount } from 'svelte';
    import Code39Barcode from './Code39Barcode.svelte';
    import { formatMoney, type Product, type Store } from '$lib/stores/db';
    import { formatLabelPrintDate, formatLabelProductName, labelSizeScale, type LabelDesign } from '$lib/labels';

    export let product: Product;
    export let store: Store;
    export let design: LabelDesign;
    export let preview = false;

    let labelElement: HTMLElement;
    let previewWidth = 360;
    let previewHeight = 420;

    $: labelWidth = Math.max(15, Number(design.widthMm) || 50);
    $: labelHeight = Math.max(15, Number(design.heightMm) || 30);
    $: isWideLabel = labelWidth >= 70;
    $: isTallLabel = labelHeight >= 45;
    $: labelPadding = labelWidth >= 70 ? 1.5 : labelWidth <= 32 ? 0.8 : 1;
    $: labelTopPadding = labelWidth >= 70 ? 0.25 : labelWidth <= 32 ? 0 : 0.05;
    $: nameLines = isWideLabel && isTallLabel ? 2 : 1;
    $: barcodeValue = String(product.barcode || '').trim();
    $: showBarcode = design.showBarcode !== false && Boolean(barcodeValue);
    $: barcodeHeight = Math.round(
        (labelHeight >= 70 ? 92 : labelHeight >= 50 ? 70 : labelHeight >= 30 ? 44 : 28)
        * labelSizeScale(design.barcodeSizePercent),
    );
    $: showPrintDate = design.showPrintDate === true;
    $: printDate = formatLabelPrintDate();
    $: productName = formatLabelProductName(product.name, design.nameCharacterLimit);
    $: datePosition = design.printDatePosition || 'bottom-right';
    $: dateAtTop = datePosition.startsWith('top-');
    $: previewScale = preview
        ? Math.min(1.6, Math.max(0.25, Math.min(previewWidth / (labelWidth * 3.78), previewHeight / (labelHeight * 3.78))))
        : 1;
    $: labelFont = design.fontFamily === 'serif'
        ? 'Georgia, Times New Roman, serif'
        : design.fontFamily === 'condensed'
            ? 'Arial Narrow, Helvetica Condensed, Arial, sans-serif'
            : 'Arial, Helvetica, sans-serif';
    $: textScale = labelSizeScale(design.textSizePercent);
    $: nameScale = labelSizeScale(design.nameSizePercent);
    $: priceScale = labelSizeScale(design.priceSizePercent);
    $: dateReserve = showPrintDate ? Math.max(1.8, 2.25 * textScale) : 0;

    onMount(() => {
        if (!preview || !labelElement?.parentElement) return;
        const container = labelElement.parentElement;
        const updatePreviewBounds = () => {
            const style = getComputedStyle(container);
            const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
            const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            previewWidth = Math.min(360, Math.max(80, container.clientWidth - horizontalPadding - 4));
            previewHeight = Math.min(420, Math.max(80, container.clientHeight - verticalPadding - 4));
        };
        updatePreviewBounds();
        const observer = new ResizeObserver(updatePreviewBounds);
        observer.observe(container);
        return () => observer.disconnect();
    });
</script>

<article
    bind:this={labelElement}
    class="product-label template-{design.template}"
    class:wide={isWideLabel}
    class:tall={isTallLabel}
    class:preview
    class:noBarcode={!showBarcode}
    style="--label-width:{labelWidth}mm;--label-height:{labelHeight}mm;--label-padding:{labelPadding}mm;--label-top-padding:{labelTopPadding}mm;--label-date-top-reserve:{showPrintDate && dateAtTop ? dateReserve : 0}mm;--label-date-bottom-reserve:{showPrintDate && !dateAtTop ? dateReserve : 0}mm;--label-name-lines:{nameLines};--label-font:{labelFont};--label-text-scale:{textScale};--label-name-scale:{nameScale};--label-price-scale:{priceScale};--label-barcode-height:{barcodeHeight}px;--label-preview-scale:{previewScale};"
>
    {#if showPrintDate}<time class="print-date {datePosition}">{printDate}</time>{/if}
    {#if design.showStore}<small class="store">{store.name}</small>{/if}
    {#if design.showName}<h2>{productName}</h2>{/if}
    {#if design.showPrice}<strong class="price">{formatMoney(product.price)}</strong>{/if}
    {#if showBarcode}<div class="barcode"><Code39Barcode value={barcodeValue} height={barcodeHeight} /></div>{/if}
    <footer>
        {#if showBarcode && design.showBarcodeText}<span>{barcodeValue}</span>{/if}
        {#if design.showSku && product.sku}<span>SKU {product.sku}</span>{/if}
        {#if design.showPlu && product.scalePlu}<span>PLU {product.scalePlu}</span>{/if}
    </footer>
</article>

<style>
    .product-label { position: relative; box-sizing: border-box; width: var(--label-width); height: var(--label-height); padding: calc(var(--label-top-padding) + var(--label-date-top-reserve)) var(--label-padding) calc(var(--label-padding) + var(--label-date-bottom-reserve)); overflow: hidden; display: grid; grid-template-rows: min-content min-content minmax(0, 1fr) min-content; gap: .25mm; align-content: stretch; color: #000; border: .25mm solid #000; background: #fff; font-family: var(--label-font); page-break-after: always; break-after: page; }
    .product-label.preview { max-width: 100%; transform-origin: top center; zoom: var(--label-preview-scale); }
    .store { overflow: hidden; font-size: calc(2.4mm * var(--label-text-scale)); font-weight: 800; text-align: center; text-transform: uppercase; white-space: nowrap; }
    h2 { margin: 0 0 .2mm; overflow: hidden; display: -webkit-box; font-family: var(--label-font); font-size: clamp(8px, calc(3.3mm * var(--label-name-scale)), 22px); line-height: 1.05; text-align: center; text-overflow: ellipsis; -webkit-line-clamp: var(--label-name-lines); line-clamp: var(--label-name-lines); -webkit-box-orient: vertical; }
    .price { margin: .2mm 0; font-size: clamp(13px, calc(4.6mm * var(--label-price-scale)), 38px); line-height: 1; text-align: center; }
    .barcode { height: var(--label-barcode-height); max-height: 100%; min-height: 0; overflow: hidden; display: flex; align-self: end; align-items: stretch; justify-content: center; }
    .barcode :global(.loyalty-barcode) { box-sizing: border-box; width: 100%; height: 100%; padding: .35mm; border-radius: 0; }
    .barcode :global(svg) { height: 100% !important; min-height: 0; }
    .barcode :global(strong) { display: none; }
    footer { display: flex; justify-content: center; flex-wrap: wrap; gap: 1mm 2mm; overflow: hidden; font-size: calc(2mm * var(--label-text-scale)); font-family: ui-monospace, monospace; white-space: nowrap; }
    .print-date { position: absolute; z-index: 1; overflow: hidden; max-width: calc(100% - var(--label-padding) * 2); color: #000; font-family: var(--label-font); font-size: max(6px, calc(1.8mm * var(--label-text-scale))); font-weight: 700; line-height: 1; white-space: nowrap; }
    .print-date.top-left, .print-date.top-center, .print-date.top-right { top: max(.2mm, var(--label-top-padding)); }
    .print-date.bottom-left, .print-date.bottom-center, .print-date.bottom-right { bottom: .3mm; }
    .print-date.top-left, .print-date.bottom-left { left: var(--label-padding); }
    .print-date.top-center, .print-date.bottom-center { left: 50%; transform: translateX(-50%); }
    .print-date.top-right, .print-date.bottom-right { right: var(--label-padding); }
    .noBarcode .price { align-self: center; }
    .template-compact { grid-template-columns: 1fr auto; grid-template-rows: auto 1fr auto; }
    .template-compact h2 { text-align: left; }
    .template-compact .price { grid-column: 2; grid-row: 1 / span 2; align-self: start; padding-left: .5mm; padding-right: 3.2mm; }
    .template-compact .barcode { grid-column: 1; }
    .template-compact footer { grid-column: 1 / -1; }
    .template-barcode .price { font-size: calc(3.2mm * var(--label-price-scale)); }
    .template-shelf { grid-template-columns: 1fr auto; grid-template-rows: auto auto 1fr; }
    .template-shelf h2 { text-align: left; }
    .template-shelf .price { grid-column: 2; grid-row: 1 / span 2; align-self: start; padding-left: .5mm; padding-right: 3.2mm; font-size: clamp(18px, calc(6.8mm * var(--label-price-scale)), 48px); }
    .template-shelf .barcode, .template-shelf footer { grid-column: 1 / -1; }
    .wide:not(.template-compact):not(.template-shelf) { grid-template-rows: auto auto minmax(0, 1fr) auto; }
    .wide h2 { font-size: clamp(10px, calc(3.8mm * var(--label-name-scale)), 26px); }
    .wide .price { font-size: clamp(18px, calc(6.2mm * var(--label-price-scale)), 48px); }
    .wide footer { font-size: calc(2.25mm * var(--label-text-scale)); }
    @media print {
        .product-label { margin: 0; border: none; }
    }
</style>

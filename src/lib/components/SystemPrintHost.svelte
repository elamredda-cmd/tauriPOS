<script lang="ts">
    import Receipt from '$lib/components/Receipt.svelte';
    import { systemPrintJob } from '$lib/systemPrint';
</script>

{#if $systemPrintJob}
    <div class="system-print-host receipt-print-target" aria-hidden="true">
        {#if $systemPrintJob.kind === 'receipt'}
            <Receipt
                store={$systemPrintJob.payload.store}
                order={$systemPrintJob.payload.order}
                lines={$systemPrintJob.payload.lines}
                cashierName={$systemPrintJob.payload.cashierName}
                tillName={$systemPrintJob.payload.tillName}
                design={$systemPrintJob.payload.design}
            />
        {:else}
            <article
                class="system-text-document"
                style={`--system-paper-width:${$systemPrintJob.paperWidth}`}
            >
                <h1>{$systemPrintJob.title}</h1>
                <pre>{$systemPrintJob.text}</pre>
            </article>
        {/if}
    </div>
{/if}

<style>
    .system-print-host {
        position: fixed;
        left: -10000px;
        top: 0;
        pointer-events: none;
        visibility: hidden;
    }

    .system-text-document {
        box-sizing: border-box;
        width: var(--system-paper-width);
        padding: 5mm;
        background: white;
        color: black;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
    }

    .system-text-document h1 {
        margin: 0 0 4mm;
        font-size: 16px;
        text-align: center;
    }

    .system-text-document pre {
        margin: 0;
        overflow: visible;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
    }

    @media print {
        :global(body.system-printing *) {
            visibility: hidden !important;
        }

        :global(body.system-printing .receipt-print-target:not(.system-print-host)) {
            display: none !important;
        }

        .system-print-host,
        .system-print-host :global(*) {
            visibility: visible !important;
        }

        .system-print-host {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            display: block !important;
            pointer-events: auto;
        }

        @page {
            margin: 0;
        }
    }
</style>

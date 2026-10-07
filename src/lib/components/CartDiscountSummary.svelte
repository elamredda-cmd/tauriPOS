<script lang="ts">
    import Modal from '$lib/components/Modal.svelte';
    import type { CartEvaluation } from '$lib/utils/discountEngine';
    import { summarizeCartDiscounts } from '$lib/utils/cartDiscountSummary';

    export let lines: CartEvaluation['lines'] = [];
    export let formatMoney: (pence: number) => string;
    export let eligibilityHint = '';
    export let eligibilityTitle = '';
    export let showDetails = false;

    $: discounts = summarizeCartDiscounts(lines);
    $: totalSavings = discounts.reduce((sum, discount) => sum + discount.savings, 0);
    $: hasOffers = discounts.length > 0 || Boolean(eligibilityHint);
    $: if (!hasOffers) showDetails = false;
</script>

<!-- Keep this small slot even without an offer: totals and item space never jump. -->
<div class="cart-discount-slot">
    {#if hasOffers}
        <button
            type="button"
            class="cart-discount-trigger"
            class:eligible={discounts.length === 0}
            aria-label={discounts.length > 0
                ? `View ${discounts.length} applied ${discounts.length === 1 ? 'discount' : 'discounts'}, saved ${formatMoney(totalSavings)}`
                : 'View available offer'}
            aria-haspopup="dialog"
            aria-expanded={showDetails}
            on:click={() => (showDetails = true)}
        >
            <span>{discounts.length > 0 ? `${discounts.length} ${discounts.length === 1 ? 'discount' : 'discounts'}` : 'Offer available'}</span>
            {#if discounts.length > 0}<strong>−{formatMoney(totalSavings)}</strong>{/if}
            <span class="cart-discount-chevron" aria-hidden="true">›</span>
        </button>
    {/if}
</div>

<Modal bind:show={showDetails} title="Discounts and offers" width="480px">
    <section class="cart-discount-summary" aria-label="Offer details">
        {#if discounts.length > 0}
            <div class="cart-discount-heading">Discounts applied</div>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll through every discount.) -->
            <div
                class="cart-discount-scroll"
                role="region"
                aria-label="Applied discounts, scroll for more"
                tabindex="0"
            >
                <ul>
                    {#each discounts as discount (discount.discountId)}
                        <li>
                            <span class="cart-discount-name">{discount.discountName}</span>
                            <span class="cart-discount-saving">−{formatMoney(discount.savings)}</span>
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}
        {#if eligibilityHint}
            <p class="cart-discount-eligible" title={eligibilityTitle || undefined}>
                {eligibilityHint}
            </p>
        {/if}
    </section>
    <button slot="footer" type="button" class="btn btn-primary" data-modal-initial-focus on:click={() => (showDetails = false)}>Done</button>
</Modal>

<style>
    .cart-discount-slot {
        block-size: 1.75rem;
        min-block-size: 1.75rem;
        min-width: 0;
        width: 100%;
    }

    .cart-discount-trigger {
        display: flex;
        align-items: center;
        gap: .3rem;
        width: max-content;
        max-width: 100%;
        height: 100%;
        margin: 0;
        padding: 0 .2rem;
        border: 0;
        border-radius: .3rem;
        background: transparent;
        color: var(--success);
        font-size: .75rem;
        font-weight: 700;
        cursor: pointer;
    }

    .cart-discount-trigger > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cart-discount-trigger strong { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .cart-discount-chevron { flex: none; font-size: 1.1rem; line-height: 1; }
    .cart-discount-trigger.eligible { color: var(--warning); }
    .cart-discount-trigger:hover { background: var(--bg-card-hover); }
    .cart-discount-trigger:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }

    .cart-discount-summary {
        min-width: 0;
        width: 100%;
        font-size: .95rem;
        line-height: 1.5;
    }

    .cart-discount-heading {
        margin-bottom: .65rem;
        color: var(--text-muted);
        font-size: .85rem;
        font-weight: 700;
    }

    .cart-discount-scroll {
        max-block-size: min(45dvh, 24rem);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        border-radius: .25rem;
    }

    .cart-discount-scroll:focus-visible {
        outline: 2px solid var(--accent-primary);
        outline-offset: 2px;
    }

    ul {
        display: grid;
        gap: .5rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) max-content;
        align-items: start;
        column-gap: .65rem;
        padding-block: .35rem;
    }

    .cart-discount-name {
        min-width: 0;
        color: var(--text-main);
        font-weight: 600;
        white-space: normal;
        overflow-wrap: anywhere;
    }

    .cart-discount-saving {
        color: var(--success);
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: nowrap;
    }

    .cart-discount-eligible {
        margin: .25rem 0 0;
        color: var(--warning);
        font-weight: 600;
        white-space: normal;
        overflow-wrap: anywhere;
    }
</style>

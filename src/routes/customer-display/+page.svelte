<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import { listen } from '@tauri-apps/api/event';
    import { formatMoney } from '$lib/stores/db';
    import type { CustomerDisplayState } from '$lib/customerDisplay';

    let state: CustomerDisplayState = {
        storeName: 'L&Bj POS',
        tillName: '',
        lines: [],
        subtotal: 0,
        discount: 0,
        total: 0,
        status: 'shopping',
        message: 'Welcome',
        change: 0,
    };
    let linesEl: HTMLDivElement;
    let previousLinesKey = '';

    $: linesKey = state.lines
        .map((line) => `${line.name}|${line.quantity}|${line.unitPrice}|${line.total}|${line.discount}|${line.promotion?.status || ''}|${line.promotion?.label || ''}|${line.promotion?.text || ''}`)
        .join('¬');
    $: if (linesEl && state.status !== 'complete' && linesKey !== previousLinesKey) {
        previousLinesKey = linesKey;
        void scrollLinesToBottom();
    }

    async function scrollLinesToBottom() {
        await tick();
        if (!linesEl) return;
        linesEl.scrollTo({ top: linesEl.scrollHeight, behavior: 'smooth' });
    }

    onMount(() => {
        if (!isTauri()) return;
        let unlisten: (() => void) | undefined;
        listen<CustomerDisplayState>('customer-display-state', (event) => {
            state = event.payload;
        }).then((stop) => unlisten = stop);
        return () => unlisten?.();
    });
</script>

<svelte:head><title>Customer Display</title></svelte:head>

<main class="customer-display">
    <header>
        <div class="store-heading"><span>Welcome to</span><h1 title={state.storeName}>{state.storeName}</h1></div>
        <strong>{state.tillName}</strong>
    </header>

    {#if state.status === 'complete'}
        <section class="display-message">
            <span>Payment complete</span>
            <h2>{state.message || 'Thank you for shopping with us'}</h2>
            {#if state.change > 0}<strong>Change: {formatMoney(state.change)}</strong>{/if}
        </section>
    {:else}
        <section class="display-body">
            <div class="display-lines" bind:this={linesEl}>
                {#if state.lines.length === 0}
                    <div class="display-empty"><h2>Ready for your items</h2><p>Your shopping will appear here.</p></div>
                {:else}
                    {#each state.lines as line}
                        <article class:has-promotion={Boolean(line.promotion)}>
                            <div class="line-description">
                                <h3 title={line.name}>{line.name}</h3>
                                <span>{line.quantity} × {formatMoney(line.unitPrice)}</span>
                                {#if line.promotion}
                                    <div class="line-promotion {line.promotion.status}" title={line.promotion.text}>
                                        <b>{line.promotion.label}</b>
                                        <span>{line.promotion.text}</span>
                                    </div>
                                {/if}
                            </div>
                            <div class="line-total">
                                {#if line.discount > 0}<span>{formatMoney(line.total)}</span>{/if}
                                <strong>{formatMoney(line.total - line.discount)}</strong>
                                {#if line.discount > 0}<small>Saving {formatMoney(line.discount)}</small>{/if}
                            </div>
                        </article>
                    {/each}
                {/if}
            </div>
            <aside>
                <div><span>Subtotal</span><strong>{formatMoney(state.subtotal)}</strong></div>
                {#if state.discount > 0}<div class="saving"><span>Savings</span><strong>-{formatMoney(state.discount)}</strong></div>{/if}
                <div class="display-total"><span>Total</span><strong>{formatMoney(state.total)}</strong></div>
                <p>{state.status === 'payment' ? 'Payment in progress' : 'Thank you for shopping with us'}</p>
            </aside>
        </section>
    {/if}
</main>

<style>
    .customer-display { width: 100vw; height: 100vh; min-width: 0; overflow: hidden; padding: clamp(.75rem, 2.5vmin, 3rem); display: flex; flex-direction: column; gap: clamp(.65rem, 1.8vmin, 2rem); color: var(--text-main); background: var(--bg-base); }
    header { min-width: 0; min-height: clamp(4rem, 11vh, 7rem); display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: clamp(.55rem, 1.5vmin, 1rem); border-bottom: 1px solid var(--border-flat); }
    .store-heading { min-width: 0; }
    header span { color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: .14em; }
    h1 { max-width: min(70vw, 1100px); margin: .2rem 0 0; overflow: hidden; font-size: clamp(1.6rem, 4.5vmin, 4.5rem); line-height: 1; white-space: nowrap; text-overflow: ellipsis; }
    header strong { color: var(--accent-primary); font-size: clamp(1rem, 2vw, 1.5rem); }
    .display-body { min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1.6fr) clamp(260px, 30vw, 520px); gap: clamp(.65rem, 1.8vmin, 2rem); }
    .display-lines { min-width: 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: clamp(.4rem, 1vmin, .8rem); }
    article { position: relative; min-width: 0; min-height: clamp(4rem, 10vh, 6rem); padding: clamp(.65rem, 1.5vmin, 1.2rem); display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .8rem; background: var(--bg-card); }
    .line-description { min-width: 0; flex: 1; }
    article h3 { margin: 0 0 .25rem; overflow: hidden; font-size: clamp(.95rem, 2.2vmin, 1.6rem); white-space: nowrap; text-overflow: ellipsis; }
    article span { color: var(--text-muted); }
    article.has-promotion { min-height: clamp(5rem, 12vh, 7.2rem); }
    .line-promotion { min-width: 0; margin-top: .4rem; display: flex; align-items: center; gap: .45rem; color: var(--accent-primary); }
    .line-promotion.applied { color: var(--success); }
    .line-promotion b { flex: 0 0 auto; padding: .18rem .42rem; border: 1px solid currentColor; border-radius: 4px; font-size: clamp(.62rem, 1.35vmin, .82rem); line-height: 1; text-transform: uppercase; }
    .line-promotion span { min-width: 0; overflow: hidden; color: currentColor; font-size: clamp(.72rem, 1.55vmin, .95rem); font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
    .line-total { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; }
    .line-total > span { color: var(--text-muted); font-size: clamp(.72rem, 1.45vmin, .9rem); text-decoration: line-through; }
    .line-total > strong { font-size: clamp(1.1rem, 2.6vmin, 2rem); }
    .line-total small { color: var(--success); font-weight: 800; }
    aside { min-width: 0; align-self: end; padding: clamp(.8rem, 2vmin, 2rem); display: flex; flex-direction: column; gap: clamp(.6rem, 1.4vmin, 1rem); border: 1px solid var(--border-flat); border-radius: 1rem; background: var(--bg-panel); }
    aside div { min-width: 0; display: flex; justify-content: space-between; gap: 1rem; font-size: clamp(.95rem, 2.2vmin, 1.5rem); }
    aside strong { white-space: nowrap; }
    aside .saving { color: var(--success); }
    .display-total { padding-top: 1rem; align-items: end; border-top: 2px solid var(--border-flat); }
    .display-total strong { max-width: 100%; overflow: hidden; color: var(--accent-primary); font-size: clamp(2rem, 7vmin, 6rem); line-height: .95; text-overflow: ellipsis; }
    aside p { margin: 0; color: var(--text-muted); text-align: center; }
    .display-empty, .display-message { min-height: 0; flex: 1; display: grid; place-content: center; padding: 1rem; text-align: center; }
    .display-empty h2, .display-message h2 { max-width: 95vw; margin: 0; font-size: clamp(2rem, 8vmin, 7rem); line-height: 1; overflow-wrap: anywhere; }
    .display-empty p, .display-message span { color: var(--text-muted); font-size: clamp(.9rem, 2.4vmin, 1.8rem); }
    .display-message strong { margin-top: clamp(.75rem, 3vmin, 2rem); color: var(--success); font-size: clamp(1.8rem, 6vmin, 5rem); }
    @media (max-width: 760px), (orientation: portrait) {
        .customer-display { overflow-y: auto; }
        .display-body { grid-template-columns: 1fr; grid-template-rows: minmax(260px, 1fr) auto; }
        aside { width: 100%; align-self: stretch; }
        .display-total strong { font-size: clamp(2.3rem, 12vw, 5rem); }
    }
    @media (max-height: 650px) and (orientation: landscape) {
        .customer-display { padding: .55rem .75rem; gap: .45rem; }
        header { min-height: 3.5rem; padding-bottom: .35rem; }
        header span { font-size: .65rem; }
        h1 { font-size: clamp(1.35rem, 5vh, 2.3rem); }
        .display-body { grid-template-columns: minmax(0, 1fr) clamp(230px, 29vw, 360px); gap: .55rem; }
        article { min-height: 3.35rem; padding: .45rem .7rem; border-radius: .55rem; }
        article h3 { margin-bottom: .1rem; font-size: clamp(.8rem, 2.8vh, 1.15rem); }
        article span, article small { font-size: .68rem; }
        article.has-promotion { min-height: 4.15rem; }
        .line-promotion { margin-top: .18rem; gap: .3rem; }
        .line-promotion b { padding: .12rem .3rem; font-size: .58rem; }
        .line-promotion span { font-size: .62rem; }
        .line-total > strong { font-size: clamp(.95rem, 3.4vh, 1.35rem); }
        aside { padding: .65rem; gap: .4rem; border-radius: .7rem; }
        aside div { font-size: clamp(.8rem, 2.8vh, 1.05rem); }
        .display-total { padding-top: .45rem; }
        .display-total strong { font-size: clamp(1.8rem, 9vh, 3.5rem); }
        aside p { font-size: .7rem; }
    }
    @media (min-width: 1800px) {
        .display-body { grid-template-columns: minmax(0, 1.8fr) minmax(420px, .65fr); }
        .display-lines { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; }
        article { min-height: 6rem; }
    }
</style>

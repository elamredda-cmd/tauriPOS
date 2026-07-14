<script lang="ts">
    import PageBackButton from '$lib/components/PageBackButton.svelte';
    import { settingsDB, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert } from '$lib/stores/database';

    const DEFAULT_CART_LAYOUT = ['goods', 'last_receipt', 'change_price', 'hold'];
    const DEFAULT_TOOLBAR_LAYOUT = ['scale', 'recent_trans', 'label_print', 'discount'];

    const CART_BUTTONS: Record<string, string> = {
        goods: 'Goods',
        last_receipt: 'Last Receipt',
        change_price: 'Change Price',
        hold: 'Hold',
    };

    const TOOLBAR_BUTTONS: Record<string, string> = {
        scale: 'Scale',
        recent_trans: 'Recent Trans',
        label_print: 'Label Print',
        discount: 'Discount',
    };

    let saving = false;

    function getSetting(key: string, fallback: string): string {
        return $settingsDB.find((setting) => setting.key === key)?.value || fallback;
    }

    function parseLayout(key: string, fallback: string[], allowed: Record<string, string>) {
        try {
            const parsed = JSON.parse(getSetting(key, JSON.stringify(fallback)));
            if (!Array.isArray(parsed)) return [...fallback];
            const mapped = parsed
                .map((button) => {
                    if (key === 'pos_cart_layout' && button === 'recent_trans') return 'last_receipt';
                    if (key === 'pos_cart_layout' && (button === 'drawer' || button === 'label_print')) return 'hold';
                    if (key === 'pos_toolbar_layout' && button === 'drawer') return 'label_print';
                    return button;
                })
                .filter((button): button is string => typeof button === 'string' && button in allowed);
            const unique = [...new Set(mapped)];
            return unique.length === fallback.length ? unique : [...fallback];
        } catch {
            return [...fallback];
        }
    }

    let cartLayout: string[] = parseLayout('pos_cart_layout', DEFAULT_CART_LAYOUT, CART_BUTTONS);
    let toolbarLayout: string[] = parseLayout('pos_toolbar_layout', DEFAULT_TOOLBAR_LAYOUT, TOOLBAR_BUTTONS);

    function move(layout: string[], index: number, direction: number): string[] {
        const target = index + direction;
        if (target < 0 || target >= layout.length) return layout;
        const next = [...layout];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    }

    function resetLayout() {
        cartLayout = [...DEFAULT_CART_LAYOUT];
        toolbarLayout = [...DEFAULT_TOOLBAR_LAYOUT];
    }

    async function save() {
        if (saving) return;
        saving = true;
        const updatedAt = now();
        const cartSetting = { key: 'pos_cart_layout', value: JSON.stringify(cartLayout), updatedAt };
        const toolbarSetting = { key: 'pos_toolbar_layout', value: JSON.stringify(toolbarLayout), updatedAt };
        try {
            await Promise.all([
                upsert('settings', cartSetting, 'key'),
                upsert('settings', toolbarSetting, 'key'),
            ]);
            settingsDB.update((list) => [
                ...list.filter((setting) => setting.key !== cartSetting.key && setting.key !== toolbarSetting.key),
                cartSetting,
                toolbarSetting,
            ]);
            toast('Button layout saved', 'success');
        } catch (error) {
            toast(`Button layout was not saved: ${error}`, 'error');
        } finally {
            saving = false;
        }
    }
</script>

<svelte:head>
    <title>POS Button Setup - L&amp;Bj POS</title>
</svelte:head>

<div class="layout-page">
    <header class="layout-header">
        <PageBackButton fallback="/design" />
        <div class="layout-heading">
            <span>Design Studio</span>
            <h1>POS Button Setup</h1>
            <p>Arrange the trolley and product-grid actions.</p>
        </div>
        <div class="header-actions">
            <button type="button" class="secondary" disabled={saving} on:click={resetLayout}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v6h6"></path></svg>
                Reset
            </button>
            <button type="button" class="primary" disabled={saving} on:click={save}>
                {#if saving}
                    Saving
                {:else}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>
                    Save
                {/if}
            </button>
        </div>
    </header>

    <main class="layout-workspace">
        <section class="order-panel" aria-labelledby="cart-title">
            <div class="panel-heading">
                <div>
                    <span>Trolley</span>
                    <h2 id="cart-title">Cart Buttons</h2>
                </div>
                <small>Payment stays fixed</small>
            </div>
            <div class="order-list">
                {#each cartLayout as key, index}
                    <div class="order-row">
                        <b class="order-number">{index + 1}</b>
                        <div class="order-label">
                            <strong>{CART_BUTTONS[key] || key}</strong>
                            <small>{index < 2 ? 'Before Payment' : 'After Payment'}</small>
                        </div>
                        <div class="move-controls">
                            <button type="button" aria-label={`Move ${CART_BUTTONS[key]} up`} title="Move up" disabled={index === 0 || saving} on:click={() => cartLayout = move(cartLayout, index, -1)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"></path></svg>
                            </button>
                            <button type="button" aria-label={`Move ${CART_BUTTONS[key]} down`} title="Move down" disabled={index === cartLayout.length - 1 || saving} on:click={() => cartLayout = move(cartLayout, index, 1)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                            </button>
                        </div>
                    </div>
                {/each}
            </div>
        </section>

        <section class="order-panel" aria-labelledby="toolbar-title">
            <div class="panel-heading">
                <div>
                    <span>Product grid</span>
                    <h2 id="toolbar-title">Toolbar Buttons</h2>
                </div>
                <small>Left to right</small>
            </div>
            <div class="order-list">
                {#each toolbarLayout as key, index}
                    <div class="order-row">
                        <b class="order-number">{index + 1}</b>
                        <div class="order-label">
                            <strong>{TOOLBAR_BUTTONS[key] || key}</strong>
                            <small>Position {index + 1}</small>
                        </div>
                        <div class="move-controls">
                            <button type="button" aria-label={`Move ${TOOLBAR_BUTTONS[key]} left`} title="Move left" disabled={index === 0 || saving} on:click={() => toolbarLayout = move(toolbarLayout, index, -1)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"></path></svg>
                            </button>
                            <button type="button" aria-label={`Move ${TOOLBAR_BUTTONS[key]} right`} title="Move right" disabled={index === toolbarLayout.length - 1 || saving} on:click={() => toolbarLayout = move(toolbarLayout, index, 1)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                            </button>
                        </div>
                    </div>
                {/each}
            </div>
        </section>

        <aside class="preview-panel" aria-label="POS button preview">
            <div class="panel-heading">
                <div>
                    <span>Live order</span>
                    <h2>Preview</h2>
                </div>
            </div>

            <div class="preview-group">
                <h3>Trolley</h3>
                <div class="cart-preview">
                    {#each [...cartLayout.slice(0, 2), 'payment', ...cartLayout.slice(2)] as key}
                        <div class:payment={key === 'payment'}>{key === 'payment' ? 'Payment' : (CART_BUTTONS[key] || key)}</div>
                    {/each}
                </div>
            </div>

            <div class="preview-group toolbar-group">
                <h3>Product toolbar</h3>
                <div class="toolbar-preview">
                    {#each toolbarLayout as key}
                        <div>{TOOLBAR_BUTTONS[key] || key}</div>
                    {/each}
                </div>
            </div>
        </aside>
    </main>
</div>

<style>
    .layout-page { box-sizing: border-box; height: 100dvh; min-height: 560px; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-base); color: var(--text-main); }
    .layout-header { min-height: 82px; padding: .85rem 1.1rem; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: .9rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .layout-heading { min-width: 0; }
    .layout-heading > span, .panel-heading span { display: block; color: var(--accent-primary); font-size: .7rem; line-height: 1; font-weight: 900; text-transform: uppercase; }
    .layout-heading h1 { margin: .25rem 0 .12rem; font-size: 1.45rem; line-height: 1.05; }
    .layout-heading p { margin: 0; color: var(--text-muted); font-size: .82rem; }
    .header-actions { display: flex; gap: .55rem; }
    .header-actions button { min-width: 104px; height: 44px; padding: 0 .85rem; display: inline-flex; align-items: center; justify-content: center; gap: .45rem; border: 1px solid var(--border-flat); border-radius: 6px; color: var(--text-main); font-weight: 900; }
    .header-actions button svg { width: 18px; height: 18px; }
    .header-actions .secondary { background: var(--bg-card); }
    .header-actions .primary { border-color: var(--accent-primary); background: var(--accent-primary); color: #fff; }
    button:disabled { cursor: not-allowed; opacity: .42; }
    .layout-workspace { flex: 1; min-height: 0; padding: .8rem; display: grid; grid-template-columns: minmax(240px, 1fr) minmax(240px, 1fr) minmax(245px, .82fr); gap: .75rem; }
    .order-panel, .preview-panel { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--border-flat); border-radius: 8px; background: var(--bg-panel); }
    .panel-heading { min-height: 62px; padding: .8rem .9rem; display: flex; align-items: center; justify-content: space-between; gap: .65rem; border-bottom: 1px solid var(--border-flat); }
    .panel-heading h2 { margin: .25rem 0 0; font-size: 1.05rem; line-height: 1; }
    .panel-heading small { padding: .3rem .45rem; border: 1px solid var(--border-flat); border-radius: 4px; color: var(--text-muted); font-size: .68rem; font-weight: 800; white-space: nowrap; }
    .order-list { flex: 1; min-height: 0; padding: .65rem; display: grid; grid-template-rows: repeat(4, minmax(58px, 1fr)); gap: .45rem; }
    .order-row { min-height: 0; padding: .5rem; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: .55rem; border: 1px solid var(--border-flat); border-radius: 6px; background: var(--bg-card); }
    .order-number { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 4px; background: color-mix(in srgb, var(--accent-primary) 18%, transparent); color: var(--accent-primary); }
    .order-label { min-width: 0; }
    .order-label strong, .order-label small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .order-label strong { font-size: .87rem; }
    .order-label small { margin-top: .15rem; color: var(--text-muted); font-size: .68rem; }
    .move-controls { display: flex; gap: .3rem; }
    .move-controls button { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--border-flat); border-radius: 4px; background: var(--bg-panel); color: var(--text-main); }
    .move-controls button:not(:disabled):hover { border-color: var(--accent-primary); color: var(--accent-primary); }
    .move-controls svg { width: 17px; height: 17px; }

    .preview-panel { padding-bottom: .75rem; }
    .preview-group { padding: .75rem .75rem 0; }
    .preview-group h3 { margin: 0 0 .45rem; color: var(--text-muted); font-size: .7rem; text-transform: uppercase; }
    .cart-preview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .35rem; }
    .cart-preview div, .toolbar-preview div { min-width: 0; min-height: 45px; padding: .35rem; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--border-flat); border-radius: 4px; background: var(--bg-card); font-size: .67rem; font-weight: 900; line-height: 1.05; text-align: center; overflow-wrap: anywhere; }
    .cart-preview div.payment { border-color: var(--success); background: var(--success); color: #fff; }
    .toolbar-group { margin-top: auto; }
    .toolbar-preview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .35rem; }

    @media (max-width: 820px) {
        .layout-page { min-height: 100dvh; height: auto; overflow: auto; }
        .layout-workspace { grid-template-columns: 1fr; }
        .order-panel { min-height: 390px; }
        .preview-panel { min-height: 320px; }
    }
    @media (max-width: 620px) {
        .layout-header { grid-template-columns: 42px minmax(0, 1fr); }
        .layout-heading p { display: none; }
        .header-actions { grid-column: 1 / -1; }
        .header-actions button { flex: 1; }
    }
</style>

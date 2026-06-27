<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { settingsDB, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert } from '$lib/stores/database';

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

    function getSetting(key: string, fallback: string): string {
        return $settingsDB.find(s => s.key === key)?.value || fallback;
    }

    function setSetting(key: string, value: string) {
        const s = { key, value, updatedAt: now() };
        settingsDB.update(list => {
            const idx = list.findIndex(x => x.key === key);
            if (idx >= 0) return list.map((item, itemIndex) => itemIndex === idx ? s : item);
            return [...list, s];
        });
        upsert('settings', s, 'key');
    }

    function parseLayout(key: string, fallback: string[], allowed: Record<string, string>) {
        try {
            const parsed = JSON.parse(getSetting(key, JSON.stringify(fallback)));
            if (!Array.isArray(parsed)) return fallback;
            const mapped = parsed
                .map((button) => {
                    if (key === 'pos_cart_layout' && button === 'recent_trans') return 'last_receipt';
                    if (key === 'pos_cart_layout' && (button === 'drawer' || button === 'label_print')) return 'hold';
                    if (key === 'pos_toolbar_layout' && button === 'drawer') return 'label_print';
                    return button;
                })
                .filter((button): button is string => typeof button === 'string' && button in allowed);
            return mapped.length > 0 ? [...new Set(mapped)] : fallback;
        } catch {
            return fallback;
        }
    }

    function ensureRecentNextToScale(layout: string[]) {
        const withoutRecent = layout.filter((button) => button !== 'recent_trans');
        const scaleIndex = withoutRecent.indexOf('scale');
        if (scaleIndex === -1) return ['recent_trans', ...withoutRecent];
        return [
            ...withoutRecent.slice(0, scaleIndex + 1),
            'recent_trans',
            ...withoutRecent.slice(scaleIndex + 1),
        ];
    }

    let cartLayout: string[] = parseLayout('pos_cart_layout', ['goods', 'last_receipt', 'change_price', 'hold'], CART_BUTTONS);
    let toolbarLayout: string[] = ensureRecentNextToScale(parseLayout('pos_toolbar_layout', ['scale', 'recent_trans', 'label_print', 'discount'], TOOLBAR_BUTTONS));

    function move(arr: string[], i: number, dir: number) {
        const j = i + dir;
        if (j < 0 || j >= arr.length) return;
        const next = [...arr];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
    }

    function save() {
        toolbarLayout = ensureRecentNextToScale(toolbarLayout);
        setSetting('pos_cart_layout', JSON.stringify(cartLayout));
        setSetting('pos_toolbar_layout', JSON.stringify(toolbarLayout));
        toast('Layout saved');
    }
</script>

<MgmtPage title="POS Button Setup" backFallback="/settings">
    <button slot="actions" class="btn btn-primary" on:click={save}>Save Layout</button>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <p class="settings-hero-kicker">POS screen</p>
            <h2 class="settings-hero-title">Arrange the selling buttons</h2>
            <p class="settings-hero-copy">
                Choose the order cashiers see on the main till screen. Payment stays fixed so the checkout flow is always easy to find.
            </p>
        </section>

        <div class="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div class="flex flex-col gap-5">
                <section class="settings-section">
                    <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <p class="settings-hero-kicker">Trolley actions</p>
                            <h3 class="settings-section-title !mb-2">Cart Buttons</h3>
                            <p class="m-0 text-sm text-text-muted">These fill the bottom of the trolley sidebar.</p>
                        </div>
                        <span class="tag">Payment fixed</span>
                    </div>
                    <div class="settings-order-list mt-5">
                        {#each cartLayout as key, i}
                            <div class="settings-order-item">
                                <span class="settings-order-index">{i + 1}</span>
                                <div class="min-w-0 flex-1">
                                    <strong class="block truncate text-text-main">{CART_BUTTONS[key] || key}</strong>
                                    <small class="text-text-muted">{i < 2 ? 'Shown before Payment' : 'Shown after Payment'}</small>
                                </div>
                                <div class="settings-order-controls">
                                    <button class="settings-icon-btn" aria-label="Move up" disabled={i === 0} on:click={() => cartLayout = move(cartLayout, i, -1)!}>↑</button>
                                    <button class="settings-icon-btn" aria-label="Move down" disabled={i === cartLayout.length - 1} on:click={() => cartLayout = move(cartLayout, i, 1)!}>↓</button>
                                </div>
                            </div>
                        {/each}
                    </div>
                </section>

                <section class="settings-section">
                    <div>
                        <p class="settings-hero-kicker">Product grid toolbar</p>
                        <h3 class="settings-section-title !mb-2">Toolbar Buttons</h3>
                        <p class="m-0 text-sm text-text-muted">These sit under the product grid, next to pagination.</p>
                    </div>
                    <div class="settings-order-list mt-5">
                        {#each toolbarLayout as key, i}
                            <div class="settings-order-item">
                                <span class="settings-order-index">{i + 1}</span>
                                <div class="min-w-0 flex-1">
                                    <strong class="block truncate text-text-main">{TOOLBAR_BUTTONS[key] || key}</strong>
                                    <small class="text-text-muted">Toolbar position {i + 1}</small>
                                </div>
                                <div class="settings-order-controls">
                                    <button class="settings-icon-btn" aria-label="Move up" disabled={i === 0} on:click={() => toolbarLayout = move(toolbarLayout, i, -1)!}>↑</button>
                                    <button class="settings-icon-btn" aria-label="Move down" disabled={i === toolbarLayout.length - 1} on:click={() => toolbarLayout = move(toolbarLayout, i, 1)!}>↓</button>
                                </div>
                            </div>
                        {/each}
                    </div>
                </section>
            </div>

            <aside class="settings-action-card self-start xl:sticky xl:top-4">
                <p class="settings-hero-kicker">Preview</p>
                <h3 class="settings-section-title !mb-3">Trolley Button Order</h3>
                <div class="rounded-2xl border border-border-flat bg-bg-panel p-3">
                    <div class="grid grid-cols-3 gap-2">
                        {#each [...cartLayout.slice(0, 2), 'payment', ...cartLayout.slice(2)] as key}
                            <div class="flex min-h-[54px] items-center justify-center rounded-xl border border-border-flat px-2 text-center text-xs font-black {key === 'payment' ? 'bg-success text-white' : 'bg-bg-card text-text-main'}">
                                {key === 'payment' ? 'Payment' : (CART_BUTTONS[key] || key)}
                            </div>
                        {/each}
                    </div>
                </div>
                <p class="mt-4 text-sm text-text-muted">
                    This is only the order. Permissions and button behaviour stay controlled by their own pages.
                </p>
            </aside>
        </div>
    </div>
</MgmtPage>

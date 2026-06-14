<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { settingsDB, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert } from '$lib/stores/database';

    const CART_BUTTONS: Record<string, string> = {
        goods: 'Goods',
        recent_trans: 'Recent Trans',
        change_price: 'Change Price',
        hold: 'Hold',
    };

    const TOOLBAR_BUTTONS: Record<string, string> = {
        scale: 'Scale',
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
            if (idx >= 0) list[idx] = s;
            else list.push(s);
            return list;
        });
        upsert('settings', s, 'key');
    }

    function parseLayout(key: string, fallback: string[], allowed: Record<string, string>) {
        try {
            const parsed = JSON.parse(getSetting(key, JSON.stringify(fallback)));
            if (!Array.isArray(parsed)) return fallback;
            const mapped = parsed
                .map((button) => {
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

    let cartLayout: string[] = parseLayout('pos_cart_layout', ['goods', 'recent_trans', 'change_price', 'hold'], CART_BUTTONS);
    let toolbarLayout: string[] = parseLayout('pos_toolbar_layout', ['scale', 'label_print', 'discount'], TOOLBAR_BUTTONS);

    function move(arr: string[], i: number, dir: number) {
        const j = i + dir;
        if (j < 0 || j >= arr.length) return;
        const next = [...arr];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
    }

    function save() {
        setSetting('pos_cart_layout', JSON.stringify(cartLayout));
        setSetting('pos_toolbar_layout', JSON.stringify(toolbarLayout));
        toast('Layout saved');
    }
</script>

<MgmtPage title="Button Layout" backFallback="/settings">
    <button slot="actions" class="btn btn-primary" on:click={save}>Save Layout</button>

    <div class="p-6 flex flex-col gap-8 max-w-2xl">
        <section class="settings-section">
            <h3 class="settings-section-title">Cart Buttons</h3>
            <p class="text-text-muted text-[0.9rem] -mt-3 mb-4">These fill the bottom of the trolley sidebar (Payment is always last).</p>
            <div class="flex flex-col gap-2">
                {#each cartLayout as key, i}
                    <div class="flex items-center gap-3 bg-bg-card border border-border-flat rounded-md px-4 py-3">
                        <span class="text-text-muted font-mono w-6">{i + 1}</span>
                        <span class="flex-1 font-semibold">{CART_BUTTONS[key] || key}</span>
                        <button class="w-10 h-10 rounded-md bg-bg-panel border border-border-flat hover:bg-bg-card-hover transition-colors flex items-center justify-center" disabled={i === 0} on:click={() => cartLayout = move(cartLayout, i, -1)!}>↑</button>
                        <button class="w-10 h-10 rounded-md bg-bg-panel border border-border-flat hover:bg-bg-card-hover transition-colors flex items-center justify-center" disabled={i === cartLayout.length - 1} on:click={() => cartLayout = move(cartLayout, i, 1)!}>↓</button>
                    </div>
                {/each}
            </div>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Toolbar Buttons</h3>
            <p class="text-text-muted text-[0.9rem] -mt-3 mb-4">These sit under the product grid, next to pagination.</p>
            <div class="flex flex-col gap-2">
                {#each toolbarLayout as key, i}
                    <div class="flex items-center gap-3 bg-bg-card border border-border-flat rounded-md px-4 py-3">
                        <span class="text-text-muted font-mono w-6">{i + 1}</span>
                        <span class="flex-1 font-semibold">{TOOLBAR_BUTTONS[key] || key}</span>
                        <button class="w-10 h-10 rounded-md bg-bg-panel border border-border-flat hover:bg-bg-card-hover transition-colors flex items-center justify-center" disabled={i === 0} on:click={() => toolbarLayout = move(toolbarLayout, i, -1)!}>↑</button>
                        <button class="w-10 h-10 rounded-md bg-bg-panel border border-border-flat hover:bg-bg-card-hover transition-colors flex items-center justify-center" disabled={i === toolbarLayout.length - 1} on:click={() => toolbarLayout = move(toolbarLayout, i, 1)!}>↓</button>
                    </div>
                {/each}
            </div>
        </section>
    </div>
</MgmtPage>

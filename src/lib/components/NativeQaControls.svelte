<script lang="ts">
    import { onMount } from 'svelte';
    import { armNativeQa, getNativeQaStatus, releaseNativeQa, type NativeQaMode, type NativeQaStatus } from '$lib/nativeQa';

    const points = [
        ['settings.before-commit', 'Settings save before commit'],
        ['settings.before-audit', 'Settings audit rollback'],
        ['settings.font', 'Font save overlap'],
        ['provider.dojo.read', 'Dojo configuration read'],
        ['provider.sumup.read', 'SumUp configuration read'],
        ['provider.dojo.save', 'Dojo configuration save'],
        ['provider.sumup.save', 'SumUp configuration save'],
        ['schema.validate', 'Database schema validation'],
        ['conflicts.refresh', 'Conflict refresh'],
        ['conflicts.dismiss', 'Conflict dismissal'],
        ['stock.before-count', 'Stock count before commit'],
        ['stock.before-audit', 'Stock count audit rollback'],
        ['maintenance.backup', 'Full backup'],
        ['setup.after-reconnect-save', 'Reconnect after durable save'],
        ['checkout.after-sale-commit', 'Checkout after receipt commit before trolley clear'],
        ['checkout.before-hold-commit', 'Checkout before held trolley commit'],
        ['checkout.after-hold-commit', 'Checkout after held trolley commit before clear'],
        ['tax.before-commit', 'Tax rate atomic save'],
        ['items.generate-plu', 'Generate PLU result'],
        ['items.image-read', 'Item image result'],
        ['items.save', 'Item save'],
        ['items.goods-save', 'Goods save'],
        ['scale.selected-products', 'Scale selected page results'],
        ['scale.available-products', 'Scale available item results'],
        ['label.suggestions', 'Label catalogue results'],
        ['suppliers.load', 'Supplier list results'],
        ['suppliers.save', 'Supplier save'],
        ['printer.network', 'Network printer transport'],
        ['printer.device', 'Device printer transport'],
        ['printer.system', 'System printer transport'],
        ['drawer.network', 'Network drawer transport'],
    ];
    let expanded = false;
    let point = points[0][0];
    let mode: NativeQaMode = 'delay';
    let status: NativeQaStatus = { armed: [], pending: [], events: [], hits: {} };
    let error = '';
    let changing = false;
    let reading = false;

    async function refresh() {
        if (reading) return;
        reading = true;
        try { status = await getNativeQaStatus(); error = ''; }
        catch (reason) { error = String(reason); }
        finally { reading = false; }
    }
    async function arm() {
        changing = true;
        try { status = await armNativeQa(point, mode, 30000); error = ''; }
        catch (reason) { error = String(reason); }
        finally { changing = false; }
    }
    async function release() {
        changing = true;
        try { status = await releaseNativeQa(); error = ''; }
        catch (reason) { error = String(reason); }
        finally { changing = false; }
    }
    onMount(() => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, 750);
        return () => clearInterval(timer);
    });
</script>

<aside class="native-qa" aria-label="Isolated native QA fault controls">
    <button class="qa-toggle" aria-expanded={expanded} on:click={() => expanded = !expanded}>
        Native QA controls{status.pending.length ? ` · pending ${status.pending.length}` : status.armed.length ? ` · armed ${status.armed.length}` : ''}
    </button>
    {#if expanded}
        <div class="qa-panel">
            <strong>Isolated native QA application</strong>
            <p>One use per arm. Real results resume after release or 30 seconds. Reject never reports success.</p>
            <label>QA scenario
                <select aria-label="QA scenario" bind:value={point}>
                    {#each points as [value, label]}<option {value}>{label}</option>{/each}
                </select>
            </label>
            <label>QA effect
                <select aria-label="QA effect" bind:value={mode}>
                    <option value="delay">Delay then continue</option>
                    <option value="reject">Reject immediately</option>
                    <option value="delay-reject">Delay then reject</option>
                </select>
            </label>
            <div class="qa-actions">
                <button disabled={changing} on:click={arm}>Arm next operation</button>
                <button disabled={changing} on:click={release}>Release / clear</button>
            </div>
            <button class="qa-reload" on:click={() => window.location.reload()}>Reload native WebView</button>
            <p class="qa-status">Armed: {status.armed.join(', ') || 'none'}<br />Pending: {status.pending.join(', ') || 'none'}</p>
            <p>Selected checkpoint calls: {status.hits[point] || 0}</p>
            {#if error}<p role="alert">{error}</p>{/if}
            <ol aria-label="Native QA event proof">
                {#each status.events.slice(-5) as event}<li>{event}</li>{/each}
            </ol>
        </div>
    {/if}
</aside>

<style>
    .native-qa { position: fixed; z-index: 9000; top: 4px; right: 8px; font: 12px/1.3 system-ui, sans-serif; max-width: min(360px, calc(100vw - 16px)); color: #fff; }
    .qa-toggle { float: right; padding: 6px 10px; background: #5a216c; border: 1px solid #dfc3e5; border-radius: 6px; color: #fff; font-weight: 700; }
    .qa-panel { clear: both; padding: 12px; background: #28152f; border: 1px solid #dfc3e5; border-radius: 6px; max-height: 70vh; overflow: auto; box-shadow: 0 4px 18px #0008; }
    p { margin: 7px 0; }
    label { display: block; margin: 8px 0; font-weight: 700; }
    select { display: block; width: 100%; margin-top: 4px; padding: 7px; color: #111; background: #fff; border-radius: 4px; }
    .qa-actions { display: flex; gap: 6px; }
    .qa-actions button { flex: 1; padding: 8px 5px; color: #111; background: #f3d3ff; border-radius: 4px; font-weight: 700; }
    .qa-reload { margin-top: 8px; width: 100%; padding: 8px; color: #111; background: #f3d3ff; border-radius: 4px; font-weight: 700; }
    .qa-status, li { overflow-wrap: anywhere; }
    ol { padding-left: 16px; margin: 8px 0 0; }
    @media print { .native-qa { display: none !important; } }
</style>

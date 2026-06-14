<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { toast } from '$lib/stores/toast';
    import { closeCustomerDisplay, getDisplayMonitors, getSavedCustomerDisplayMonitor, openCustomerDisplay, saveCustomerDisplayMonitor, type DisplayMonitor } from '$lib/customerDisplay';

    let monitors: DisplayMonitor[] = [];
    let monitorIndex = 1;
    let busy = false;

    onMount(async () => {
        monitorIndex = getSavedCustomerDisplayMonitor();
        monitors = await getDisplayMonitors();
        if (!monitors[monitorIndex]) monitorIndex = monitors.length > 1 ? 1 : 0;
    });

    async function openDisplay() {
        busy = true;
        try {
            saveCustomerDisplayMonitor(monitorIndex);
            await openCustomerDisplay(monitorIndex);
            toast('Customer display opened', 'success');
        } catch (error) {
            toast(`Could not open customer display: ${error}`, 'error');
        } finally {
            busy = false;
        }
    }
</script>

<MgmtPage title="Customer Display" backFallback="/settings">
    <div slot="actions" class="flex gap-3">
        <button class="btn btn-danger" on:click={closeCustomerDisplay}>Close Display</button>
        <button class="btn btn-primary" disabled={busy || monitors.length === 0} on:click={openDisplay}>Open Display</button>
    </div>
    <div class="p-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.7fr)] gap-6">
        <section class="settings-section">
            <h3 class="settings-section-title">Choose Customer Screen</h3>
            <p class="text-text-muted mb-4">This choice is stored only on this till.</p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {#each monitors as monitor}
                    <button class="flat-card p-4 text-left {monitorIndex === monitor.index ? '!border-accent-primary' : ''}" on:click={() => monitorIndex = monitor.index}>
                        <strong class="block text-lg">Screen {monitor.index + 1}</strong>
                        <span class="block text-text-muted">{monitor.name}</span>
                        <small>{monitor.width} × {monitor.height}</small>
                    </button>
                {/each}
            </div>
        </section>
        <section class="settings-section">
            <h3 class="settings-section-title">What Customers See</h3>
            <ul class="leading-8 text-text-muted">
                <li>Live basket items and quantities</li>
                <li>Discounts and total</li>
                <li>Payment status and change</li>
                <li>Thank-you message after payment</li>
            </ul>
        </section>
    </div>
</MgmtPage>

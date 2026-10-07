<script lang="ts">
    import { page } from '$app/stores';
    import { shouldShowConnectionStatus, type ConnectionStatusPlacement } from '$lib/connectionStatusVisibility';
    import { deviceOperatingMode } from '$lib/deviceMode';
    import { syncActivity, syncStatus } from '$lib/stores/syncActivity';
    export let extraClass = '';
    export let placement: ConnectionStatusPlacement = 'header';
    $: pendingLabel = $syncActivity.pending && $syncStatus.label === 'Offline'
        ? `${$syncActivity.pending} pending`
        : '';
</script>
{#if shouldShowConnectionStatus($deviceOperatingMode, $page.url.pathname, placement)}
<span class={`connection-status-pill ${$syncStatus.tone} ${extraClass}`.trim()} class:sidebar-status={placement === 'sidebar'} role="status" title={$syncStatus.detail} aria-label={pendingLabel ? `${$syncStatus.label}, ${pendingLabel}` : $syncStatus.label}>
    <span class="sync-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v6h-6M4 20v-6h6M5.1 7a8 8 0 0 1 13.2-1L20 10M4 14l1.7 4A8 8 0 0 0 19 17" /></svg>
    </span>
    <strong>{$syncStatus.label}</strong>
    {#if pendingLabel}<small>{pendingLabel}</small>{/if}
</span>
{/if}
<style>
    .connection-status-pill { --status-color: var(--text-muted); min-height: 30px; min-width: 104px; width: max-content; max-width: 100%; padding: 3px 10px 3px 5px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; color: var(--status-color); border: 1px solid color-mix(in srgb, var(--status-color) 25%, var(--border-flat)); border-radius: 999px; background: color-mix(in srgb, var(--status-color) 8%, var(--bg-card)); white-space: nowrap; }
    .sync-symbol { display: grid; place-items: center; width: 21px; height: 21px; flex: 0 0 auto; border-radius: 50%; background: color-mix(in srgb, var(--status-color) 12%, transparent); }
    .sync-symbol svg { width: 15px; height: 15px; }
    strong { font-size: 11px; line-height: 1; font-weight: 850; letter-spacing: .01em; }
    small { font-size: 10px; }
    .sidebar-status { box-sizing: border-box; min-width: 0; width: 100%; padding: 5px 6px; flex-wrap: wrap; gap: 4px 5px; border-radius: 0.65rem; white-space: normal; text-align: center; }
    .sidebar-status .sync-symbol { width: 18px; height: 18px; }
    .sidebar-status .sync-symbol svg { width: 13px; height: 13px; }
    .sidebar-status strong { min-width: 0; max-width: 100%; flex: 0 1 auto; line-height: 1.2; overflow-wrap: anywhere; }
    .sidebar-status small { min-width: 0; flex-basis: 100%; line-height: 1.2; overflow-wrap: anywhere; }
    .success { --status-color: var(--success); }
    .waiting { --status-color: var(--warning); }
    .error { --status-color: var(--danger); }
    @media (max-width: 600px) {
        .sidebar-status { min-height: 26px; padding: 4px 6px; flex-wrap: nowrap; }
        .sidebar-status .sync-symbol,
        .sidebar-status small { display: none; }
    }
</style>

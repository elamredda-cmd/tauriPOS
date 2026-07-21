<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import TouchKeyboardButton from '$lib/components/TouchKeyboardButton.svelte';
    import {
        activateManualLicense,
        manualLicenseStatus,
        refreshManualLicenseStatus,
        type ManualLicenseStatus,
    } from '$lib/licensing';
    import { currentEmployee, currentShiftId } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';

    export let enabled = false;

    const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
    const HIDDEN_ROUTES = new Set(['/setup', '/customer-display', '/settings/licence']);

    let mounted = false;
    let refreshing = false;
    let activating = false;
    let activationCode = '';
    let activationError = '';
    let dismissedNotice = '';
    let lastRefreshKey = '';
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let boundaryTimer: ReturnType<typeof setTimeout> | null = null;

    $: status = $manualLicenseStatus;
    $: signedIn = Boolean(
        $currentEmployee?.id
        && $currentEmployee?.isActive
        && $currentShiftId
    );
    $: blocked = Boolean(status && !status.accessAllowed);
    $: warning = Boolean(
        status
        && status.accessAllowed
        && status.daysRemaining !== null
        && status.daysRemaining >= 0
        && status.daysRemaining <= 7
        && (status.state === 'trial' || status.state === 'expiring')
    );
    $: currentNotice = status ? noticeKey(status) : '';
    $: routeHidden = HIDDEN_ROUTES.has($page.url.pathname);
    $: visible = enabled
        && mounted
        && signedIn
        && !routeHidden
        && Boolean(status)
        && (blocked || warning)
        && (blocked || dismissedNotice !== currentNotice);

    $: refreshKey = `${enabled}:${signedIn}:${$currentEmployee?.id || ''}:${$page.url.pathname}`;
    $: if (mounted && enabled && signedIn && !routeHidden && refreshKey !== lastRefreshKey) {
        lastRefreshKey = refreshKey;
        void loadStatus();
    }

    onMount(() => {
        mounted = true;
        const refreshOnFocus = () => void loadStatus();
        window.addEventListener('focus', refreshOnFocus);
        refreshTimer = setInterval(() => void loadStatus(), REFRESH_INTERVAL_MS);
        scheduleBoundaryRefresh();
        return () => window.removeEventListener('focus', refreshOnFocus);
    });

    onDestroy(() => {
        if (refreshTimer) clearInterval(refreshTimer);
        if (boundaryTimer) clearTimeout(boundaryTimer);
    });

    function scheduleBoundaryRefresh() {
        if (boundaryTimer) clearTimeout(boundaryTimer);
        const now = new Date();
        const nextLocalDay = new Date(now);
        nextLocalDay.setHours(24, 0, 1, 0);
        boundaryTimer = setTimeout(() => {
            void loadStatus();
            scheduleBoundaryRefresh();
        }, Math.max(1_000, nextLocalDay.getTime() - now.getTime()));
    }

    async function loadStatus() {
        if (!enabled || !signedIn || refreshing || routeHidden) return;
        refreshing = true;
        try {
            await refreshManualLicenseStatus();
        } catch (error) {
            console.warn('Licence status check deferred:', error);
        } finally {
            refreshing = false;
        }
    }

    function noticeKey(value: ManualLicenseStatus): string {
        return [value.state, value.shopId, value.expiresOn, value.daysRemaining ?? ''].join(':');
    }

    function cleanError(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error || 'Unknown error');
        return message.replace(/^Error:\s*/i, '').trim();
    }

    function formatDate(value: string): string {
        if (!value) return 'Not set';
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
            ? new Date(`${value}T12:00:00`)
            : new Date(value);
        if (Number.isNaN(parsed.getTime())) return value;
        return new Intl.DateTimeFormat('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        }).format(parsed);
    }

    function titleFor(value: ManualLicenseStatus): string {
        if (!value.accessAllowed) return 'Activate L&Bj POS';
        if (value.state === 'trial') return 'Your free trial ends soon';
        return 'Your licence expires soon';
    }

    function dismissWarning() {
        if (!blocked) dismissedNotice = currentNotice;
    }

    function handleKeydown(event: KeyboardEvent) {
        if (visible && !blocked && event.key === 'Escape') dismissWarning();
    }

    async function activateCode() {
        const token = activationCode.trim();
        if (!token || activating) return;
        activating = true;
        activationError = '';
        try {
            const nextStatus = await activateManualLicense(token);
            activationCode = '';
            if (nextStatus.accessAllowed) {
                dismissedNotice = noticeKey(nextStatus);
                toast('Shop licence activated');
            }
        } catch (error) {
            activationError = cleanError(error);
        } finally {
            activating = false;
        }
    }

    async function openActivationPage() {
        if (!blocked) dismissWarning();
        await goto('/settings/licence');
    }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible && status}
    <div class="fixed inset-0 z-[2600] flex items-center justify-center bg-[var(--overlay)] p-3 sm:p-5" role="presentation">
        <div
            class="flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-lg border border-border-flat bg-bg-panel text-text-main shadow-[0_24px_80px_var(--shadow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="licence-notice-title"
            aria-describedby="licence-notice-description"
        >
            <header class="border-b border-border-flat px-5 py-4 sm:px-6">
                <span class="text-xs font-black uppercase tracking-[0.14em] {blocked ? 'text-danger' : 'text-warning'}">
                    {blocked ? 'Registration required' : 'Licence reminder'}
                </span>
                <h2 id="licence-notice-title" class="mt-1 text-2xl font-black">{titleFor(status)}</h2>
            </header>

            <div class="overflow-y-auto px-5 py-5 sm:px-6">
                <div class="rounded-md border {blocked ? 'border-danger/50 bg-danger/10' : 'border-warning/50 bg-warning/10'} p-4">
                    <strong class="block text-lg">{status.message}</strong>
                    <p id="licence-notice-description" class="mt-1 text-sm text-text-muted">
                        {#if status.isTrial && !blocked}
                            Activate before {formatDate(status.expiresOn)} to keep sales available.
                        {:else if blocked}
                            Enter the registration code supplied for this shop. Products, orders, and settings remain safely stored.
                        {:else}
                            Renew by {formatDate(status.expiresOn)} to avoid interruption.
                        {/if}
                    </p>
                </div>

                {#if blocked}
                    <div class="mt-5">
                        <label class="block text-sm font-bold" for="notice-activation-code">Registration code</label>
                        <div class="relative mt-2">
                            <textarea
                                id="notice-activation-code"
                                class="min-h-[112px] w-full resize-y pr-14 font-mono text-xs"
                                maxlength="16384"
                                bind:value={activationCode}
                                data-touch-keyboard="button"
                                placeholder="LBJ1..."
                                spellcheck="false"
                            ></textarea>
                            <TouchKeyboardButton targetId="notice-activation-code" label="Open registration keyboard" embedded />
                        </div>
                        {#if activationError}
                            <p class="mt-2 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
                                {activationError}
                            </p>
                        {/if}
                    </div>
                {/if}
            </div>

            <footer class="flex flex-wrap justify-end gap-3 border-t border-border-flat bg-bg-card px-5 py-4 sm:px-6">
                {#if !blocked}
                    <button class="btn btn-secondary" on:click={dismissWarning}>Remind me later</button>
                {/if}
                <button class="btn btn-secondary" on:click={openActivationPage}>Activation</button>
                {#if blocked}
                    <button class="btn btn-primary" disabled={activating || !activationCode.trim()} on:click={activateCode}>
                        {activating ? 'Checking code...' : 'Activate now'}
                    </button>
                {/if}
            </footer>
        </div>
    </div>
{/if}

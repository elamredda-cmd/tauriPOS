<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import QRCode from 'qrcode';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { storeDB } from '$lib/stores/db';
    import { ensureDatabaseIdentityForSync } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { createOwnerAppPairingUri, formatOwnerAppShopCode } from '$lib/ownerAppPairing';
    import { getOrCreateOwnerAppPairingCode } from '$lib/ownerCloudConfig';
    import { OWNER_CLOUD_STATUS_EVENT } from '$lib/ownerCloudEvents';

    type CloudStatus = 'connecting' | 'live' | 'offline' | 'error';

    let shopId = '';
    let pairingUri = '';
    let qrDataUrl = '';
    let loading = true;
    let errorMessage = '';
    let cloudStatus: CloudStatus = 'connecting';
    let cloudMessage = 'Checking the POS connection';
    let sendingSnapshot = false;

    function handleCloudStatus(event: Event) {
        const detail = (event as CustomEvent<{ status?: string; message?: string }>).detail;
        if (detail?.status === 'live' || detail?.status === 'offline' || detail?.status === 'error' || detail?.status === 'connecting') {
            cloudStatus = detail.status;
        }
        if (detail?.message) cloudMessage = detail.message;
    }

    $: shortCode = shopId ? formatOwnerAppShopCode(shopId) : '';

    onMount(async () => {
        window.addEventListener(OWNER_CLOUD_STATUS_EVENT, handleCloudStatus);
        try {
            const identity = await ensureDatabaseIdentityForSync();
            if (!identity?.shopId) throw new Error('Shop identity is unavailable');
            const pairingCode = await getOrCreateOwnerAppPairingCode();
            shopId = identity.shopId;
            pairingUri = createOwnerAppPairingUri(identity.shopId, pairingCode);
            qrDataUrl = await QRCode.toDataURL(pairingUri, {
                width: 560,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: { dark: '#102a43', light: '#ffffff' },
            });
            void sendSnapshotNow();
        } catch (error) {
            console.error('Could not prepare owner-app pairing QR:', error);
            errorMessage = String(error instanceof Error ? error.message : error);
        } finally {
            loading = false;
        }
    });

    onDestroy(() => {
        window.removeEventListener(OWNER_CLOUD_STATUS_EVENT, handleCloudStatus);
    });

    async function sendSnapshotNow() {
        if (sendingSnapshot || !pairingUri) return;
        sendingSnapshot = true;
        cloudStatus = 'connecting';
        cloudMessage = 'Sending the latest shop data';
        try {
            const reporter = await import('$lib/ownerCloudReporter');
            await reporter.publishOwnerCloudSnapshot();
        } catch (error) {
            cloudStatus = navigator.onLine ? 'error' : 'offline';
            cloudMessage = String(error instanceof Error ? error.message : error);
        } finally {
            sendingSnapshot = false;
        }
    }

    async function copyPairingCode() {
        if (!pairingUri) return;
        try {
            await navigator.clipboard.writeText(pairingUri);
            toast('Owner app pairing code copied');
        } catch (error) {
            console.error('Could not copy pairing code:', error);
            toast('Could not copy the pairing code', 'error');
        }
    }
</script>

<svelte:head>
    <title>Owner App Pairing</title>
</svelte:head>

<MgmtPage title="Owner App Pairing" backFallback="/settings">
    <div class="h-full overflow-y-auto p-4 sm:p-6">
        <div class="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.15fr)]">
            <section class="flex min-h-[440px] flex-col items-center justify-center rounded-md border border-border-flat bg-white p-5 text-center shadow-[0_16px_36px_var(--shadow)]">
                {#if loading}
                    <span class="h-10 w-10 animate-spin rounded-full border-4 border-[#d7e2ea] border-t-[#087e8b]" aria-label="Preparing pairing QR"></span>
                    <strong class="mt-4 text-[#17324d]">Preparing shop QR...</strong>
                {:else if errorMessage}
                    <div class="max-w-sm rounded-md border border-danger/40 bg-danger/10 p-4 text-danger">
                        <strong class="block">Pairing QR unavailable</strong>
                        <small class="mt-2 block">{errorMessage}</small>
                    </div>
                {:else}
                    <img class="aspect-square w-full max-w-[340px] object-contain" src={qrDataUrl} alt={`Owner app pairing QR for ${$storeDB.name}`} />
                    <span class="mt-4 text-xs font-black uppercase tracking-[0.16em] text-[#526575]">Shop code</span>
                    <strong class="mt-1 font-mono text-2xl tracking-[0.12em] text-[#17324d]">{shortCode}</strong>
                {/if}
            </section>

            <section class="rounded-md border border-border-flat bg-bg-panel p-5 sm:p-6">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">L&amp;Bj Owner</span>
                <h2 class="mt-2 text-2xl text-text-main">Add {$storeDB.name} to the owner app</h2>
                <p class="mt-3 text-sm leading-relaxed text-text-muted">
                    Sign in to the owner app, press <strong>Add shop</strong>, and scan this code. Every till synchronized to this shop shows the same QR because it uses the shared shop identity, not the individual till identity.
                </p>

                <div class="mt-5 rounded-md border border-success/40 bg-success/10 p-4">
                    <strong class="block text-text-main">Ready on every synchronized till</strong>
                    <p class="mt-1 text-sm text-text-muted">The QR is generated by the POS from the shop identity. It does not require activation on this individual till.</p>
                </div>

                <div class:status-live={cloudStatus === 'live'} class:status-error={cloudStatus === 'error' || cloudStatus === 'offline'} class="mt-5 rounded-md border border-border-flat bg-bg-card p-4">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <strong class="block text-text-main">
                                {cloudStatus === 'live' ? 'Owner app is live' : cloudStatus === 'connecting' ? 'Connecting owner app' : 'Owner app needs attention'}
                            </strong>
                            <p class="mt-1 break-words text-sm text-text-muted">{cloudMessage}</p>
                        </div>
                        <span class:dot-live={cloudStatus === 'live'} class:dot-error={cloudStatus === 'error' || cloudStatus === 'offline'} class="status-dot shrink-0" aria-hidden="true"></span>
                    </div>
                    <button class="btn btn-primary mt-4 w-full" disabled={sendingSnapshot || !pairingUri} on:click={sendSnapshotNow}>
                        {sendingSnapshot ? 'Sending...' : 'Send live snapshot now'}
                    </button>
                </div>

                <div class="mt-5 grid gap-3">
                    <div class="rounded-md border border-success/40 bg-success/10 p-4">
                        <strong class="block text-text-main">The QR cannot create a user</strong>
                        <p class="mt-1 text-sm text-text-muted">It only opens this shop for an owner account that is already authorized in Firebase. Another email is rejected.</p>
                    </div>
                    <div class="rounded-md border border-border-flat bg-bg-card p-4">
                        <strong class="block text-text-main">Duplicate pairing is blocked</strong>
                        <p class="mt-1 text-sm text-text-muted">Scanning this shop again, including from another till, finishes with “Shop already added”.</p>
                    </div>
                    <div class="rounded-md border border-warning/40 bg-warning/10 p-4">
                        <strong class="block text-text-main">Admin only</strong>
                        <p class="mt-1 text-sm text-text-muted">Only an administrator can open this page. Do not display it publicly even though account authorization is still checked in Firebase.</p>
                    </div>
                </div>

                {#if shopId}
                    <div class="mt-5 rounded-md border border-border-flat bg-bg-card p-3">
                        <span class="block text-xs font-black uppercase text-text-muted">Shared shop ID</span>
                        <code class="mt-1 block break-all text-xs text-text-main">{shopId}</code>
                    </div>
                {/if}

                <button class="btn btn-secondary mt-5" disabled={!pairingUri} on:click={copyPairingCode}>Copy pairing code</button>
            </section>
        </div>
    </div>
</MgmtPage>

<style>
    .status-live {
        border-color: color-mix(in srgb, var(--success) 55%, transparent);
        background: color-mix(in srgb, var(--success) 10%, var(--bg-card));
    }

    .status-error {
        border-color: color-mix(in srgb, var(--danger) 50%, transparent);
        background: color-mix(in srgb, var(--danger) 9%, var(--bg-card));
    }

    .status-dot {
        width: 0.75rem;
        height: 0.75rem;
        border-radius: 999px;
        background: var(--warning);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--warning) 18%, transparent);
    }

    .dot-live {
        background: var(--success);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--success) 18%, transparent);
    }

    .dot-error {
        background: var(--danger);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 18%, transparent);
    }
</style>

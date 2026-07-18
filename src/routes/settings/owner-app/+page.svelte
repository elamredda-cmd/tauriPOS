<script lang="ts">
    import { onMount } from 'svelte';
    import QRCode from 'qrcode';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { storeDB } from '$lib/stores/db';
    import { ensureDatabaseIdentityForSync } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { createOwnerAppPairingUri, formatOwnerAppShopCode } from '$lib/ownerAppPairing';
    import { getOwnerCloudConfig, isOwnerCloudConfigured } from '$lib/ownerCloudConfig';

    let shopId = '';
    let pairingUri = '';
    let qrDataUrl = '';
    let loading = true;
    let errorMessage = '';

    $: shortCode = shopId ? formatOwnerAppShopCode(shopId) : '';

    onMount(async () => {
        try {
            const identity = await ensureDatabaseIdentityForSync();
            if (!identity?.shopId) throw new Error('Shop identity is unavailable');
            const cloudConfig = await getOwnerCloudConfig();
            if (!isOwnerCloudConfigured(cloudConfig)) {
                throw new Error('Owner cloud reporting has not been activated for this shop');
            }
            shopId = identity.shopId;
            pairingUri = createOwnerAppPairingUri(identity.shopId, cloudConfig.pairingCode);
            qrDataUrl = await QRCode.toDataURL(pairingUri, {
                width: 560,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: { dark: '#102a43', light: '#ffffff' },
            });
        } catch (error) {
            console.error('Could not prepare owner-app pairing QR:', error);
            errorMessage = String(error instanceof Error ? error.message : error);
        } finally {
            loading = false;
        }
    });

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

                <div class="mt-5 grid gap-3">
                    <div class="rounded-md border border-success/40 bg-success/10 p-4">
                        <strong class="block text-text-main">The QR cannot create a user</strong>
                        <p class="mt-1 text-sm text-text-muted">Only accounts created by the system owner can sign in. Scanning this protected code links that account to the shop automatically.</p>
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

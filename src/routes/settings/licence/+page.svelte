<script lang="ts">
    import { onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import { open } from '@tauri-apps/plugin-dialog';
    import QRCode from 'qrcode';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import TouchKeyboardButton from '$lib/components/TouchKeyboardButton.svelte';
    import {
        activateManualLicense,
        activateManualLicenseFile,
        createManualLicenseRequest,
        refreshManualLicenseStatus,
        type ManualLicenseRequest,
        type ManualLicenseState,
        type ManualLicenseStatus,
    } from '$lib/licensing';
    import { toast } from '$lib/stores/toast';

    let status: ManualLicenseStatus | null = null;
    let request: ManualLicenseRequest | null = null;
    let requestQr = '';
    let licenceCode = '';
    let loading = true;
    let activating = false;
    let errorMessage = '';
    let nativeRuntime = false;

    onMount(() => {
        nativeRuntime = isTauri();
        void loadLicencePage();
    });

    async function loadLicencePage() {
        loading = true;
        errorMessage = '';
        try {
            [status, request] = await Promise.all([
                refreshManualLicenseStatus(),
                createManualLicenseRequest(),
            ]);
            requestQr = await QRCode.toDataURL(request.code, {
                width: 520,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: { dark: '#102a43', light: '#ffffff' },
            });
        } catch (error) {
            errorMessage = cleanError(error);
        } finally {
            loading = false;
        }
    }

    function cleanError(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error || 'Unknown error');
        return message.replace(/^Error:\s*/i, '').trim();
    }

    function stateLabel(state: ManualLicenseState): string {
        switch (state) {
            case 'active': return 'Active';
            case 'expiring': return 'Renew soon';
            case 'trial': return 'Free trial';
            case 'trial_expired': return 'Trial ended';
            case 'expired': return 'Expired';
            case 'invalid': return 'Invalid';
            case 'shop_mismatch': return 'Wrong shop';
            case 'till_limit': return 'Till limit';
            case 'preview': return 'Preview';
            default: return 'Not activated';
        }
    }

    function stateTone(state: ManualLicenseState): string {
        if (state === 'active') return 'border-success/50 bg-success/10 text-success';
        if (state === 'expiring') return 'border-warning/60 bg-warning/10 text-warning';
        if (state === 'trial' || state === 'not_activated' || state === 'preview') return 'border-accent-primary/50 bg-accent-primary/10 text-accent-primary';
        return 'border-danger/60 bg-danger/10 text-danger';
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

    async function copyText(value: string, successMessage: string) {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            toast(successMessage);
        } catch (error) {
            console.error('Could not copy licence information:', error);
            toast('Could not copy to the clipboard', 'error');
        }
    }

    async function activateCode() {
        if (!nativeRuntime) {
            toast('Licence activation is available in the Tauri app', 'info');
            return;
        }
        const token = licenceCode.trim();
        if (!token) {
            toast('Paste a licence code first', 'error');
            return;
        }
        activating = true;
        errorMessage = '';
        try {
            status = await activateManualLicense(token);
            licenceCode = '';
            toast('Shop licence activated');
        } catch (error) {
            errorMessage = cleanError(error);
            toast(errorMessage, 'error');
        } finally {
            activating = false;
        }
    }

    async function importLicenceFile() {
        if (!nativeRuntime || activating) return;
        try {
            const selected = await open({
                multiple: false,
                title: 'Choose L&Bj POS licence',
                filters: [{ name: 'L&Bj POS Licence', extensions: ['lbjlic', 'txt', 'json'] }],
            });
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) return;
            activating = true;
            errorMessage = '';
            status = await activateManualLicenseFile(path);
            licenceCode = '';
            toast('Shop licence activated');
        } catch (error) {
            errorMessage = cleanError(error);
            toast(errorMessage, 'error');
        } finally {
            activating = false;
        }
    }

</script>

<svelte:head>
    <title>Shop Licence</title>
</svelte:head>

<MgmtPage title="Shop Licence" backFallback="/settings">
    <div class="h-full overflow-y-auto p-4 sm:p-6">
        <div class="mx-auto max-w-6xl space-y-4">
            {#if loading}
                <div class="grid min-h-[320px] place-items-center rounded-md border border-border-flat bg-bg-panel">
                    <div class="text-center">
                        <span class="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-border-flat border-t-accent-primary" aria-label="Loading licence"></span>
                        <strong class="mt-4 block text-text-main">Preparing shop licence...</strong>
                    </div>
                </div>
            {:else}
                {#if errorMessage}
                    <div class="rounded-md border border-danger/50 bg-danger/10 p-4 text-danger" role="alert">
                        <strong class="block">Licence action could not be completed</strong>
                        <span class="mt-1 block break-words text-sm">{errorMessage}</span>
                    </div>
                {/if}

                {#if status}
                    <section class="rounded-md border border-border-flat bg-bg-panel p-4 sm:p-5">
                        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div class="min-w-0">
                                <span class="text-xs font-black uppercase tracking-[0.14em] text-text-muted">Current status</span>
                                <h2 class="mt-1 text-xl text-text-main">{status.message}</h2>
                                <p class="mt-1 text-sm text-text-muted">
                                    {status.shopName || 'This shop'} · {status.activeTills} active {status.activeTills === 1 ? 'till' : 'tills'}
                                </p>
                            </div>
                            <span class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border px-4 text-sm font-black uppercase {stateTone(status.state)}">
                                {stateLabel(status.state)}
                            </span>
                        </div>

                        {#if !status.enforcementEnabled}
                            <div class="mt-4 rounded-md border border-accent-primary/40 bg-accent-primary/10 p-3 text-sm text-text-main">
                                <strong>Setup mode is on.</strong> Sales are not blocked while the licensing workflow is being tested.
                            </div>
                        {/if}
                    </section>
                {/if}

                <div class="grid gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
                    <section class="rounded-md border border-border-flat bg-bg-panel p-4 sm:p-5">
                        <span class="text-xs font-black uppercase tracking-[0.14em] text-accent-primary">Licence request</span>
                        <h2 class="mt-2 text-xl text-text-main">Identify this shop</h2>
                        <p class="mt-2 text-sm leading-relaxed text-text-muted">
                            Send this request to the licence issuer. It contains the shop identity and till count, but no customer or sales data.
                        </p>

                        {#if requestQr && request}
                            <div class="mt-4 flex justify-center rounded-md border border-border-flat bg-white p-3">
                                <img class="aspect-square w-full max-w-[260px] object-contain" src={requestQr} alt={`Licence request QR for ${request.shopName || request.shopCode}`} />
                            </div>
                            <div class="mt-4 grid grid-cols-2 gap-3">
                                <div class="rounded-md border border-border-flat bg-bg-card p-3">
                                    <span class="block text-xs font-black uppercase text-text-muted">Shop code</span>
                                    <strong class="mt-1 block break-all font-mono text-lg text-text-main">{request.shopCode}</strong>
                                </div>
                                <div class="rounded-md border border-border-flat bg-bg-card p-3">
                                    <span class="block text-xs font-black uppercase text-text-muted">Active tills</span>
                                    <strong class="mt-1 block text-lg text-text-main">{request.activeTills}</strong>
                                </div>
                            </div>
                            <div class="mt-3 rounded-md border border-border-flat bg-bg-card p-3">
                                <span class="block text-xs font-black uppercase text-text-muted">Shop ID</span>
                                <code class="mt-1 block break-all text-xs text-text-main">{request.shopId}</code>
                            </div>
                            <button class="btn btn-secondary mt-4 w-full" on:click={() => copyText(request?.code || '', 'Licence request copied')}>
                                Copy licence request
                            </button>
                        {:else}
                            <p class="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-text-main">The licence request is unavailable.</p>
                        {/if}
                    </section>

                    <section class="rounded-md border border-border-flat bg-bg-panel p-4 sm:p-5">
                        <span class="text-xs font-black uppercase tracking-[0.14em] text-success">Activation</span>
                        <h2 class="mt-2 text-xl text-text-main">Install the signed licence</h2>
                        <p class="mt-2 text-sm leading-relaxed text-text-muted">
                            Import the supplied licence file, or paste its signed code below. A licence issued for another shop will be rejected.
                        </p>

                        <button class="btn btn-primary mt-4 w-full" disabled={!nativeRuntime || activating} on:click={importLicenceFile}>
                            {activating ? 'Checking licence...' : 'Import licence file'}
                        </button>

                        <div class="my-4 flex items-center gap-3 text-xs font-black uppercase text-text-muted" aria-hidden="true">
                            <span class="h-px flex-1 bg-border-flat"></span>
                            <span>or paste code</span>
                            <span class="h-px flex-1 bg-border-flat"></span>
                        </div>

                        <label class="block text-sm font-bold text-text-main" for="manual-licence-code">Signed licence code</label>
                        <div class="relative mt-2">
                            <textarea
                                id="manual-licence-code"
                                class="min-h-[118px] w-full resize-y pr-14 font-mono text-xs"
                                maxlength="16384"
                                data-touch-keyboard="button"
                                bind:value={licenceCode}
                                placeholder="LBJ1..."
                                spellcheck="false"
                            ></textarea>
                            <TouchKeyboardButton targetId="manual-licence-code" label="Open licence keyboard" embedded />
                        </div>
                        <button class="btn btn-success mt-3 w-full" disabled={!nativeRuntime || activating || !licenceCode.trim()} on:click={activateCode}>
                            {activating ? 'Checking licence...' : 'Activate licence'}
                        </button>

                        {#if status?.signatureValid}
                            <div class="mt-5 border-t border-border-flat pt-5">
                                <h3 class="text-base text-text-main">Licence details</h3>
                                <dl class="mt-3 grid grid-cols-2 gap-3 text-sm">
                                    <div class="rounded-md border border-border-flat bg-bg-card p-3">
                                        <dt class="text-xs font-black uppercase text-text-muted">Customer</dt>
                                        <dd class="mt-1 break-words font-bold text-text-main">{status.customerName || 'Not named'}</dd>
                                    </div>
                                    <div class="rounded-md border border-border-flat bg-bg-card p-3">
                                        <dt class="text-xs font-black uppercase text-text-muted">Expires</dt>
                                        <dd class="mt-1 font-bold text-text-main">{formatDate(status.expiresOn)}</dd>
                                    </div>
                                    <div class="rounded-md border border-border-flat bg-bg-card p-3">
                                        <dt class="text-xs font-black uppercase text-text-muted">Till allowance</dt>
                                        <dd class="mt-1 font-bold text-text-main">{status.maxTills}</dd>
                                    </div>
                                    <div class="rounded-md border border-border-flat bg-bg-card p-3">
                                        <dt class="text-xs font-black uppercase text-text-muted">Licence ID</dt>
                                        <dd class="mt-1 break-all font-mono text-xs text-text-main">{status.licenseId}</dd>
                                    </div>
                                </dl>
                            </div>
                        {/if}
                    </section>
                </div>

            {/if}
        </div>
    </div>
</MgmtPage>

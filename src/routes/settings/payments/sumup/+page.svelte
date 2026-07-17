<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';
    import { loadDojoConfig, saveDojoConfig } from '$lib/dojo';
    import {
        clearSumupSecrets,
        getSumupReaderStatus,
        listSumupReaders,
        loadSumupConfig,
        pairSumupReader,
        saveSumupConfig,
        type SumupConfig,
        type SumupReader,
        type SumupReaderStatus,
    } from '$lib/sumup';

    let config: SumupConfig = {
        enabled: false,
        merchantCode: '',
        readerId: '',
        readerName: '',
        currency: 'GBP',
        affiliateAppId: '',
        apiKeyConfigured: false,
        affiliateKeyConfigured: false,
        ready: false,
    };
    let apiKey = '';
    let affiliateKey = '';
    let readers: SumupReader[] = [];
    let readerStatus: SumupReaderStatus | null = null;
    let pairingCode = '';
    let pairingName = 'Shop Solo';
    let loading = true;
    let saving = false;
    let readerBusy = false;
    let pairingBusy = false;

    $: readerOptions = [
        ...(!readers.some((reader) => reader.id === config.readerId) && config.readerId
            ? [{ label: config.readerName || config.readerId, value: config.readerId }]
            : []),
        ...readers.map((reader) => ({
            label: `${reader.name} - ${reader.status === 'paired' ? 'Paired' : reader.status}`,
            value: reader.id,
        })),
    ];
    $: selectedReader = readers.find((reader) => reader.id === config.readerId);
    $: setupComplete = Boolean(
        config.merchantCode.trim()
        && config.readerId.trim()
        && config.affiliateAppId.trim()
        && (apiKey.trim() || config.apiKeyConfigured)
        && (affiliateKey.trim() || config.affiliateKeyConfigured),
    );

    onMount(async () => {
        try {
            config = await loadSumupConfig();
        } catch (error) {
            toast(`Could not load SumUp settings: ${error}`, 'error');
        } finally {
            loading = false;
        }
    });

    function selectReader(readerId: string) {
        const reader = readers.find((entry) => entry.id === readerId);
        config = {
            ...config,
            readerId,
            readerName: reader?.name || config.readerName,
        };
        readerStatus = null;
    }

    async function saveConfiguration(enabled = config.enabled, showToast = true): Promise<boolean> {
        if (saving) return false;
        saving = true;
        try {
            config = await saveSumupConfig({
                enabled,
                merchantCode: config.merchantCode,
                readerId: config.readerId,
                readerName: config.readerName,
                currency: config.currency,
                affiliateAppId: config.affiliateAppId,
                apiKey,
                affiliateKey,
            });
            apiKey = '';
            affiliateKey = '';
            if (showToast) toast(enabled ? 'SumUp Solo is enabled on this till' : 'SumUp settings saved', 'success');
            return true;
        } catch (error) {
            toast(`Could not save SumUp settings: ${error}`, 'error');
            return false;
        } finally {
            saving = false;
        }
    }

    async function findReaders() {
        if (!(await saveConfiguration(config.enabled, false))) return;
        readerBusy = true;
        readerStatus = null;
        try {
            readers = await listSumupReaders();
            if (readers.length === 0) {
                toast('No paired Solo readers were found. Pair this Solo below.', 'info');
                return;
            }
            if (!config.readerId && readers.length === 1) selectReader(readers[0].id);
            toast(`${readers.length} SumUp ${readers.length === 1 ? 'reader' : 'readers'} found`, 'success');
        } catch (error) {
            toast(`Could not load SumUp readers: ${error}`, 'error');
        } finally {
            readerBusy = false;
        }
    }

    async function pairReader() {
        if (!(await saveConfiguration(config.enabled, false))) return;
        pairingBusy = true;
        try {
            const reader = await pairSumupReader(pairingCode, pairingName);
            readers = [reader, ...readers.filter((entry) => entry.id !== reader.id)];
            selectReader(reader.id);
            pairingCode = '';
            await saveConfiguration(config.enabled, false);
            toast('Solo pairing started. Confirm it on the reader, then test the connection.', 'success');
        } catch (error) {
            toast(`Could not pair the Solo: ${error}`, 'error');
        } finally {
            pairingBusy = false;
        }
    }

    async function testReader() {
        if (!(await saveConfiguration(config.enabled, false))) return;
        readerBusy = true;
        try {
            readerStatus = await getSumupReaderStatus();
            if (readerStatus.status === 'ONLINE') {
                toast('SumUp Solo is online and responding', 'success');
            } else {
                toast('The Solo is saved but currently offline', 'error');
            }
        } catch (error) {
            readerStatus = null;
            toast(`SumUp reader test failed: ${error}`, 'error');
        } finally {
            readerBusy = false;
        }
    }

    async function toggleEnabled() {
        if (config.enabled) {
            await saveConfiguration(false);
            return;
        }
        if (!setupComplete) {
            toast('Complete the credentials and choose a reader before enabling SumUp', 'error');
            return;
        }
        try {
            const dojo = await loadDojoConfig().catch(() => null);
            if (dojo?.enabled) {
                await saveDojoConfig({
                    enabled: false,
                    terminalId: dojo.terminalId,
                    terminalName: dojo.terminalName,
                    currency: dojo.currency,
                    softwareHouseId: dojo.softwareHouseId,
                    resellerId: dojo.resellerId,
                });
            }
            await saveConfiguration(true);
        } catch (error) {
            toast(`Could not switch the card provider to SumUp: ${error}`, 'error');
        }
    }

    async function removeSecrets() {
        if (!confirm('Remove the saved SumUp API and affiliate keys from this till?')) return;
        try {
            config = await clearSumupSecrets();
            apiKey = '';
            affiliateKey = '';
            readerStatus = null;
            toast('SumUp secrets removed and card integration disabled', 'success');
        } catch (error) {
            toast(`Could not remove SumUp secrets: ${error}`, 'error');
        }
    }
</script>

<MgmtPage title="SumUp" backFallback="/settings/payments">
    <div slot="actions" class="flex flex-wrap gap-3">
        <button class="btn btn-secondary" disabled={loading || readerBusy || !config.readerId} on:click={testReader}>
            {readerBusy ? 'Checking...' : 'Test Reader'}
        </button>
        <button class="btn btn-primary" disabled={loading || saving} on:click={() => saveConfiguration()}>
            {saving ? 'Saving...' : 'Save Settings'}
        </button>
    </div>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <p class="settings-hero-kicker !text-success">Card terminal</p>
                    <h2 class="settings-hero-title">SumUp Solo</h2>
                    <p class="settings-hero-copy">Send the card amount to a Solo and wait for approval before the sale is saved.</p>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <span class="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-flat bg-bg-panel px-4 font-bold">
                        <span class="h-3 w-3 rounded-full {config.enabled ? 'bg-success' : 'bg-text-muted'}"></span>
                        {config.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <button class="btn {config.enabled ? 'btn-danger' : 'btn-success'}" disabled={loading || saving} on:click={toggleEnabled}>
                        {config.enabled ? 'Disable SumUp' : 'Enable SumUp'}
                    </button>
                </div>
            </div>
        </section>

        {#if $connectionState.mode !== 'multi'}
            <div class="rounded-md border border-warning/60 bg-warning/10 p-4 text-sm font-semibold text-text-main">
                Shared-reader protection needs Multi-till mode. Keep SumUp disabled until this till is connected to MariaDB.
            </div>
        {:else if !$connectionState.mysqlOnline}
            <div class="rounded-md border border-danger/60 bg-danger/10 p-4 text-sm font-semibold text-text-main">
                MariaDB is offline. SumUp checkout will stay blocked so two tills cannot use the same reader together.
            </div>
        {/if}

        <section class="settings-section">
            <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h3 class="settings-section-title">Account access</h3>
                    <p class="text-sm text-text-muted">Saved only in this machine's protected app configuration, never synchronized to another till.</p>
                </div>
                <div class="flex gap-2 text-xs font-bold">
                    <span class="rounded-sm px-2 py-1 {config.apiKeyConfigured ? 'bg-success/15 text-success' : 'bg-bg-panel text-text-muted'}">API key {config.apiKeyConfigured ? 'saved' : 'needed'}</span>
                    <span class="rounded-sm px-2 py-1 {config.affiliateKeyConfigured ? 'bg-success/15 text-success' : 'bg-bg-panel text-text-muted'}">Affiliate key {config.affiliateKeyConfigured ? 'saved' : 'needed'}</span>
                </div>
            </div>
            <div class="form-grid">
                <div class="field">
                    <label for="sumup-merchant">Merchant code</label>
                    <input id="sumup-merchant" bind:value={config.merchantCode} autocomplete="off" placeholder="e.g. MXXXXXXXX" />
                </div>
                <div class="field">
                    <label for="sumup-currency">Currency</label>
                    <input id="sumup-currency" bind:value={config.currency} maxlength="3" autocapitalize="characters" />
                </div>
                <div class="field span-2">
                    <label for="sumup-api-key">API key</label>
                    <input id="sumup-api-key" type="password" bind:value={apiKey} autocomplete="new-password" placeholder={config.apiKeyConfigured ? 'Saved - leave blank to keep it' : 'Enter SumUp API key'} />
                </div>
                <div class="field">
                    <label for="sumup-app-id">Affiliate App ID</label>
                    <input id="sumup-app-id" bind:value={config.affiliateAppId} autocomplete="off" placeholder="Your registered app ID" />
                </div>
                <div class="field">
                    <label for="sumup-affiliate-key">Affiliate key</label>
                    <input id="sumup-affiliate-key" type="password" bind:value={affiliateKey} autocomplete="new-password" placeholder={config.affiliateKeyConfigured ? 'Saved - leave blank to keep it' : 'Enter affiliate key'} />
                </div>
            </div>
        </section>

        <section class="settings-section">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h3 class="settings-section-title">Solo reader</h3>
                    <p class="text-sm text-text-muted">One Solo can be selected on both tills. MariaDB gives it to only one checkout at a time.</p>
                </div>
                <button class="btn btn-secondary" disabled={readerBusy || saving} on:click={findReaders}>
                    {readerBusy ? 'Finding...' : 'Find My Readers'}
                </button>
            </div>

            <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(250px,0.55fr)]">
                <div class="field">
                    {#if readerOptions.length > 0}
                        <CustomSelect label="Selected reader" value={config.readerId} options={readerOptions} on:change={(event) => selectReader(event.detail)} />
                    {:else}
                        <span class="text-sm font-semibold text-text-muted">Selected reader</span>
                        <div class="flex min-h-12 items-center rounded-md border border-border-flat bg-bg-panel px-3 text-text-muted">
                            Save the credentials, then find or pair a reader.
                        </div>
                    {/if}
                    {#if selectedReader?.device}
                        <small class="text-text-muted">{selectedReader.device.model || 'Solo'} · {selectedReader.device.identifier || 'Device identifier unavailable'}</small>
                    {/if}
                </div>

                <div class="rounded-md border p-4 {readerStatus?.status === 'ONLINE' ? 'border-success/60 bg-success/10' : readerStatus ? 'border-danger/60 bg-danger/10' : 'border-border-flat bg-bg-panel'}">
                    <span class="text-xs font-black uppercase text-text-muted">Live status</span>
                    <strong class="mt-1 block text-lg">{readerStatus ? `${readerStatus.status} · ${readerStatus.state}` : 'Not tested'}</strong>
                    {#if readerStatus}
                        <small class="mt-1 block text-text-muted">
                            {readerStatus.connectionType || 'Connection unknown'}
                            {readerStatus.batteryLevel !== undefined ? ` · ${Math.round(readerStatus.batteryLevel)}% battery` : ''}
                        </small>
                        {#if readerStatus.firmwareVersion}<small class="block text-text-muted">Firmware {readerStatus.firmwareVersion}</small>{/if}
                    {/if}
                </div>
            </div>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Pair a new Solo</h3>
            <p class="mb-4 text-sm text-text-muted">On the logged-out Solo, open Connections, choose API, and generate a pairing code.</p>
            <div class="form-grid">
                <div class="field">
                    <label for="sumup-pairing-code">Pairing code</label>
                    <input id="sumup-pairing-code" bind:value={pairingCode} maxlength="9" autocapitalize="characters" placeholder="8 or 9 characters" />
                </div>
                <div class="field">
                    <label for="sumup-pairing-name">Reader name</label>
                    <input id="sumup-pairing-name" bind:value={pairingName} maxlength="500" />
                </div>
            </div>
            <div class="mt-4 flex flex-wrap justify-between gap-3">
                <button class="btn btn-danger" disabled={!config.apiKeyConfigured && !apiKey.trim()} on:click={removeSecrets}>Remove Saved Keys</button>
                <button class="btn btn-primary" disabled={pairingBusy || pairingCode.trim().length < 8} on:click={pairReader}>
                    {pairingBusy ? 'Pairing...' : 'Pair Reader'}
                </button>
            </div>
        </section>
    </div>
</MgmtPage>

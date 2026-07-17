<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';
    import {
        clearDojoSecret,
        getDojoTerminalStatus,
        listDojoTerminals,
        loadDojoConfig,
        saveDojoConfig,
        type DojoConfig,
        type DojoTerminal,
    } from '$lib/dojo';
    import { loadSumupConfig, saveSumupConfig } from '$lib/sumup';

    let config: DojoConfig = {
        enabled: false,
        terminalId: '',
        terminalName: '',
        currency: 'GBP',
        softwareHouseId: 'softwareHouse1',
        resellerId: 'reseller1',
        apiKeyConfigured: false,
        apiEnvironment: 'Unknown',
        apiVersion: '2026-02-27',
        ready: false,
    };
    let apiKey = '';
    let terminals: DojoTerminal[] = [];
    let terminalStatus: DojoTerminal | null = null;
    let loading = true;
    let saving = false;
    let terminalBusy = false;

    $: terminalOptions = [
        ...(!terminals.some((terminal) => terminal.id === config.terminalId) && config.terminalId
            ? [{ label: config.terminalName || config.terminalId, value: config.terminalId }]
            : []),
        ...terminals.map((terminal) => ({
            label: `${terminal.properties?.tid || terminal.id} - ${terminal.status}`,
            value: terminal.id,
        })),
    ];
    $: setupComplete = Boolean(
        config.terminalId.trim()
        && config.softwareHouseId.trim()
        && config.resellerId.trim()
        && (apiKey.trim() || config.apiKeyConfigured),
    );

    onMount(async () => {
        try {
            config = await loadDojoConfig();
        } catch (error) {
            toast(`Could not load Dojo settings: ${error}`, 'error');
        } finally {
            loading = false;
        }
    });

    function selectTerminal(terminalId: string) {
        const terminal = terminals.find((entry) => entry.id === terminalId);
        config = {
            ...config,
            terminalId,
            terminalName: terminal?.properties?.tid ? `Dojo ${terminal.properties.tid}` : config.terminalName || 'Dojo terminal',
        };
        terminalStatus = terminal || null;
    }

    async function saveConfiguration(enabled = config.enabled, showToast = true): Promise<boolean> {
        if (saving) return false;
        saving = true;
        try {
            config = await saveDojoConfig({
                enabled,
                terminalId: config.terminalId,
                terminalName: config.terminalName,
                currency: config.currency,
                softwareHouseId: config.softwareHouseId,
                resellerId: config.resellerId,
                apiKey,
            });
            apiKey = '';
            if (showToast) toast(enabled ? 'Dojo is enabled on this till' : 'Dojo settings saved', 'success');
            return true;
        } catch (error) {
            toast(`Could not save Dojo settings: ${error}`, 'error');
            return false;
        } finally {
            saving = false;
        }
    }

    async function findTerminals() {
        if (!(await saveConfiguration(config.enabled, false))) return;
        terminalBusy = true;
        terminalStatus = null;
        try {
            terminals = await listDojoTerminals();
            if (terminals.length === 0) {
                toast('No Dojo terminals are assigned to this API account', 'info');
                return;
            }
            if (!config.terminalId && terminals.length === 1) selectTerminal(terminals[0].id);
            toast(`${terminals.length} Dojo ${terminals.length === 1 ? 'terminal' : 'terminals'} found`, 'success');
        } catch (error) {
            toast(`Could not load Dojo terminals: ${error}`, 'error');
        } finally {
            terminalBusy = false;
        }
    }

    async function testTerminal() {
        if (!(await saveConfiguration(config.enabled, false))) return;
        terminalBusy = true;
        try {
            terminalStatus = await getDojoTerminalStatus();
            if (terminalStatus.status === 'Available') toast('Dojo terminal is online and available', 'success');
            else if (terminalStatus.status === 'InUse') toast('Dojo terminal is online but currently in use', 'info');
            else toast('The Dojo terminal is assigned but currently offline', 'error');
        } catch (error) {
            terminalStatus = null;
            toast(`Dojo terminal test failed: ${error}`, 'error');
        } finally {
            terminalBusy = false;
        }
    }

    async function disableSumupIfNeeded() {
        const sumup = await loadSumupConfig().catch(() => null);
        if (!sumup?.enabled) return;
        await saveSumupConfig({
            enabled: false,
            merchantCode: sumup.merchantCode,
            readerId: sumup.readerId,
            readerName: sumup.readerName,
            currency: sumup.currency,
            affiliateAppId: sumup.affiliateAppId,
        });
    }

    async function toggleEnabled() {
        if (config.enabled) {
            await saveConfiguration(false);
            return;
        }
        if (!setupComplete) {
            toast('Complete the Dojo credentials and choose a terminal first', 'error');
            return;
        }
        try {
            await disableSumupIfNeeded();
            await saveConfiguration(true);
        } catch (error) {
            toast(`Could not switch the card provider to Dojo: ${error}`, 'error');
        }
    }

    async function removeSecret() {
        if (!confirm('Remove the saved Dojo API key from this till?')) return;
        try {
            config = await clearDojoSecret();
            apiKey = '';
            terminalStatus = null;
            toast('Dojo API key removed and integration disabled', 'success');
        } catch (error) {
            toast(`Could not remove the Dojo API key: ${error}`, 'error');
        }
    }
</script>

<MgmtPage title="Dojo" backFallback="/settings/payments">
    <div slot="actions" class="flex flex-wrap gap-3">
        <button class="btn btn-secondary" disabled={loading || terminalBusy || !config.terminalId} on:click={testTerminal}>
            {terminalBusy ? 'Checking...' : 'Test Terminal'}
        </button>
        <button class="btn btn-primary" disabled={loading || saving} on:click={() => saveConfiguration()}>
            {saving ? 'Saving...' : 'Save Settings'}
        </button>
    </div>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <p class="settings-hero-kicker !text-success">Pay at Counter</p>
                    <h2 class="settings-hero-title">Dojo terminal</h2>
                    <p class="settings-hero-copy">Send the card amount to the selected Dojo terminal and save only after confirmed capture.</p>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <span class="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-flat bg-bg-panel px-4 font-bold">
                        <span class="h-3 w-3 rounded-full {config.enabled ? 'bg-success' : 'bg-text-muted'}"></span>
                        {config.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <button class="btn {config.enabled ? 'btn-danger' : 'btn-success'}" disabled={loading || saving} on:click={toggleEnabled}>
                        {config.enabled ? 'Disable Dojo' : 'Enable Dojo'}
                    </button>
                </div>
            </div>
        </section>

        {#if $connectionState.mode !== 'multi'}
            <div class="rounded-md border border-warning/60 bg-warning/10 p-4 text-sm font-semibold text-text-main">
                Shared-terminal protection needs Multi-till mode. Keep Dojo disabled until this till is connected to MariaDB.
            </div>
        {:else if !$connectionState.mysqlOnline}
            <div class="rounded-md border border-danger/60 bg-danger/10 p-4 text-sm font-semibold text-text-main">
                MariaDB is offline. Dojo checkout will stay blocked so two tills cannot use the same terminal together.
            </div>
        {/if}

        <section class="settings-section">
            <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h3 class="settings-section-title">Dojo API access</h3>
                    <p class="text-sm text-text-muted">Credentials are stored only on this machine and are not synchronized to another till.</p>
                </div>
                <div class="flex flex-wrap gap-2 text-xs font-bold">
                    <span class="rounded-sm px-2 py-1 {config.apiKeyConfigured ? 'bg-success/15 text-success' : 'bg-bg-panel text-text-muted'}">API key {config.apiKeyConfigured ? 'saved' : 'needed'}</span>
                    <span class="rounded-sm bg-bg-panel px-2 py-1 text-text-muted">{config.apiEnvironment} · API {config.apiVersion}</span>
                </div>
            </div>
            <div class="form-grid">
                <div class="field span-2">
                    <label for="dojo-api-key">Secret API key</label>
                    <input id="dojo-api-key" type="password" bind:value={apiKey} autocomplete="new-password" placeholder={config.apiKeyConfigured ? 'Saved - leave blank to keep it' : 'sk_sandbox_... or sk_prod_...'} />
                </div>
                <div class="field">
                    <label for="dojo-software-house">Software-house ID</label>
                    <input id="dojo-software-house" bind:value={config.softwareHouseId} autocomplete="off" />
                </div>
                <div class="field">
                    <label for="dojo-reseller">Reseller ID</label>
                    <input id="dojo-reseller" bind:value={config.resellerId} autocomplete="off" />
                </div>
                <div class="field">
                    <label for="dojo-currency">Currency</label>
                    <input id="dojo-currency" bind:value={config.currency} maxlength="3" autocapitalize="characters" />
                </div>
                <div class="field">
                    <label for="dojo-terminal-name">Terminal name on this till</label>
                    <input id="dojo-terminal-name" bind:value={config.terminalName} maxlength="160" placeholder="Counter terminal" />
                </div>
            </div>
            <p class="mt-3 text-xs text-text-muted">Sandbox uses softwareHouse1 and reseller1. For production, enter the IDs assigned by Dojo Partner Enablement.</p>
        </section>

        <section class="settings-section">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h3 class="settings-section-title">Assigned terminal</h3>
                    <p class="text-sm text-text-muted">Dojo returns terminals attached to the API account. Choose the physical counter terminal for this till.</p>
                </div>
                <button class="btn btn-secondary" disabled={terminalBusy || saving} on:click={findTerminals}>
                    {terminalBusy ? 'Finding...' : 'Find My Terminals'}
                </button>
            </div>

            <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(250px,0.55fr)]">
                <div class="field">
                    {#if terminalOptions.length > 0}
                        <CustomSelect label="Selected terminal" value={config.terminalId} options={terminalOptions} on:change={(event) => selectTerminal(event.detail)} />
                    {:else}
                        <span class="text-sm font-semibold text-text-muted">Selected terminal</span>
                        <div class="flex min-h-12 items-center rounded-md border border-border-flat bg-bg-panel px-3 text-text-muted">
                            Save the API access, then find your terminals.
                        </div>
                    {/if}
                </div>

                <div class="rounded-md border p-4 {terminalStatus?.status === 'Available' ? 'border-success/60 bg-success/10' : terminalStatus?.status === 'InUse' ? 'border-warning/60 bg-warning/10' : terminalStatus ? 'border-danger/60 bg-danger/10' : 'border-border-flat bg-bg-panel'}">
                    <span class="text-xs font-black uppercase text-text-muted">Live status</span>
                    <strong class="mt-1 block text-lg">{terminalStatus?.status || 'Not tested'}</strong>
                    {#if terminalStatus}
                        <small class="mt-1 block text-text-muted">TID {terminalStatus.properties?.tid || 'Unavailable'}</small>
                        <small class="block text-text-muted">Updated {new Date(terminalStatus.updatedAt).toLocaleString()}</small>
                    {/if}
                </div>
            </div>

            <div class="mt-4 flex justify-start">
                <button class="btn btn-danger" disabled={!config.apiKeyConfigured && !apiKey.trim()} on:click={removeSecret}>Remove Saved API Key</button>
            </div>
        </section>
    </div>
</MgmtPage>

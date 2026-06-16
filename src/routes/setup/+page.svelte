<script lang="ts">
    import { goto } from '$app/navigation';
    import { getMysqlDb, saveMode, testMysqlConnection, type MysqlConfig } from '$lib/stores/connection';
    import { initMysqlDb } from '$lib/stores/mysql';
    import { ensureDatabaseIdentityForSync, ensureLocalShopIdentity, hydrateSvelteStores, wipeAndPullFromServer } from '$lib/stores/database';
    import { upsert } from '$lib/stores/database';
    import { hashPin } from '$lib/stores/session';
    import { employeesDB, settingsDB, now, uuid } from '$lib/stores/db';
    import { get } from 'svelte/store';

    // ── Mode selection ──────────────────────────────────────────
    let selectedMode: 'single' | 'multi' | null = null;

    // ── Multi-POS connection form ───────────────────────────────
    let host = '192.168.1.100';
    let port = 3306;
    let username = 'pos_app';
    let password = '';
    let database = 'pos_db';

    // ── Connection test state ───────────────────────────────────
    let testResult: 'idle' | 'testing' | 'pass' | 'fail' = 'idle';
    let testMessage = '';
    let connecting = false;
    let storeName = '';
    let adminName = '';
    let adminPin = '';
    let needsAdmin = false;
    let needsShopDetails = true;
    let stockTrackingEnabled = true;

    // ── Helpers ─────────────────────────────────────────────────
    function buildConfig(): MysqlConfig {
        return { host, port, user: username, password, database };
    }

    function hasActiveAdmin() {
        return get(employeesDB).some((employee) => employee.isActive && employee.role === 'admin');
    }

    async function createShopAdmin() {
        if ((needsShopDetails && !storeName.trim()) || !adminName.trim() || !/^\d{4,8}$/.test(adminPin)) {
            throw new Error(`${needsShopDetails ? 'Enter a shop name, ' : 'Enter '}administrator name, and a 4 to 8 digit PIN.`);
        }
        const stamp = now();
        await ensureLocalShopIdentity(needsShopDetails ? storeName.trim() : '');
        if (needsShopDetails) {
            await upsert('settings', {
                key: 'store_info',
                value: JSON.stringify({
                    id: 'store-main',
                    name: storeName.trim(),
                    address: '',
                    phone: '',
                    email: '',
                    currency: 'GBP',
                    taxIncludedInPrice: true,
                    receiptHeader: storeName.trim(),
                    receiptFooter: 'Thank you for visiting!',
                    createdAt: stamp,
                }),
                updatedAt: stamp,
            }, 'key');
            await upsert('settings', {
                key: 'stock_tracking_enabled',
                value: stockTrackingEnabled ? 'true' : 'false',
                updatedAt: stamp,
            }, 'key');
        }
        await upsert('employees', {
            id: uuid(),
            storeId: 'store-main',
            name: adminName.trim(),
            pin: '',
            pinHash: await hashPin(adminPin),
            role: 'admin',
            email: '',
            isActive: true,
            createdAt: stamp,
            updatedAt: stamp,
        });
        await upsert('tax_rates', {
            id: 'tax-standard-vat',
            name: 'Standard VAT (20%)',
            rate: 0.2,
            isDefault: true,
            createdAt: stamp,
            updatedAt: stamp,
        });
    }

    async function handleTestConnection() {
        testResult = 'testing';
        testMessage = '';
        try {
            const ok = await testMysqlConnection(buildConfig());
            testResult = ok ? 'pass' : 'fail';
            testMessage = ok
                ? 'Connection successful!'
                : 'Could not connect. Check your settings.';
        } catch (err) {
            testResult = 'fail';
            testMessage = String(err);
        }
    }

    async function handleConnect() {
        connecting = true;
        try {
            const cfg = buildConfig();
            await initMysqlDb(cfg);
            await saveMode('multi', cfg);
            await ensureDatabaseIdentityForSync();
            const server = await getMysqlDb();
            if (!server) throw new Error('MariaDB connected during the test but could not be opened.');
            const admins: any[] = await server.select(
                `SELECT id FROM employees WHERE role = 'admin' AND isActive = 1 LIMIT 1`
            );
            const shopSettings: any[] = await server.select(
                "SELECT `key` FROM settings WHERE `key` = 'store_info' LIMIT 1"
            );

            // Download existing employees and shop data before deciding whether
            // this is a new shop or an additional till joining an existing one.
            await wipeAndPullFromServer();

            if (admins.length > 0) {
                goto('/');
                return;
            }

            needsShopDetails = shopSettings.length === 0;
            needsAdmin = true;
            testResult = 'pass';
            testMessage = 'Database connected. No active administrator exists, so create the first administrator.';
            connecting = false;
        } catch (err) {
            testResult = 'fail';
            testMessage = `Connection failed: ${err}`;
            connecting = false;
        }
    }

    async function handleContinueSingle() {
        connecting = true;
        try {
            await saveMode('single');
            await hydrateSvelteStores();
            needsShopDetails = !get(settingsDB).some((setting) => setting.key === 'store_info');
            if (hasActiveAdmin()) {
                goto('/');
                return;
            }
            needsAdmin = true;
            connecting = false;
        } catch (err) {
            testResult = 'fail';
            testMessage = `Error: ${err}`;
            connecting = false;
        }
    }

    async function handleCreateAdmin() {
        connecting = true;
        try {
            await createShopAdmin();
            await hydrateSvelteStores();
            goto('/');
        } catch (err) {
            testResult = 'fail';
            testMessage = `Error: ${err}`;
            connecting = false;
        }
    }
</script>

<!-- ────────────────────────────────────────────────────────────
     Full-screen setup view
     ──────────────────────────────────────────────────────────── -->
<div class="fixed inset-0 flex items-center justify-center bg-bg-base p-4 overflow-y-auto">
    <div class="w-full max-w-2xl flex flex-col items-center gap-8 py-12">

        <!-- ── Branding ──────────────────────────────────────── -->
        <div class="text-center">
            <h1 class="text-3xl font-bold text-text-main tracking-tight">
                Welcome to <span class="text-accent-primary">POS</span>
            </h1>
            <p class="mt-2 text-text-muted text-base">
                Choose how you want to run your point-of-sale system.
            </p>
        </div>

        <!-- ── Mode cards ────────────────────────────────────── -->
        {#if !needsAdmin}
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full">

            <!-- Single POS -->
            <button
                class="group relative flex flex-col items-center gap-4 p-8 rounded-lg border-2 transition-all duration-200 cursor-pointer
                    {selectedMode === 'single'
                        ? 'border-accent-primary bg-bg-card shadow-lg shadow-accent-primary/10'
                        : 'border-border-flat bg-bg-card hover:border-accent-primary/50 hover:bg-bg-card-hover'}"
                on:click={() => { selectedMode = 'single'; testResult = 'idle'; testMessage = ''; }}
            >
                {#if selectedMode === 'single'}
                    <span class="absolute top-3 right-3 w-5 h-5 rounded-full bg-accent-primary flex items-center justify-center text-[0.7rem] text-white font-bold">✓</span>
                {/if}
                <span class="text-4xl">🖥️</span>
                <span class="text-lg font-semibold text-text-main">Single POS</span>
                <span class="text-sm text-text-muted text-center leading-relaxed">
                    One terminal, local storage only.<br/>No network needed.
                </span>
            </button>

            <!-- Multi POS -->
            <button
                class="group relative flex flex-col items-center gap-4 p-8 rounded-lg border-2 transition-all duration-200 cursor-pointer
                    {selectedMode === 'multi'
                        ? 'border-accent-primary bg-bg-card shadow-lg shadow-accent-primary/10'
                        : 'border-border-flat bg-bg-card hover:border-accent-primary/50 hover:bg-bg-card-hover'}"
                on:click={() => { selectedMode = 'multi'; testResult = 'idle'; testMessage = ''; }}
            >
                {#if selectedMode === 'multi'}
                    <span class="absolute top-3 right-3 w-5 h-5 rounded-full bg-accent-primary flex items-center justify-center text-[0.7rem] text-white font-bold">✓</span>
                {/if}
                <span class="text-4xl">🔗</span>
                <span class="text-lg font-semibold text-text-main">Multi POS</span>
                <span class="text-sm text-text-muted text-center leading-relaxed">
                    Connect multiple terminals via<br/>MariaDB on your local network.
                </span>
            </button>
            </div>
        {/if}

        <!-- ── Single POS: Continue ──────────────────────────── -->
        {#if selectedMode === 'single' && !needsAdmin}
            <div class="w-full flex flex-col items-center gap-3 animate-fade-in">
                <button
                    class="btn btn-primary px-12 py-3.5 text-base font-semibold rounded-lg"
                    disabled={connecting}
                    on:click={handleContinueSingle}
                >
                    {connecting ? 'Setting up…' : 'Continue →'}
                </button>
            </div>
        {/if}

        <!-- ── Multi POS: Connection form ────────────────────── -->
        {#if selectedMode === 'multi' && !needsAdmin}
            <div class="w-full bg-bg-panel border border-border-flat rounded-lg p-6 flex flex-col gap-5 animate-fade-in">

                <h2 class="text-base font-semibold text-text-main">
                    MariaDB Connection
                </h2>
                {#if username.toLowerCase() === 'root'}
                    <p class="text-danger text-sm">For shop safety, create and use a dedicated MariaDB account such as <strong>pos_app</strong>, not root.</p>
                {/if}

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <!-- Host -->
                    <div class="field">
                        <label for="db-host">Host</label>
                        <input id="db-host" type="text" bind:value={host} placeholder="192.168.1.100" />
                    </div>
                    <!-- Port -->
                    <div class="field">
                        <label for="db-port">Port</label>
                        <input id="db-port" type="number" bind:value={port} placeholder="3306" />
                    </div>
                    <!-- Username -->
                    <div class="field">
                        <label for="db-user">Username</label>
                        <input id="db-user" type="text" bind:value={username} placeholder="pos_app" />
                    </div>
                    <!-- Password -->
                    <div class="field">
                        <label for="db-pass">Password</label>
                        <input id="db-pass" type="password" bind:value={password} placeholder="••••••••" />
                    </div>
                    <!-- Database -->
                    <div class="field sm:col-span-2">
                        <label for="db-name">Database</label>
                        <input id="db-name" type="text" bind:value={database} placeholder="pos_db" />
                    </div>
                </div>

                <!-- Status message -->
                {#if testMessage}
                    <div class="flex items-center gap-2 text-sm
                        {testResult === 'pass' ? 'text-success' : 'text-danger'}">
                        <span class="text-lg">{testResult === 'pass' ? '✅' : '❌'}</span>
                        {testMessage}
                    </div>
                {/if}

                <!-- Action buttons -->
                <div class="flex gap-3 justify-end">
                    <button
                        class="btn btn-secondary"
                        disabled={testResult === 'testing'}
                        on:click={handleTestConnection}
                    >
                        {testResult === 'testing' ? 'Testing…' : 'Test Connection'}
                    </button>

                    <button
                        class="btn btn-primary"
                        disabled={testResult !== 'pass' || connecting}
                        on:click={handleConnect}
                    >
                        {connecting ? 'Connecting…' : 'Connect'}
                    </button>
                </div>
            </div>
        {/if}

        {#if needsAdmin}
            <div class="w-full bg-bg-panel border border-border-flat rounded-lg p-6 flex flex-col gap-5 animate-fade-in">
                <div>
                    <h2 class="text-base font-semibold text-text-main">Create First Administrator</h2>
                    <p class="text-sm text-text-muted mt-1">
                        No active administrator was found. Create one to manage this shop.
                    </p>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {#if needsShopDetails}
                        <div class="field sm:col-span-2">
                            <label for="shop-name">Shop Name</label>
                            <input id="shop-name" bind:value={storeName} placeholder="Your shop name" />
                        </div>
                        <div class="sm:col-span-2">
                            <p class="text-sm font-semibold text-text-main mb-2">Do you want to track product stock?</p>
                            <div class="grid grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    class="p-4 rounded-md border-2 text-left transition-colors {stockTrackingEnabled ? 'border-accent-primary bg-accent-primary/10' : 'border-border-flat bg-bg-card'}"
                                    on:click={() => stockTrackingEnabled = true}
                                >
                                    <strong class="block">Yes, track stock</strong>
                                    <span class="text-xs text-text-muted">Reduce stock after sales and restore it after refunds.</span>
                                </button>
                                <button
                                    type="button"
                                    class="p-4 rounded-md border-2 text-left transition-colors {!stockTrackingEnabled ? 'border-accent-primary bg-accent-primary/10' : 'border-border-flat bg-bg-card'}"
                                    on:click={() => stockTrackingEnabled = false}
                                >
                                    <strong class="block">No stock tracking</strong>
                                    <span class="text-xs text-text-muted">Hide stock controls and never change stock quantities.</span>
                                </button>
                            </div>
                        </div>
                    {/if}
                    <div class="field">
                        <label for="admin-name">Administrator Name</label>
                        <input id="admin-name" bind:value={adminName} placeholder="Owner or manager" />
                    </div>
                    <div class="field">
                        <label for="admin-pin">Administrator PIN</label>
                        <input id="admin-pin" type="password" inputmode="numeric" maxlength="8" bind:value={adminPin} placeholder="4 to 8 digits" />
                    </div>
                </div>
                {#if testResult === 'fail' && testMessage}
                    <p class="text-danger text-sm">{testMessage}</p>
                {/if}
                <div class="flex justify-end">
                    <button class="btn btn-primary" disabled={connecting} on:click={handleCreateAdmin}>
                        {connecting ? 'Creating…' : 'Create Administrator'}
                    </button>
                </div>
            </div>
        {/if}

        <!-- ── Footer ────────────────────────────────────────── -->
        <p class="text-xs text-text-muted opacity-60 mt-4">
            You can change this later in Settings → Database.
        </p>
    </div>
</div>

<style>
    /* Subtle entrance animation for the form / continue sections */
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
    }
    :global(.animate-fade-in) {
        animation: fadeIn 0.25s ease-out both;
    }
</style>

<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { connectionState, getMysqlDb, saveMode, testMysqlConnection, type MysqlConfig } from '$lib/stores/connection';
    import { initMysqlDb } from '$lib/stores/mysql';
    import {
        ensureDatabaseIdentityForSync,
        forcePushToServer,
        hasRestorePendingMariaDbReplace,
        ensureLocalShopIdentity,
        getDb,
        hydrateSvelteStores,
        migrateLocalDataToServer,
        replaceMariaDbDataFromThisTill,
        wipeAndPullFromServer
    } from '$lib/stores/database';
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
    const RESTORE_NOTICE_KEY = 'pos_restore_notice';

    type SetupProgressState = 'idle' | 'running' | 'success' | 'error';
    let setupProgressState: SetupProgressState = 'idle';
    let setupProgress = 0;
    let setupProgressTitle = '';
    let setupProgressDetail = '';

    type RestoreNotice = {
        type: 'success' | 'error';
        message: string;
        details?: string;
    };

    let restoreNotice: RestoreNotice | null = null;

    type ShopDataCounts = {
        products: number;
        categories: number;
        orders: number;
        customers: number;
        employees: number;
        storeInfo: number;
    };

    // ── Helpers ─────────────────────────────────────────────────
    function buildConfig(): MysqlConfig {
        return { host, port, user: username, password, database };
    }

    function cleanError(error: unknown): string {
        return String(error).replace(/^Error:\s*/, '').trim();
    }

    function setSetupProgress(
        state: SetupProgressState,
        progress: number,
        title: string,
        detail = '',
    ) {
        setupProgressState = state;
        setupProgress = Math.max(0, Math.min(100, progress));
        setupProgressTitle = title;
        setupProgressDetail = detail;
        testMessage = detail || title;
    }

    function resetSetupProgress() {
        setupProgressState = 'idle';
        setupProgress = 0;
        setupProgressTitle = '';
        setupProgressDetail = '';
    }

    function clearRestoreNotice() {
        restoreNotice = null;
        try {
            sessionStorage.removeItem(RESTORE_NOTICE_KEY);
        } catch {
            // Nothing else to do if session storage is unavailable.
        }
    }

    onMount(() => {
        try {
            const raw = sessionStorage.getItem(RESTORE_NOTICE_KEY);
            if (!raw) return;
            restoreNotice = JSON.parse(raw) as RestoreNotice;
        } catch {
            restoreNotice = null;
        }
    });

    function normalizeCounts(row: any): ShopDataCounts {
        return {
            products: Number(row.products || 0),
            categories: Number(row.categories || 0),
            orders: Number(row.orders || 0),
            customers: Number(row.customers || 0),
            employees: Number(row.employees || 0),
            storeInfo: Number(row.storeInfo || 0),
        };
    }

    function hasBusinessData(counts: ShopDataCounts): boolean {
        return counts.products > 0 || counts.categories > 0 || counts.orders > 0
            || counts.customers > 0;
    }

    function hasRecoverableLocalData(counts: ShopDataCounts): boolean {
        return hasBusinessData(counts) || counts.employees > 0 || counts.storeInfo > 0;
    }

    function shouldRepairIncompleteMariaDb(localCounts: ShopDataCounts, remoteCounts: ShopDataCounts): boolean {
        return hasBusinessData(localCounts)
            && hasBusinessData(remoteCounts)
            && remoteCounts.orders === 0
            && (
                localCounts.products > remoteCounts.products
                || localCounts.categories > remoteCounts.categories
                || localCounts.customers > remoteCounts.customers
            );
    }

    function shouldReplaceMariaDbFromRestoredTill(localCounts: ShopDataCounts, remoteCounts: ShopDataCounts): boolean {
        if (!hasBusinessData(localCounts) || !hasBusinessData(remoteCounts)) return false;
        const localHasMoreCatalogData = localCounts.products > remoteCounts.products
            || localCounts.categories > remoteCounts.categories
            || localCounts.customers > remoteCounts.customers;
        return localHasMoreCatalogData && localCounts.orders >= remoteCounts.orders;
    }

    async function countLocalShopData(): Promise<ShopDataCounts> {
        const local = await getDb();
        const rows: any[] = await local.select(
            `SELECT (SELECT COUNT(*) FROM products) AS products,
                    (SELECT COUNT(*) FROM categories) AS categories,
                    (SELECT COUNT(*) FROM orders) AS orders,
                    (SELECT COUNT(*) FROM customers) AS customers,
                    (SELECT COUNT(*) FROM employees) AS employees,
                    (SELECT COUNT(*) FROM settings WHERE key = 'store_info') AS storeInfo`
        );
        return normalizeCounts(rows[0] || {});
    }

    async function countRemoteShopData(server: any): Promise<ShopDataCounts> {
        const rows: any[] = await server.select(
            `SELECT (SELECT COUNT(*) FROM products) AS products,
                    (SELECT COUNT(*) FROM categories) AS categories,
                    (SELECT COUNT(*) FROM orders) AS orders,
                    (SELECT COUNT(*) FROM customers) AS customers,
                    (SELECT COUNT(*) FROM employees) AS employees,
                    (SELECT COUNT(*) FROM settings WHERE \`key\` = 'store_info') AS storeInfo`
        );
        return normalizeCounts(rows[0] || {});
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
        resetSetupProgress();
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
            setSetupProgress('running', 10, 'Connecting to MariaDB', 'Checking server and creating missing tables...');
            await initMysqlDb(cfg);
            connectionState.set({ mode: 'multi', mysqlConfig: cfg, mysqlOnline: false, syncError: null });
            await saveMode('multi', cfg);
            setSetupProgress('running', 25, 'Checking shop identity', 'Making sure this till belongs to the correct shop database...');
            await ensureDatabaseIdentityForSync();
            const server = await getMysqlDb();
            if (!server) throw new Error('MariaDB connected during the test but could not be opened.');
            connectionState.update((state) => ({ ...state, mysqlOnline: true, syncError: null }));
            setSetupProgress('running', 35, 'Checking shop data', 'Counting products, categories, orders, and customers...');
            const remoteCounts = await countRemoteShopData(server);
            const localCounts = await countLocalShopData();
            const restoreNeedsMariaDbReplace = await hasRestorePendingMariaDbReplace();

            if (restoreNeedsMariaDbReplace || shouldReplaceMariaDbFromRestoredTill(localCounts, remoteCounts)) {
                setSetupProgress(
                    'running',
                    50,
                    'Replacing MariaDB from restored till',
                    `This till has ${localCounts.products.toLocaleString()} products, MariaDB has ${remoteCounts.products.toLocaleString()}. Replacing MariaDB while keeping employees and settings...`
                );
                await replaceMariaDbDataFromThisTill();
                const replacedCounts = await countRemoteShopData(server);
                if (replacedCounts.products < localCounts.products) {
                    throw new Error(
                        `MariaDB replace incomplete: MariaDB has ${replacedCounts.products.toLocaleString()} products, but this till has ${localCounts.products.toLocaleString()}.`
                    );
                }
                setSetupProgress('running', 82, 'MariaDB replaced', 'Refreshing this till after upload...');
            } else if (shouldRepairIncompleteMariaDb(localCounts, remoteCounts)) {
                setSetupProgress(
                    'running',
                    50,
                    'Completing MariaDB upload',
                    `MariaDB has ${remoteCounts.products.toLocaleString()} products, this till has ${localCounts.products.toLocaleString()}. Uploading the missing data...`
                );
                await forcePushToServer();
                const repairedCounts = await countRemoteShopData(server);
                if (repairedCounts.products < localCounts.products) {
                    throw new Error(
                        `Upload incomplete: MariaDB has ${repairedCounts.products.toLocaleString()} products, but this till has ${localCounts.products.toLocaleString()}.`
                    );
                }
                setSetupProgress('running', 82, 'MariaDB upload completed', 'Refreshing this till after upload...');
            } else if (hasBusinessData(remoteCounts)) {
                setSetupProgress(
                    'running',
                    50,
                    'Downloading MariaDB data to this till',
                    `Found ${remoteCounts.products.toLocaleString()} products and ${remoteCounts.categories.toLocaleString()} categories on MariaDB.`
                );
                await wipeAndPullFromServer();
                setSetupProgress('running', 82, 'Downloaded data', 'Refreshing this till with the downloaded shop data...');
            } else if (hasRecoverableLocalData(localCounts)) {
                setSetupProgress(
                    'running',
                    50,
                    'Uploading restored till data to MariaDB',
                    `Uploading ${localCounts.products.toLocaleString()} products and ${localCounts.categories.toLocaleString()} categories from this till.`
                );
                await migrateLocalDataToServer();
                setSetupProgress('running', 82, 'Uploaded data', 'Refreshing this till after upload...');
            } else {
                setSetupProgress('running', 65, 'Preparing empty shop', 'No existing shop data was found yet.');
                await hydrateSvelteStores();
            }

            setSetupProgress('running', 90, 'Saving connection', 'Finishing this till setup...');
            await saveMode('multi', cfg);
            connectionState.update((state) => ({ ...state, mysqlOnline: true, syncError: null }));
            const finalServer = await getMysqlDb();
            if (!finalServer) throw new Error('MariaDB disconnected while finishing setup.');
            const admins: any[] = await finalServer.select(
                `SELECT id FROM employees WHERE role = 'admin' AND isActive = 1 LIMIT 1`
            );
            const shopSettings: any[] = await finalServer.select(
                "SELECT `key` FROM settings WHERE `key` = 'store_info' LIMIT 1"
            );

            if (admins.length > 0) {
                setSetupProgress('success', 100, 'Setup complete', 'This till is connected and ready.');
                clearRestoreNotice();
                goto('/');
                return;
            }

            needsShopDetails = shopSettings.length === 0;
            needsAdmin = true;
            testResult = 'pass';
            setSetupProgress('success', 100, 'Database connected', 'No active administrator exists, so create the first administrator.');
            connecting = false;
        } catch (err) {
            const message = cleanError(err);
            if (restoreNotice?.type === 'success') {
                restoreNotice = {
                    type: 'error',
                    message: 'The database was restored, but MariaDB connection did not finish.',
                    details: message,
                };
                try {
                    sessionStorage.setItem(RESTORE_NOTICE_KEY, JSON.stringify(restoreNotice));
                } catch {
                    // The visible message above is enough if storage is blocked.
                }
            }
            testResult = 'fail';
            setSetupProgress('error', 100, 'Connection failed', message);
            connectionState.set({ mode: null, mysqlConfig: null, mysqlOnline: false, syncError: message });
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
                clearRestoreNotice();
                goto('/');
                return;
            }
            needsAdmin = true;
            connecting = false;
        } catch (err) {
            testResult = 'fail';
            testMessage = `Error: ${cleanError(err)}`;
            connecting = false;
        }
    }

    async function handleCreateAdmin() {
        connecting = true;
        try {
            await createShopAdmin();
            await hydrateSvelteStores();
            clearRestoreNotice();
            goto('/');
        } catch (err) {
            testResult = 'fail';
            testMessage = `Error: ${cleanError(err)}`;
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
        {#if restoreNotice}
            <div class="w-full rounded-lg border p-4 text-sm {restoreNotice.type === 'error' ? 'border-danger bg-danger/10 text-danger' : 'border-success bg-success/10 text-success'}">
                <div class="flex items-start justify-between gap-4">
                    <div class="min-w-0">
                        <strong class="block text-base">{restoreNotice.type === 'error' ? 'Restore needs attention' : 'Restore completed'}</strong>
                        <p class="mt-1 break-words">{restoreNotice.message}</p>
                        {#if restoreNotice.details}
                            <p class="mt-2 break-all rounded-md border border-current/25 bg-bg-panel/60 p-3 text-xs text-text-main">{restoreNotice.details}</p>
                        {/if}
                    </div>
                    <button class="btn btn-secondary shrink-0" type="button" on:click={clearRestoreNotice}>Dismiss</button>
                </div>
            </div>
        {/if}

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

                {#if setupProgressState !== 'idle'}
                    <div
                        class="setup-progress-panel"
                        class:setup-progress-success={setupProgressState === 'success'}
                        class:setup-progress-error={setupProgressState === 'error'}
                    >
                        <div class="setup-progress-head">
                            <div>
                                <strong>{setupProgressTitle}</strong>
                                {#if setupProgressDetail}
                                    <p>{setupProgressDetail}</p>
                                {/if}
                            </div>
                            <b>{setupProgress}%</b>
                        </div>
                        <div class="setup-progress-track" aria-label="Database setup progress">
                            <span style={`width: ${setupProgress}%`}></span>
                        </div>
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
    .setup-progress-panel {
        display: grid;
        gap: .7rem;
        padding: .9rem 1rem;
        border: 1px solid var(--accent-primary);
        border-radius: .65rem;
        background: var(--bg-card);
    }
    .setup-progress-panel.setup-progress-success { border-color: var(--success); }
    .setup-progress-panel.setup-progress-error { border-color: var(--danger); }
    .setup-progress-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
    }
    .setup-progress-head strong { color: var(--text-main); }
    .setup-progress-head p {
        margin: .25rem 0 0;
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }
    .setup-progress-head b { color: var(--text-main); }
    .setup-progress-track {
        height: .65rem;
        overflow: hidden;
        border-radius: 999px;
        background: var(--border-flat);
    }
    .setup-progress-track span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--accent-primary);
        transition: width .25s ease;
    }
    .setup-progress-success .setup-progress-track span { background: var(--success); }
    .setup-progress-error .setup-progress-track span { background: var(--danger); }
</style>

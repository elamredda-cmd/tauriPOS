<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { loadDojoConfig, type DojoConfig } from '$lib/dojo';
    import { loadSumupConfig, type SumupConfig } from '$lib/sumup';

    let sumupConfig: SumupConfig | null = null;
    let dojoConfig: DojoConfig | null = null;
    let providersLoading = true;

    onMount(async () => {
        const [sumup, dojo] = await Promise.allSettled([loadSumupConfig(), loadDojoConfig()]);
        if (sumup.status === 'fulfilled') sumupConfig = sumup.value;
        else console.warn('Could not load the SumUp provider status:', sumup.reason);
        if (dojo.status === 'fulfilled') dojoConfig = dojo.value;
        else console.warn('Could not load the Dojo provider status:', dojo.reason);
        providersLoading = false;
    });

    $: sumupStatus = providersLoading
        ? 'Checking setup'
        : sumupConfig?.enabled && sumupConfig.ready
            ? 'Enabled on this till'
            : sumupConfig?.ready
                ? 'Configured, currently disabled'
                : 'Setup required';
    $: dojoStatus = providersLoading
        ? 'Checking setup'
        : dojoConfig?.enabled && dojoConfig.ready
            ? 'Enabled on this till'
            : dojoConfig?.ready
                ? 'Configured, currently disabled'
                : 'Setup required';
</script>

<MgmtPage title="Card Payments" backFallback="/settings">
    <div class="settings-page-shell payment-providers-shell">
        <section class="settings-hero">
            <p class="settings-hero-kicker !text-success">Payment terminals</p>
            <h2 class="settings-hero-title">Choose a card provider</h2>
            <p class="settings-hero-copy">
                Each terminal company has its own connection and credentials. Provider settings are stored separately on this till.
            </p>
        </section>

        <section class="provider-section" aria-labelledby="payment-provider-title">
            <div class="provider-heading">
                <div>
                    <h3 id="payment-provider-title">Available providers</h3>
                    <p>Open a provider to configure, test, or disable its terminal connection.</p>
                </div>
                <span>2 providers</span>
            </div>

            <div class="provider-grid">
                <a class="provider-tile" href="/settings/payments/sumup" aria-label={`Open SumUp settings. ${sumupStatus}`}>
                    <span class="provider-accent" aria-hidden="true"></span>
                    <span class="provider-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="5" y="2.5" width="14" height="19" rx="2.5"></rect>
                            <path d="M8 6.5h8"></path>
                            <path d="M8 10.5h8"></path>
                            <path d="M9 17h6"></path>
                            <path d="M12 14v.01"></path>
                        </svg>
                    </span>
                    <span class="provider-copy">
                        <span class="provider-type">Card terminal</span>
                        <strong>SumUp</strong>
                        <small>Configure the supported Solo Cloud API connection.</small>
                    </span>
                    <span class:provider-enabled={sumupConfig?.enabled && sumupConfig?.ready} class="provider-status">
                        <i aria-hidden="true"></i>
                        {sumupStatus}
                    </span>
                    <span class="provider-arrow" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m9 18 6-6-6-6"></path>
                        </svg>
                    </span>
                </a>
                <a class="provider-tile provider-tile-dojo" href="/settings/payments/dojo" aria-label={`Open Dojo settings. ${dojoStatus}`}>
                    <span class="provider-accent" aria-hidden="true"></span>
                    <span class="provider-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="5" y="2.5" width="14" height="19" rx="2.5"></rect>
                            <path d="M8 7h8"></path>
                            <path d="M8 11h8"></path>
                            <path d="M9 17.5h6"></path>
                            <path d="m10.2 14 1.3 1.3 2.6-2.6"></path>
                        </svg>
                    </span>
                    <span class="provider-copy">
                        <span class="provider-type">Pay at Counter</span>
                        <strong>Dojo</strong>
                        <small>Connect an approved Dojo terminal through the official API.</small>
                    </span>
                    <span class:provider-enabled={dojoConfig?.enabled && dojoConfig?.ready} class="provider-status">
                        <i aria-hidden="true"></i>
                        {dojoStatus}
                    </span>
                    <span class="provider-arrow" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m9 18 6-6-6-6"></path>
                        </svg>
                    </span>
                </a>
            </div>
        </section>
    </div>
</MgmtPage>

<style>
    .payment-providers-shell {
        min-height: 100%;
    }

    .provider-section {
        padding: 1.25rem;
        border: 1px solid var(--border-flat);
        border-radius: .5rem;
        background: var(--bg-card);
    }

    .provider-heading {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
    }

    .provider-heading h3 {
        margin: 0;
        color: var(--text-main);
        font-size: 1.12rem;
        line-height: 1.2;
    }

    .provider-heading p {
        margin: .35rem 0 0;
        color: var(--text-muted);
        font-size: .85rem;
    }

    .provider-heading > span {
        flex: 0 0 auto;
        padding: .35rem .55rem;
        border-radius: .25rem;
        background: var(--bg-panel);
        color: var(--text-muted);
        font-size: .72rem;
        font-weight: 850;
        text-transform: uppercase;
    }

    .provider-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(220px, 1fr));
        gap: .75rem;
    }

    .provider-tile {
        position: relative;
        min-height: 148px;
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr) 24px;
        grid-template-rows: minmax(0, 1fr) auto;
        column-gap: .85rem;
        row-gap: .75rem;
        overflow: hidden;
        padding: 1rem;
        border: 1px solid var(--border-flat);
        border-radius: .45rem;
        background: var(--bg-panel);
        color: var(--text-main);
        text-decoration: none;
        transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
    }

    .provider-tile:hover,
    .provider-tile:focus-visible {
        border-color: var(--success);
        background: var(--bg-card-hover);
        transform: translateY(-1px);
        outline: none;
    }

    .provider-accent {
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        background: var(--success);
    }

    .provider-icon {
        width: 48px;
        height: 48px;
        display: grid;
        place-items: center;
        align-self: start;
        border-radius: .4rem;
        background: color-mix(in srgb, var(--success) 14%, var(--bg-card));
        color: var(--success);
    }

    .provider-icon svg {
        width: 28px;
        height: 28px;
    }

    .provider-copy {
        min-width: 0;
        display: block;
    }

    .provider-type {
        display: block;
        color: var(--success);
        font-size: .67rem;
        font-weight: 900;
        text-transform: uppercase;
    }

    .provider-copy strong {
        display: block;
        margin-top: .15rem;
        font-size: 1.2rem;
        line-height: 1.2;
    }

    .provider-copy small {
        display: block;
        margin-top: .35rem;
        color: var(--text-muted);
        font-size: .78rem;
        line-height: 1.35;
    }

    .provider-status {
        grid-column: 1 / 3;
        display: inline-flex;
        align-items: center;
        gap: .45rem;
        color: var(--text-muted);
        font-size: .75rem;
        font-weight: 800;
    }

    .provider-status i {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--text-muted);
    }

    .provider-status.provider-enabled {
        color: var(--success);
    }

    .provider-status.provider-enabled i {
        background: var(--success);
    }

    .provider-arrow {
        grid-column: 3;
        grid-row: 1 / 3;
        width: 24px;
        height: 24px;
        display: grid;
        place-items: center;
        align-self: center;
        color: var(--text-muted);
    }

    .provider-arrow svg {
        width: 20px;
        height: 20px;
    }

    .provider-tile:hover .provider-arrow,
    .provider-tile:focus-visible .provider-arrow {
        color: var(--success);
    }

    @media (max-width: 1000px) {
        .provider-grid {
            grid-template-columns: repeat(2, minmax(220px, 1fr));
        }
    }

    @media (max-width: 620px) {
        .provider-grid {
            grid-template-columns: minmax(0, 1fr);
        }

        .provider-heading {
            align-items: center;
        }
    }
</style>

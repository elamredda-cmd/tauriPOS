<script lang="ts">
    import PageBackButton from '$lib/components/PageBackButton.svelte';

    type StudioIcon = 'tiles' | 'scale' | 'layout' | 'label';
    type StudioTool = {
        href: string;
        eyebrow: string;
        title: string;
        description: string;
        accent: string;
        icon: StudioIcon;
    };

    const tools: StudioTool[] = [
        {
            href: '/tiles',
            eyebrow: 'Checkout',
            title: 'POS Tiles',
            description: 'Arrange the product shortcuts shown on the main checkout screen.',
            accent: '#3b82f6',
            icon: 'tiles',
        },
        {
            href: '/design/scale',
            eyebrow: 'Weighed goods',
            title: 'Scale Tiles',
            description: 'Choose and arrange the weighable products cashiers can select.',
            accent: '#10b981',
            icon: 'scale',
        },
        {
            href: '/settings/layout',
            eyebrow: 'Controls',
            title: 'Button Layout',
            description: 'Change the order of checkout and toolbar action buttons.',
            accent: '#f59e0b',
            icon: 'layout',
        },
        {
            href: '/settings/labels',
            eyebrow: 'Printing',
            title: 'Label Designer',
            description: 'Create barcode, price, and shelf labels for products.',
            accent: '#a855f7',
            icon: 'label',
        },
    ];
</script>

<svelte:head>
    <title>Design Studio - L&amp;Bj POS</title>
</svelte:head>

<div class="studio-shell">
    <header class="studio-header">
        <PageBackButton fallback="/admin" />
        <div class="studio-heading">
            <span class="studio-kicker">L&amp;Bj POS</span>
            <h1>Design Studio</h1>
            <p>Configure the checkout screens and controls used on every till.</p>
        </div>
    </header>

    <main class="studio-main">
        <nav class="studio-grid" aria-label="Design Studio tools">
            {#each tools as tool}
                <a href={tool.href} class="studio-tile" style="--tool-accent: {tool.accent}">
                    <span class="studio-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            {#if tool.icon === 'tiles'}
                                <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                                <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                                <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                                <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                            {:else if tool.icon === 'scale'}
                                <path d="M5 20h14"></path>
                                <path d="M7 20l1-10h8l1 10"></path>
                                <path d="M9 10a3 3 0 0 1 6 0"></path>
                                <path d="M12 7v3l2 1"></path>
                            {:else if tool.icon === 'layout'}
                                <path d="M4 6h16"></path>
                                <path d="M4 12h16"></path>
                                <path d="M4 18h16"></path>
                                <circle cx="8" cy="6" r="2"></circle>
                                <circle cx="15" cy="12" r="2"></circle>
                                <circle cx="11" cy="18" r="2"></circle>
                            {:else}
                                <path d="M5 4h12l2 2v14H5z"></path>
                                <path d="M9 4v5h6V4"></path>
                                <path d="M8 14h8"></path>
                                <path d="M8 17h5"></path>
                            {/if}
                        </svg>
                    </span>
                    <span class="studio-copy">
                        <span class="studio-eyebrow">{tool.eyebrow}</span>
                        <strong>{tool.title}</strong>
                        <span>{tool.description}</span>
                    </span>
                    <svg class="studio-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M5 12h14"></path>
                        <path d="m13 6 6 6-6 6"></path>
                    </svg>
                </a>
            {/each}
        </nav>

        <div class="studio-sync-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 7h-5V2"></path>
                <path d="M4 17h5v5"></path>
                <path d="M5.5 9a7 7 0 0 1 11.7-3L20 7"></path>
                <path d="M18.5 15a7 7 0 0 1-11.7 3L4 17"></path>
            </svg>
            <span><strong>Shared shop design</strong> Layout changes synchronise with your other tills.</span>
        </div>
    </main>
</div>

<style>
    .studio-shell {
        width: 100vw;
        height: 100vh;
        padding: var(--app-page-gutter, 1.5rem);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
        color: var(--text-main);
        background: var(--bg-base);
        font-size: var(--font-size-management);
    }

    .studio-header {
        min-height: 58px;
        display: flex;
        align-items: center;
        gap: 1rem;
        flex: 0 0 auto;
    }

    .studio-heading {
        min-width: 0;
    }

    .studio-heading h1 {
        margin: 0.08rem 0 0.18rem;
        font-size: 2rem;
        line-height: 1;
        letter-spacing: 0;
    }

    .studio-heading p {
        margin: 0;
        color: var(--text-muted);
        font-size: 0.86rem;
    }

    .studio-kicker,
    .studio-eyebrow {
        color: var(--accent-primary);
        font-size: 0.68rem;
        font-weight: 900;
        letter-spacing: 0.12em;
        text-transform: uppercase;
    }

    .studio-main {
        width: min(1100px, 100%);
        flex: 1;
        min-height: 0;
        margin: 0 auto;
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        gap: 0.65rem;
    }

    .studio-grid {
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-template-rows: repeat(2, minmax(0, 1fr));
        gap: 0.65rem;
    }

    .studio-tile {
        position: relative;
        min-width: 0;
        min-height: 0;
        padding: clamp(1rem, 2vw, 1.45rem);
        overflow: hidden;
        display: grid;
        grid-template-columns: 58px minmax(0, 1fr) 28px;
        align-items: center;
        gap: 1rem;
        border: 1px solid var(--border-flat);
        border-left: 5px solid var(--tool-accent);
        border-radius: 0.5rem;
        background: var(--bg-card);
        color: var(--text-main);
        text-decoration: none;
    }

    .studio-tile:hover,
    .studio-tile:focus-visible {
        border-color: var(--tool-accent);
        outline: none;
        background: var(--bg-card-hover);
    }

    .studio-icon {
        width: 58px;
        height: 58px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-panel);
        color: var(--tool-accent);
    }

    .studio-icon svg {
        width: 31px;
        height: 31px;
    }

    .studio-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .studio-copy strong {
        font-size: 1.3rem;
        line-height: 1.1;
        letter-spacing: 0;
    }

    .studio-copy > span:last-child {
        color: var(--text-muted);
        font-size: 0.84rem;
        line-height: 1.35;
    }

    .studio-arrow {
        width: 24px;
        height: 24px;
        color: var(--text-muted);
    }

    .studio-sync-note {
        min-height: 52px;
        padding: 0.65rem 0.85rem;
        display: flex;
        align-items: center;
        gap: 0.7rem;
        border-top: 1px solid var(--border-flat);
        color: var(--text-muted);
        font-size: 0.82rem;
    }

    .studio-sync-note svg {
        width: 22px;
        height: 22px;
        flex: 0 0 auto;
        color: var(--success);
    }

    .studio-sync-note strong {
        color: var(--text-main);
    }

    @media (max-width: 720px) {
        .studio-shell {
            overflow-y: auto;
        }

        .studio-main,
        .studio-grid {
            display: flex;
            flex-direction: column;
        }

        .studio-tile {
            min-height: 130px;
        }
    }
</style>

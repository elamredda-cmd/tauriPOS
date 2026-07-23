<script lang="ts">
    import { Grid3X3, ListOrdered, ReceiptText, Scale, Tags } from '@lucide/svelte';
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';

    type StudioTool = {
        href: string;
        eyebrow: string;
        title: string;
        description: string;
        accent: string;
        icon: typeof Grid3X3;
    };

    const tools: StudioTool[] = [
        {
            href: '/tiles',
            eyebrow: 'Checkout',
            title: 'POS Tiles',
            description: 'Arrange the product shortcuts shown on the main checkout screen.',
            accent: '#3b82f6',
            icon: Grid3X3,
        },
        {
            href: '/design/scale',
            eyebrow: 'Weighed goods',
            title: 'Scale Tiles',
            description: 'Choose and arrange the weighable products cashiers can select.',
            accent: '#10b981',
            icon: Scale,
        },
        {
            href: '/settings/layout',
            eyebrow: 'Controls',
            title: 'Button Layout',
            description: 'Change the order of checkout and toolbar action buttons.',
            accent: '#f59e0b',
            icon: ListOrdered,
        },
        {
            href: '/settings/labels',
            eyebrow: 'Printing',
            title: 'Label Designer',
            description: 'Create barcode, price, and shelf labels for products.',
            accent: '#a855f7',
            icon: Tags,
        },
        {
            href: '/settings/receipt',
            eyebrow: 'Printing',
            title: 'Receipt Designer',
            description: 'Arrange receipt content, paper width, spacing, and footer text.',
            accent: '#d97706',
            icon: ReceiptText,
        },
    ];
</script>

<svelte:head>
    <title>Design Studio - L&amp;Bj POS</title>
</svelte:head>

<div class="studio-shell">
    <AdminPageHeader
        title="Design Studio"
        eyebrow="L&Bj POS"
        description="Configure checkout screens, controls, labels, and receipt layouts."
        backFallback="/admin"
    />

    <main class="studio-main">
        <nav class="studio-grid" aria-label="Design Studio tools">
            {#each tools as tool}
                <a href={tool.href} class="studio-tile" style="--tool-accent: {tool.accent}">
                    <span class="studio-icon" aria-hidden="true">
                        <svelte:component this={tool.icon} size={23} strokeWidth={2.2} />
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
        gap: 0;
        color: var(--text-main);
        background: var(--bg-base);
        font-size: var(--font-size-management);
    }

    .studio-eyebrow {
        color: var(--accent-primary);
        font-size: 0.68rem;
        font-weight: 900;
        letter-spacing: 0.12em;
        text-transform: uppercase;
    }

    .studio-main {
        width: 100%;
        flex: 1;
        min-height: 0;
        margin: 0;
        display: grid;
        grid-template-rows: auto auto;
        align-content: start;
        gap: 0.65rem;
        overflow-y: auto;
    }

    .studio-grid {
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        grid-auto-rows: 122px;
        gap: 0.65rem;
    }

    .studio-tile {
        position: relative;
        min-width: 0;
        min-height: 0;
        padding: 0.8rem;
        overflow: hidden;
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr) 20px;
        align-items: center;
        gap: 0.75rem;
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
        width: 48px;
        height: 48px;
        display: grid;
        place-items: center;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-panel);
        color: var(--tool-accent);
    }

    .studio-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .studio-copy strong {
        font-size: 1.05rem;
        line-height: 1.1;
        letter-spacing: 0;
    }

    .studio-copy > span:last-child {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        color: var(--text-muted);
        font-size: 0.75rem;
        line-height: 1.3;
    }

    .studio-arrow {
        width: 20px;
        height: 20px;
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

    @media (max-width: 920px) {
        .studio-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            grid-auto-rows: 118px;
        }
    }

    @media (max-width: 460px) {
        .studio-grid {
            grid-template-columns: minmax(0, 1fr);
            grid-auto-rows: 112px;
        }
    }
</style>

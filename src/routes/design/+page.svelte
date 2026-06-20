<script lang="ts">
    import { goBack } from '$lib/navigation';
    const tools = [
        {
            href: "/tiles",
            eyebrow: "Checkout",
            title: "POS Tiles",
            description: "Arrange the product shortcuts shown on the main checkout screen.",
            accent: "blue",
            mark: "POS",
        },
        {
            href: "/design/scale",
            eyebrow: "Weighed goods",
            title: "Scale Tiles",
            description: "Choose and arrange the weighable products cashiers can select.",
            accent: "green",
            mark: "kg",
        },
        {
            href: "/settings/layout",
            eyebrow: "Controls",
            title: "Button Layout",
            description: "Change the order of checkout and toolbar action buttons.",
            accent: "amber",
            mark: "UI",
        },
        {
            href: "/settings/labels",
            eyebrow: "Printing",
            title: "Label Designer",
            description: "Create barcode, price, and shelf labels for products.",
            accent: "purple",
            mark: "LBL",
        },
    ];
</script>

<div class="studio-shell">
    <header class="studio-header">
        <button type="button" class="btn-icon" aria-label="Go back" on:click={() => goBack('/')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
        </button>
        <div class="studio-heading">
            <span class="studio-kicker">L&amp;Bj POS</span>
            <h1>Design Studio</h1>
            <p>Keep the screens your cashiers use every day clear, quick, and familiar.</p>
        </div>
    </header>

    <main class="studio-grid">
        {#each tools as tool, index}
            <a href={tool.href} class="studio-card studio-card-{tool.accent} {index === 0 ? 'studio-card-wide' : ''}">
                <div class="studio-card-top">
                    <span class="studio-mark">{tool.mark}</span>
                    <span class="studio-arrow">&rarr;</span>
                </div>
                <div>
                    <span class="studio-eyebrow">{tool.eyebrow}</span>
                    <h2>{tool.title}</h2>
                    <p>{tool.description}</p>
                </div>
            </a>
        {/each}

        <section class="studio-note">
            <strong>Designed for every till</strong>
            <p>Scale Tile choices are saved as a shop setting and synchronize with your other tills.</p>
        </section>
    </main>
</div>

<style>
    .studio-shell {
        min-height: 100vh;
        height: 100vh;
        padding: clamp(1rem, 2vw, 1.75rem);
        overflow-y: auto;
        color: var(--text-main);
        background: var(--bg-base);
    }
    .studio-header { max-width: 1100px; margin: 0 auto 1rem; display: flex; align-items: flex-start; gap: 1rem; }
    .studio-heading { min-width: 0; }
    .studio-header h1 { margin: .15rem 0 .3rem; font-size: clamp(1.7rem, 3.5vw, 2.6rem); line-height: 1; }
    .studio-header p { max-width: 620px; margin: 0; color: var(--text-muted); font-size: .9rem; }
    .studio-kicker, .studio-eyebrow { color: var(--accent-primary); font-size: .72rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
    .studio-grid { max-width: 1100px; margin: 0 auto; padding-bottom: 1rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
    .studio-card { min-height: 150px; padding: 1rem; display: flex; flex-direction: column; justify-content: space-between; color: var(--text-main); text-decoration: none; border: 1px solid var(--border-flat); border-radius: .85rem; background: var(--bg-card); box-shadow: 0 10px 28px var(--shadow); transition: transform .18s ease, border-color .18s ease; }
    .studio-card:hover { transform: translateY(-4px); border-color: var(--accent-primary); }
    .studio-card-wide { grid-column: span 2; min-height: 175px; }
    .studio-card-top { display: flex; align-items: center; justify-content: space-between; }
    .studio-mark { width: 2.7rem; height: 2.7rem; border-radius: .75rem; display: grid; place-items: center; background: var(--bg-panel); color: var(--accent-primary); font-size: .82rem; font-weight: 900; }
    .studio-card-green .studio-mark { color: var(--success); }
    .studio-card-amber .studio-mark { color: var(--warning); }
    .studio-arrow { font-size: 1.35rem; color: var(--text-muted); }
    .studio-card h2 { margin: .2rem 0 .25rem; font-size: 1.25rem; }
    .studio-card p, .studio-note p { color: var(--text-muted); margin: 0; font-size: .82rem; }
    .studio-note { padding: .85rem 1rem; border: 1px dashed var(--border-flat); border-radius: .8rem; background: var(--bg-panel); }
    .studio-note strong { display: block; margin-bottom: .35rem; }
    @media (max-width: 720px) {
        .studio-grid { grid-template-columns: 1fr; }
        .studio-card-wide { grid-column: span 1; }
    }
</style>

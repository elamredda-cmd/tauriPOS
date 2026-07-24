<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { activeTheme, setTheme, type Theme } from '$lib/stores/theme';
    import { upsert } from '$lib/stores/database';
    import { now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';

    const themes: { id: Theme; name: string; color1: string; color2: string; desc: string }[] = [
        { id: 'midnight', name: 'Midnight', color1: '#080f1e', color2: '#3b82f6', desc: 'Classic dark blue, high contrast.' },
        { id: 'forest', name: 'Forest', color1: '#0a1a12', color2: '#10b981', desc: 'Earthy greens, easy on the eyes.' },
        { id: 'snow', name: 'Snow', color1: '#f8fafc', color2: '#3b82f6', desc: 'Bright, clean light theme.' },
        { id: 'linen', name: 'Linen & Walnut', color1: '#f7f5f1', color2: '#76543c', desc: 'Soft warm surfaces with clear walnut accents.' },
        { id: 'coffee', name: 'Coffee', color1: '#1c1917', color2: '#d97706', desc: 'Warm browns and tan accents.' },
        { id: 'sunset', name: 'Sunset', color1: '#1a0b1e', color2: '#f43f5e', desc: 'Deep purple and vibrant rose.' }
    ];

    async function selectTheme(id: Theme) {
        await setTheme(id);
        await upsert('settings', { key: 'active_theme', value: id, updatedAt: now() }, 'key');
        toast(`Applied ${id.charAt(0).toUpperCase() + id.slice(1)} theme`);
    }
</script>

<MgmtPage title="App Appearance" backFallback="/settings">
    <div class="settings-page-shell">
        <section class="settings-hero">
            <p class="settings-hero-kicker">Appearance</p>
            <h2 class="settings-hero-title">Choose the shop theme</h2>
            <p class="settings-hero-copy">
                Themes are saved to settings and sync across tills, so every screen can keep the same look.
            </p>
        </section>

        <section class="settings-card-grid" aria-label="Theme choices">
            {#each themes as theme}
                <button
                    class="theme-card settings-action-card {$activeTheme === theme.id ? 'active' : ''}"
                    on:click={() => selectTheme(theme.id)}
                >
                    <div class="theme-preview" style="background: {theme.color1}">
                        <div class="preview-header"></div>
                        <div class="preview-content">
                            <div class="preview-item" style="background: {theme.color2}"></div>
                            <div class="preview-item"></div>
                            <div class="preview-item"></div>
                        </div>
                    </div>
                    <div class="theme-info">
                        <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Theme</span>
                        <h3>{theme.name}</h3>
                        <p>{theme.desc}</p>
                    </div>
                    {#if $activeTheme === theme.id}
                        <div class="active-badge">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        </div>
                    {/if}
                </button>
            {/each}
        </section>
    </div>
</MgmtPage>

<style>
    .theme-card {
        position: relative;
        display: flex;
        flex-direction: column;
        padding: 0;
        overflow: hidden;
        text-align: left;
        cursor: pointer;
        min-height: 310px;
        transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
    }

    .theme-card:hover {
        transform: translateY(-4px);
    }

    .theme-card.active {
        border-color: var(--accent-primary);
        box-shadow: 0 0 0 2px var(--accent-primary), 0 18px 45px var(--shadow);
    }

    .theme-preview {
        height: 160px;
        width: 100%;
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid var(--border-flat);
        border-radius: .9rem .9rem 0 0;
        overflow: hidden;
    }

    .preview-header {
        height: 30px;
        width: 100%;
        background: rgba(255, 255, 255, .08);
    }

    .preview-content {
        padding: 16px;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        flex: 1;
    }

    .preview-item {
        background: rgba(255,255,255,0.1);
        border-radius: 10px;
    }

    .theme-info {
        padding: 20px;
    }

    .theme-info h3 {
        margin: 6px 0 8px 0;
        font-size: 1.2rem;
        color: var(--text-main);
    }

    .theme-info p {
        margin: 0;
        font-size: 0.9rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .active-badge {
        position: absolute;
        top: 12px;
        right: 12px;
        background: var(--accent-primary);
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
    }
</style>

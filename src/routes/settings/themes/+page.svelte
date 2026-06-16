<script lang="ts">
    import { goBack } from '$lib/navigation';
    import { activeTheme, setTheme, type Theme } from '$lib/stores/theme';
    import { upsert } from '$lib/stores/database';
    import { now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';

    const themes: { id: Theme; name: string; color1: string; color2: string; desc: string }[] = [
        { id: 'midnight', name: 'Midnight', color1: '#080f1e', color2: '#3b82f6', desc: 'Classic dark blue, high contrast.' },
        { id: 'forest', name: 'Forest', color1: '#0a1a12', color2: '#10b981', desc: 'Earthy greens, easy on the eyes.' },
        { id: 'snow', name: 'Snow', color1: '#f8fafc', color2: '#3b82f6', desc: 'Bright, clean light theme.' },
        { id: 'coffee', name: 'Coffee', color1: '#1c1917', color2: '#d97706', desc: 'Warm browns and tan accents.' },
        { id: 'sunset', name: 'Sunset', color1: '#1a0b1e', color2: '#f43f5e', desc: 'Deep purple and vibrant rose.' }
    ];

    async function selectTheme(id: Theme) {
        await setTheme(id);
        await upsert('settings', { key: 'active_theme', value: id, updatedAt: now() }, 'key');
        toast(`Applied ${id.charAt(0).toUpperCase() + id.slice(1)} theme`);
    }
</script>

<div class="page-container">
    <header class="page-header">
        <div class="header-left">
            <button type="button" class="btn-icon" aria-label="Go back" on:click={() => goBack('/settings')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20">
                    <line x1="19" y1="12" x2="5" y2="12"></line>
                    <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
            </button>
            <h1>App Appearance</h1>
        </div>
    </header>

    <div class="themes-grid">
        {#each themes as theme}
            <button 
                class="theme-card flat-card { $activeTheme === theme.id ? 'active' : '' }"
                on:click={() => selectTheme(theme.id)}
            >
                <div class="theme-preview" style="background: {theme.color1}">
                    <div class="preview-header bg-white/5"></div>
                    <div class="preview-content">
                        <div class="preview-item" style="background: {theme.color2}"></div>
                        <div class="preview-item"></div>
                        <div class="preview-item"></div>
                    </div>
                </div>
                <div class="theme-info">
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
    </div>
</div>

<style>
    .page-container {
        padding: 40px;
        max-width: 1200px;
        margin: 0 auto;
    }

    .page-header {
        margin-bottom: 40px;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 20px;
    }

    .header-left h1 {
        font-size: 2.5rem;
        margin: 0;
    }

    .themes-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 24px;
    }

    .theme-card {
        position: relative;
        display: flex;
        flex-direction: column;
        padding: 0;
        overflow: hidden;
        text-align: left;
        cursor: pointer;
        transition: transform 0.2s, border-color 0.2s;
    }

    .theme-card:hover {
        transform: translateY(-4px);
    }

    .theme-card.active {
        border-color: var(--accent-primary);
        box-shadow: 0 0 0 2px var(--accent-primary);
    }

    .theme-preview {
        height: 160px;
        width: 100%;
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid var(--border-flat);
    }

    .preview-header {
        height: 30px;
        width: 100%;
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
        border-radius: 4px;
    }

    .theme-info {
        padding: 20px;
    }

    .theme-info h3 {
        margin: 0 0 8px 0;
        font-size: 1.2rem;
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

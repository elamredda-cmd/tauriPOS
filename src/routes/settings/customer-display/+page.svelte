<script lang="ts">
    import { onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import { Monitor, ImagePlus, Type, ArrowUp, ArrowDown, Trash2, Save, RefreshCw, Play, X } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomerDisplayPlayer from '$lib/components/CustomerDisplayPlayer.svelte';
    import DisplayMediaThumbnail from '$lib/components/DisplayMediaThumbnail.svelte';
    import { toast } from '$lib/stores/toast';
    import { closeCustomerDisplay, getCustomerDisplayAutoOpen, getDisplayMonitors, getSavedCustomerDisplayMonitor,
        openCustomerDisplay, saveCustomerDisplayAutoOpen, saveCustomerDisplayMonitor, type DisplayMonitor } from '$lib/customerDisplay';
    import { displayFonts, loadDisplayContent, normalizeDisplayContent, saveDisplayContent, importDisplayMedia,
        removeDisplayMedia, validateDisplayMedia, type DisplaySlide } from '$lib/customerDisplayContent';

    let content = loadDisplayContent();
    let saved = JSON.stringify(content);
    let previouslySaved = content.slides;
    let imported = new Set<string>();
    let native = false;
    let monitors: DisplayMonitor[] = [];
    let monitorIndex = 1;
    let autoOpen = true;
    let busy = '';
    let screenError = '';
    let mediaErrors: string[] = [];
    let fileInput: HTMLInputElement;
    let aspect = '16/9';
    let previewKey = 0;
    $: dirty = JSON.stringify(content) !== saved;
    $: previewContent = normalizeDisplayContent(content);

    onMount(() => {
        native = isTauri();
        autoOpen = getCustomerDisplayAutoOpen();
        monitorIndex = getSavedCustomerDisplayMonitor();
        void refreshScreens();
    });
    async function refreshScreens() {
        screenError = '';
        try {
            monitors = await getDisplayMonitors();
            if (!monitors[monitorIndex]) monitorIndex = monitors.length > 1 ? 1 : 0;
        } catch (error) { screenError = String(error).replace(/^Error:\s*/, ''); }
    }
    async function operateScreen(action: 'open' | 'close') {
        busy = action;
        screenError = '';
        try {
            if (action === 'open') await openCustomerDisplay(monitorIndex);
            else await closeCustomerDisplay();
            toast(action === 'open' ? 'Customer display opened' : 'Customer display closed');
        } catch (error) { screenError = String(error).replace(/^Error:\s*/, ''); }
        finally { busy = ''; }
    }
    function toggleAutoOpen() {
        autoOpen = !autoOpen;
        saveCustomerDisplayAutoOpen(autoOpen);
    }
    async function addMedia(files?: FileList | null) {
        if (!native && !files) { fileInput.click(); return; }
        busy = 'import';
        mediaErrors = [];
        try {
            const result = await importDisplayMedia(files || undefined);
            mediaErrors = result.errors;
            const slides = [...content.slides];
            for (const file of result.files) {
                if (slides.some(slide => slide.id === file.id)) continue;
                if (slides.length >= 24) {
                    mediaErrors = [...mediaErrors, `${file.name}: the playlist can contain up to 24 slides.`];
                    if (!previouslySaved.some(s => s.id === file.id)) await removeDisplayMedia(file.id).catch(() => {});
                    continue;
                }
                try {
                    await validateDisplayMedia(file);
                    slides.push(file);
                    imported.add(file.id);
                } catch (error) {
                    mediaErrors = [...mediaErrors, `${file.name}: ${String(error).replace(/^Error:\s*/, '')}`];
                    if (!previouslySaved.some(s => s.id === file.id)) await removeDisplayMedia(file.id).catch(() => {});
                }
            }
            content = { ...content, mode: 'playlist', slides };
        } catch (error) { mediaErrors = [...mediaErrors, String(error).replace(/^Error:\s*/, '')]; }
        finally { busy = ''; if (fileInput) fileInput.value = ''; }
    }
    function addText() {
        content = { ...content, mode: 'playlist', slides: [...content.slides, { id: crypto.randomUUID(), kind: 'text', name: 'Text slide',
            heading: 'Your message here', body: 'Tell your customers what is new.', duration: 6 }] };
    }
    function move(index: number, offset: number) {
        const slides = [...content.slides];
        [slides[index], slides[index + offset]] = [slides[index + offset], slides[index]];
        content = { ...content, slides };
    }
    function remove(id: string) { content = { ...content, slides: content.slides.filter(s => s.id !== id) }; }
    async function save() {
        busy = 'save';
        try {
            const oldMedia = new Set([...previouslySaved.filter(s => s.kind !== 'text').map(s => s.id), ...imported]);
            content = await saveDisplayContent(content);
            saved = JSON.stringify(content);
            previouslySaved = content.slides;
            imported.clear();
            for (const id of oldMedia) if (!content.slides.some(s => s.id === id)) await removeDisplayMedia(id).catch(() => {});
            toast('Customer display saved');
        } catch (error) { toast(`Could not save: ${String(error)}`, 'error'); }
        finally { busy = ''; }
    }
</script>

<MgmtPage title="Customer display" backFallback="/settings">
    <div slot="actions" class="display-actions">
        <button class="btn btn-secondary" disabled={!native || !!busy} on:click={() => operateScreen('close')}><X size={16} />Close display</button>
        <button class="btn btn-secondary" disabled={!native || !!busy || !monitors.length} on:click={() => operateScreen('open')}><Monitor size={16} />Open display</button>
        <button class="btn btn-primary" disabled={!!busy || !dirty} on:click={save}><Save size={16} />{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
    </div>
    <div class="display-settings">
        <div class="editor">
            <section class="display-card">
                <div class="section-heading"><span class="section-icon"><Monitor size={22} /></span><div><h2>Customer screen</h2><p>Choose where your customers see their shopping.</p></div></div>
                {#if !native}<p class="notice">Browser preview · Try the content editor here. Open the desktop app to send it to a second screen. Browser media is stored separately from the installed till.</p>{/if}
                {#if screenError}<p class="error" role="alert">{screenError}</p>{/if}
                {#if native}
                    <div class="screen-selector"><label for="display-screen">Display</label><div><select id="display-screen" bind:value={monitorIndex} on:change={() => saveCustomerDisplayMonitor(monitorIndex)} disabled={!!busy || !monitors.length}>
                        {#each monitors as monitor}<option value={monitor.index}>Screen {monitor.index + 1} · {monitor.name} · {monitor.width} × {monitor.height}</option>{/each}
                    </select><button class="icon-button" aria-label="Refresh screens" on:click={refreshScreens}><RefreshCw size={18} /></button></div></div>
                    {#if !monitors.length}<p class="notice">No screen detected. Connect the screen, then refresh.</p>{/if}
                    {#if monitors.length === 1}<p class="notice">Only one screen is connected. Open display will use that screen; you can use the preview here to edit your content.</p>{/if}
                    <label class="check-row"><input type="checkbox" checked={autoOpen} on:change={toggleAutoOpen} /><span><strong>Open automatically on the second screen</strong><small>Screen preferences save immediately on this till.</small></span></label>
                {/if}
            </section>

            <section class="display-card">
                <div class="section-heading"><span class="section-icon"><ImagePlus size={22} /></span><div><h2>Playlist</h2><p>Pictures, videos and messages, shown one by one.</p></div></div>
                <div class="mode-switch" aria-label="Display mode">
                    <button class:active={content.mode === 'playlist'} aria-pressed={content.mode === 'playlist'} on:click={() => content.mode = 'playlist'}>Pictures & slides</button>
                    <button class:active={content.mode === 'text'} aria-pressed={content.mode === 'text'} on:click={() => content.mode = 'text'}>Text only</button>
                </div>
                {#if content.mode === 'playlist'}
                    <input class="file-input" bind:this={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4" on:change={e => addMedia(e.currentTarget.files)} aria-label="Choose display media" />
                    <div class="add-actions"><button class="btn btn-secondary" disabled={!!busy || content.slides.length >= 24} on:click={() => addMedia()}><ImagePlus size={17} />{busy === 'import' ? 'Checking files…' : 'Add pictures / videos'}</button><button class="btn btn-secondary" disabled={!!busy || content.slides.length >= 24} on:click={addText}><Type size={17} />Add text slide</button><small>{content.slides.length}/24 slides</small></div>
                    <p class="help">JPG, PNG or WebP up to 10 MB. MP4 up to 100 MB and 2 minutes. Videos play silently to the end; use H.264 MP4 for best compatibility.</p>
                    {#if mediaErrors.length}<div class="error" role="alert">{#each mediaErrors as error}<p>{error}</p>{/each}</div>{/if}
                    <div class="playlist">
                        {#each content.slides as slide, index (slide.id)}
                            <article class="slide-card">
                                <div class="slide-top"><DisplayMediaThumbnail {slide} /><div class="slide-info"><strong>{index + 1}. {slide.kind === 'text' ? slide.heading || 'Text slide' : slide.name}</strong><small>{slide.kind === 'video' ? 'Video · plays to the end' : slide.kind === 'text' ? 'Text message' : 'Picture'}</small></div>
                                    <div class="slide-tools"><button class="icon-button" aria-label={`Move slide ${index + 1} up`} disabled={index === 0 || !!busy} on:click={() => move(index, -1)}><ArrowUp size={17} /></button><button class="icon-button" aria-label={`Move slide ${index + 1} down`} disabled={index === content.slides.length - 1 || !!busy} on:click={() => move(index, 1)}><ArrowDown size={17} /></button><button class="icon-button remove" aria-label={`Remove slide ${index + 1}`} disabled={!!busy} on:click={() => remove(slide.id)}><Trash2 size={17} /></button></div>
                                </div>
                                {#if slide.kind === 'text'}<div class="text-slide-fields"><label>Heading<input maxlength="120" bind:value={slide.heading} /></label><label>Message<textarea rows="2" maxlength="500" bind:value={slide.body}></textarea></label></div>{/if}
                                {#if slide.kind !== 'video'}<label class="duration">Show for <input aria-label={`Slide ${index + 1} duration in seconds`} type="number" min="2" max="60" bind:value={slide.duration} /> seconds</label>{/if}
                            </article>
                        {:else}<div class="empty-playlist"><ImagePlus size={28} /><strong>Your first slide starts here</strong><p>Add pictures, a short video, or a text message.<br />Until then, the welcome message below is shown.</p></div>{/each}
                    </div>
                {/if}
                <div class="field-grid playback-fields"><label>Picture fit<select bind:value={content.fit}><option value="contain">Fit whole picture</option><option value="cover">Fill screen (crop edges)</option></select></label><label>Transition<select bind:value={content.transition}><option value="fade">Gentle fade</option><option value="none">Instant</option></select></label></div>
                <label class="check-row"><input type="checkbox" bind:checked={content.duringSale} /><span><strong>Show promotions beside the basket</strong><small>On roomy screens. Payment and totals always take priority.</small></span></label>
            </section>

            <section class="display-card">
                <div class="section-heading"><span class="section-icon"><Type size={22} /></span><div><h2>Welcome message & style</h2><p>Use on its own, over your media, or when media is unavailable.</p></div></div>
                <div class="text-fields"><label>Heading<input maxlength="120" bind:value={content.heading} /></label><label>Message<textarea rows="3" maxlength="500" bind:value={content.body}></textarea></label></div>
                <div class="field-grid"><label>Font<select bind:value={content.font}>{#each displayFonts as font}<option value={font.id}>{font.label}</option>{/each}</select></label><label>Text size<select bind:value={content.size}><option value={32}>Small</option><option value={48}>Medium</option><option value={64}>Large</option><option value={80}>Extra large</option></select></label><label>Alignment<select bind:value={content.align}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label><div class="style-buttons"><button class:active={content.bold} aria-pressed={content.bold} on:click={() => content.bold = !content.bold}><b>Bold</b></button><button class:active={content.italic} aria-pressed={content.italic} on:click={() => content.italic = !content.italic}><i>Italic</i></button></div><label>Text colour<div class="colour-field"><input type="color" bind:value={content.color} /><span>{content.color}</span></div></label><label>Background colour<div class="colour-field"><input type="color" bind:value={content.background} /><span>{content.background}</span></div></label></div>
                <label class="check-row"><input type="checkbox" bind:checked={content.overlay} /><span><strong>Show this message over pictures and videos</strong><small>Text slides use the same font and colours.</small></span></label>
            </section>
        </div>
        <aside class="preview-column">
            <section class="display-card preview-card"><div class="preview-heading"><div><span class="eyebrow">LIVE PREVIEW</span><h2>Your customer’s view</h2></div><button class="icon-button" aria-label="Restart preview" on:click={() => previewKey++}><Play size={18} /></button></div>
                <label class="preview-size">Screen shape<select bind:value={aspect}><option value="16/9">Wide</option><option value="1/1">Square POS</option><option value="3/4">Portrait</option></select></label>
                <div class="preview-frame" style:aspect-ratio={aspect} style:--compact-preview-width={aspect === '16/9' ? '550px' : aspect === '1/1' ? '310px' : '232.5px'}>{#key previewKey}<CustomerDisplayPlayer content={previewContent} />{/key}</div>
                <p class="help">This is the idle screen. During checkout, customers see the live basket, discounts and total. Payment confirmation and change take over after payment.</p>
                <div class="save-status" class:unsaved={dirty}><span></span>{dirty ? 'Unsaved changes · preview only' : 'Saved on this device'}</div>
                <button class="btn btn-primary preview-save" disabled={!!busy || !dirty} on:click={save}><Save size={17} />Save changes</button>
            </section>
        </aside>
    </div>
</MgmtPage>

<style>
    .display-settings { width: 100%; max-width: 1600px; margin: 0 auto; padding: clamp(12px, 2vw, 28px); display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, .8fr); gap: 24px; align-items: start; }
    .editor { min-width: 0; display: grid; gap: 20px; }
    .display-card { min-width: 0; padding: clamp(16px, 2vw, 26px); border: 1px solid var(--border-flat); border-radius: 14px; background: var(--bg-panel); }
    .section-heading, .preview-heading { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; }
    .section-icon { display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 44px; color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 12%, transparent); border-radius: 12px; }
    h2 { margin: 0; font-size: 1.05rem; font-weight: 850; }
    .section-heading p, .help { margin: 6px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.6; }
    .help { margin: 12px 0; }
    .display-actions, .add-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .add-actions small { margin-left: auto; color: var(--text-muted); }
    .btn { display: inline-flex; gap: 8px; align-items: center; justify-content: center; }
    label { display: flex; flex-direction: column; gap: 8px; font-size: .8rem; font-weight: 700; min-width: 0; }
    input:not([type="checkbox"]), select, textarea { width: 100%; min-width: 0; border: 1px solid var(--border-flat); border-radius: 7px; padding: 10px 12px; background: var(--bg-card); color: var(--text-main); font: inherit; }
    textarea { resize: vertical; }
    select { text-overflow: ellipsis; }
    button { cursor: pointer; }
    button:disabled { opacity: .45; cursor: default; }
    .icon-button { flex: 0 0 auto; min-width: 44px; min-height: 44px; border: 1px solid var(--border-flat); border-radius: 7px; display: grid; place-items: center; background: var(--bg-card); color: var(--text-muted); }
    .icon-button:hover:not(:disabled) { color: var(--accent-primary); border-color: var(--accent-primary); }
    .icon-button.remove:hover:not(:disabled) { color: var(--danger); }
    .screen-selector > div { display: flex; min-width: 0; gap: 8px; margin-top: 8px; }
    .check-row { flex-direction: row; align-items: center; gap: 12px; margin: 18px 0 0; cursor: pointer; }
    .check-row input { appearance: auto; width: 20px; height: 20px; min-height: 20px; flex: 0 0 20px; accent-color: var(--accent-primary); }
    .check-row span { min-width: 0; }
    .check-row strong, .check-row small { display: block; }
    .check-row small { color: var(--text-muted); margin-top: 4px; font-size: .75rem; font-weight: 400; line-height: 1.5; }
    .mode-switch { display: flex; padding: 4px; border-radius: 9px; background: var(--bg-root); margin-bottom: 18px; border: 1px solid var(--border-flat); gap: 4px; }
    .mode-switch button { flex: 1; min-height: 42px; padding: 8px; background: transparent; color: var(--text-muted); border: 1px solid transparent; border-radius: 6px; font-weight: 750; }
    .mode-switch button.active, .style-buttons button.active { color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-flat)); }
    .file-input { display: none; }
    .playlist { display: grid; gap: 10px; }
    .slide-card { min-width: 0; border: 1px solid var(--border-flat); border-radius: 10px; padding: 12px; background: var(--bg-card); }
    .slide-top { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; }
    .slide-info { flex: 1; min-width: 80px; }
    .slide-info strong { display: block; font-size: .82rem; overflow-wrap: anywhere; }
    .slide-info small { display: block; color: var(--text-muted); margin-top: 5px; font-size: .72rem; }
    .slide-tools { display: flex; gap: 5px; margin-left: auto; }
    .duration { margin-top: 10px; flex-direction: row; align-items: center; justify-content: flex-end; color: var(--text-muted); font-weight: 500; }
    .duration input { width: 70px; padding: 7px; text-align: center; }
    .empty-playlist { min-height: 180px; display: grid; place-content: center; justify-items: center; gap: 10px; border: 1px dashed var(--border-flat); border-radius: 10px; text-align: center; padding: 20px; color: var(--text-muted); }
    .empty-playlist strong { color: var(--text-main); font-size: .9rem; }
    .empty-playlist p { margin: 0; font-size: .78rem; line-height: 1.6; }
    .field-grid { margin-top: 16px; display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; }
    .text-fields, .text-slide-fields { display: grid; gap: 12px; }
    .text-slide-fields { margin-top: 12px; }
    .style-buttons { display: flex; gap: 8px; align-self: end; }
    .style-buttons button { flex: 1; min-height: 42px; border: 1px solid var(--border-flat); border-radius: 7px; color: var(--text-main); background: var(--bg-card); }
    .colour-field { display: flex; min-width: 0; align-items: center; gap: 10px; font-variant-numeric: tabular-nums; font-size: .78rem; }
    .colour-field input { width: 48px; height: 42px; padding: 4px; cursor: pointer; }
    .notice, .error { padding: 12px; border-radius: 8px; font-size: .8rem; line-height: 1.6; background: color-mix(in srgb, var(--accent-primary) 9%, var(--bg-card)); }
    .error { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, var(--bg-card)); overflow-wrap: anywhere; }
    .error p { margin: 0; }
    .preview-column { min-width: 0; position: sticky; top: 16px; }
    .preview-heading { justify-content: space-between; }
    .eyebrow { display: block; font-size: .65rem; letter-spacing: .12em; color: var(--accent-primary); font-weight: 850; margin-bottom: 6px; }
    .preview-size { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .preview-size select { width: auto; max-width: 65%; }
    .preview-frame { width: 100%; min-height: 0; overflow: hidden; border: 5px solid #263749; border-radius: 12px; box-shadow: 0 10px 24px #00000018; }
    .save-status { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: .72rem; margin-top: 20px; }
    .save-status > span { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
    .save-status.unsaved > span { background: var(--warning); }
    .preview-save { width: 100%; margin-top: 12px; }
    @container management (max-width: 900px) { .display-settings { grid-template-columns: minmax(0,1fr); } .preview-column { position: static; grid-row: 1; } .preview-frame { margin: 0 auto; max-width: var(--compact-preview-width); } }
    @media (max-width: 600px) { .display-settings { grid-template-columns: minmax(0,1fr); padding: 12px; gap: 12px; } .display-card { padding: 16px; } .preview-column { position: static; grid-row: 1; } .field-grid { gap: 12px; } .section-heading { align-items: flex-start; } }

</style>

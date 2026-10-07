<script lang="ts">
    import { onMount } from 'svelte';
    import { displayFonts, displayMediaUrl, type DisplayContent, type DisplaySlide } from '$lib/customerDisplayContent';
    export let content: DisplayContent;
    let mounted = false;
    let active: DisplaySlide | null = null;
    let url = '';
    let index = -1;
    let generation = 0;
    let slideSerial = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = new Set<string>();
    let loading = false;
    $: font = displayFonts.find(f => f.id === content.font)?.family || displayFonts[0].family;
    $: heading = active?.kind === 'text' ? active.heading : content.heading;
    $: body = active?.kind === 'text' ? active.body : content.body;
    $: if (mounted) reset(content);

    function release() {
        clearTimeout(timer);
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        url = '';
    }
    function schedule(milliseconds: number) {
        clearTimeout(timer);
        timer = setTimeout(() => void advance(), milliseconds);
    }
    function reset(_content: DisplayContent) {
        generation++;
        release();
        failed = new Set();
        active = null;
        index = -1;
        if (content.mode === 'playlist' && content.slides.length) void advance();
    }
    async function advance() {
        const run = ++generation;
        clearTimeout(timer);
        const slides = content.slides;
        loading = true;
        for (let attempt = 0; attempt < slides.length; attempt++) {
            index = (index + 1) % slides.length;
            const slide = slides[index];
            if (failed.has(slide.id)) continue;
            try {
                const nextUrl = slide.kind === 'text' ? '' : await displayMediaUrl(slide.id);
                if (run !== generation) { if (nextUrl.startsWith('blob:')) URL.revokeObjectURL(nextUrl); return; }
                release();
                slideSerial++;
                active = slide;
                url = nextUrl;
                loading = false;
                if (slide.kind === 'text') schedule(slide.duration * 1000);
                else timer = setTimeout(() => fail(slide.id), 15000);
                return;
            } catch { failed.add(slide.id); }
        }
        if (run !== generation) return;
        release();
        active = null;
        loading = false;
    }
    function fail(id: string) {
        failed.add(id);
        void advance();
    }
    function play(video: HTMLVideoElement) {
        video.muted = true;
        const onReady = () => {
            if (!Number.isFinite(video.duration) || video.duration > 120) { if (active) fail(active.id); return; }
            schedule((video.duration + 8) * 1000);
            void video.play().catch(() => { if (active) fail(active.id); });
        };
        video.addEventListener('loadeddata', onReady);
        return { destroy() { video.removeEventListener('loadeddata', onReady); video.pause(); } };
    }
    onMount(() => {
        mounted = true;
        return () => { mounted = false; generation++; release(); };
    });
</script>

<div class="display-player" class:fade={content.transition === 'fade'} style:background={content.background}
    style:color={content.color} style:font-family={font} style:--message-size={`${content.size / 8}cqi`}
    style:--message-weight={content.bold ? 800 : 400} style:font-style={content.italic ? 'italic' : 'normal'}
    style:text-align={content.align} aria-label="Customer display content">
    {#key slideSerial}
        <div class="slide" class:with-media={active && active.kind !== 'text'}>
            {#if active?.kind === 'image' && url}
                <img src={url} alt={active.name} style:object-fit={content.fit}
                    on:load={() => schedule(active!.duration * 1000)} on:error={() => active && fail(active.id)} />
            {:else if active?.kind === 'video' && url}
                <video src={url} muted playsinline preload="auto" use:play style:object-fit={content.fit}
                    aria-label={active.name} on:ended={() => void advance()} on:error={() => active && fail(active.id)}>
                    <track kind="captions" />
                </video>
            {/if}
            {#if !active || active.kind === 'text' || content.overlay}
                <div class="message" class:overlay={active && active.kind !== 'text'}>
                    <h2>{heading || 'Welcome'}</h2>
                    {#if body}<p>{body}</p>{/if}
                </div>
            {/if}
        </div>
    {/key}
    {#if loading}<span class="loading" aria-label="Loading next slide"></span>{/if}
</div>

<style>
    .display-player { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; border-radius: inherit; container-type: inline-size; }
    .slide { position: absolute; inset: 0; display: grid; align-items: center; overflow: hidden; }
    .fade .slide { animation: reveal .45s ease-out; }
    img, video { display: block; width: 100%; height: 100%; min-height: 0; position: absolute; inset: 0; }
    .message { padding: clamp(12px, 5cqi, 70px); width: 100%; max-height: 100%; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
    .message h2 { margin: 0; color: inherit; font-family: inherit; font-style: inherit; font-size: clamp(14px, var(--message-size), 110px); font-weight: var(--message-weight); line-height: 1.12; }
    .message p { font-weight: var(--message-weight); margin: .8em 0 0; font-size: clamp(11px, calc(var(--message-size) * .48), 48px); line-height: 1.4; }
    .message.overlay { position: absolute; bottom: 0; padding-top: 4cqi; color: inherit; background: linear-gradient(transparent, rgba(0, 0, 0, .85)); }
    .loading { position: absolute; bottom: 12px; right: 12px; width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .5; }
    @keyframes reveal { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .fade .slide { animation: none; } }
</style>

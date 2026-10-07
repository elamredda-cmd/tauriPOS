<script lang="ts">
    import { onMount } from 'svelte';
    import { displayMediaUrl, type DisplaySlide } from '$lib/customerDisplayContent';
    export let slide: DisplaySlide;
    let url = '';
    let failed = false;
    onMount(() => {
        let disposed = false;
        if (slide.kind !== 'text') void displayMediaUrl(slide.id).then(value => {
            if (disposed) { if (value.startsWith('blob:')) URL.revokeObjectURL(value); }
            else url = value;
        }).catch(() => failed = true);
        return () => { disposed = true; if (url.startsWith('blob:')) URL.revokeObjectURL(url); };
    });
</script>
<div class="thumbnail" aria-hidden="true">
    {#if url && !failed && slide.kind === 'image'}<img src={url} alt="" on:error={() => failed = true} />
    {:else if url && !failed && slide.kind === 'video'}<video src={url} muted playsinline preload="metadata" on:error={() => failed = true}><track kind="captions" /></video><span class="play">▶</span>
    {:else}<span>{slide.kind === 'text' ? 'Aa' : failed ? '!' : '…'}</span>{/if}
</div>
<style>
    .thumbnail { position: relative; width: 64px; height: 54px; border-radius: 8px; display: grid; place-items: center; background: var(--bg-root); color: var(--text-muted); font-size: 22px; font-weight: 800; overflow: hidden; flex: 0 0 auto; }
    img, video { width: 100%; height: 100%; object-fit: cover; }
    .play { position: absolute; color: white; text-shadow: 0 1px 5px black; font-size: 18px; }
</style>

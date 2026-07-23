<script lang="ts">
    import PageBackButton from '$lib/components/PageBackButton.svelte';

    export let title: string;
    export let eyebrow = 'Management';
    export let description = '';
    export let backFallback = '/';
    export let padded = false;
    export let extraClass = '';
</script>

<header class={`app-page-header management-header ${padded ? 'app-page-header-padded' : ''} ${extraClass}`.trim()}>
    <div class="app-page-heading management-title">
        <PageBackButton fallback={backFallback} />
        <div class="app-page-heading-copy">
            <span class="app-page-eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
            {#if description}<p>{description}</p>{/if}
        </div>
    </div>
    <div class="app-page-actions management-actions">
        <slot />
    </div>
</header>

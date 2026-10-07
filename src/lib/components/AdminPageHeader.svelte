<script lang="ts">
    import ConnectionStatusPill from '$lib/components/ConnectionStatusPill.svelte';
    import PageBackButton from '$lib/components/PageBackButton.svelte';

    export let title: string;
    export let eyebrow = 'Management';
    export let description = '';
    export let backFallback = '/';
    export let showBack = true;
    export let padded = false;
    export let extraClass = '';
</script>

<header class={`app-page-header management-header ${padded ? 'app-page-header-padded' : ''} ${extraClass}`.trim()}>
    <div class="app-page-heading management-title">
        {#if showBack}<PageBackButton fallback={backFallback} />{/if}
        <div class="app-page-heading-copy">
            <div class="app-page-heading-meta">
                <span class="app-page-eyebrow">{eyebrow}</span>
                <ConnectionStatusPill />
            </div>
            <h1>{title}</h1>
            {#if description}<p>{description}</p>{/if}
        </div>
    </div>
    <div class="app-page-actions management-actions">
        <slot />
    </div>
</header>

<script lang="ts">
    import { goBack } from '$lib/navigation';

    export let fallback = '/';
    export let ariaLabel = 'Go back';
    export let title = 'Back';
    export let extraClass = '';
</script>

<button
    type="button"
    class={`page-back-button ${extraClass}`}
    aria-label={ariaLabel}
    title={title}
    on:click={() => goBack(fallback)}
>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">
        <line x1="19" y1="12" x2="5" y2="12"></line>
        <polyline points="12 19 5 12 12 5"></polyline>
    </svg>
</button>

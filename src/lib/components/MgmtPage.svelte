<script lang="ts">
    import { goBack } from '$lib/navigation';
    export let title: string;
    export let backFallback = '/';
</script>

<div class="management-page p-6 h-screen flex flex-col overflow-hidden bg-bg-base text-text-main">
    <header class="management-header mb-6 shrink-0">
        <div class="management-title flex items-center gap-4">
            <button type="button" class="btn-icon" aria-label="Go back" on:click={() => goBack(backFallback)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </button>
            <h1 class="text-3xl m-0">{title}</h1>
        </div>
        <div class="management-actions flex gap-3">
            <slot name="actions" />
        </div>
    </header>
    <div class="management-content flex-1 rounded-md bg-bg-panel border border-border-flat">
        <slot />
    </div>
</div>

<!-- Modal slot -->
<slot name="modal" />

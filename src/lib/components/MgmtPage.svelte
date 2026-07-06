<script lang="ts">
    import PageBackButton from '$lib/components/PageBackButton.svelte';

    export let title: string;
    export let backFallback = '/';
</script>

<div class="management-page p-6 h-screen flex flex-col overflow-hidden bg-bg-base text-text-main">
    <header class="management-header mb-6 shrink-0">
        <div class="management-title flex items-center gap-4">
            <PageBackButton fallback={backFallback} />
            <div class="min-w-0">
                <span class="block text-xs font-black uppercase tracking-[0.16em] text-text-muted">Management</span>
                <h1 class="text-3xl m-0 truncate">{title}</h1>
            </div>
        </div>
        <div class="management-actions flex gap-3">
            <slot name="actions" />
        </div>
    </header>
    <div class="management-content flex-1 rounded-xl bg-bg-panel border border-border-flat shadow-[0_18px_45px_var(--shadow)]">
        <slot />
    </div>
</div>

<!-- Modal slot -->
<slot name="modal" />

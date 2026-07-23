<script lang="ts">
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';

    export let title: string;
    export let backFallback = '/';
    export let eyebrow = 'Management';
    export let description = '';
</script>

<div class="management-page h-screen flex flex-col overflow-hidden bg-bg-base text-text-main">
    <AdminPageHeader {title} {eyebrow} {description} {backFallback}>
        <slot name="actions" />
    </AdminPageHeader>
    <div class="management-content flex-1 rounded-lg bg-bg-panel border border-border-flat shadow-[0_12px_32px_var(--shadow)]">
        <slot />
    </div>
</div>

<!-- Modal slot -->
<slot name="modal" />

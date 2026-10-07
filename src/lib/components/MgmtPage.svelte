<script lang="ts">
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';
    import { deviceOperatingMode } from '$lib/deviceMode';

    export let title: string;
    export let backFallback = '/';
    export let showBack = true;
    export let eyebrow = 'Management';
    export let description = '';

    $: resolvedBackFallback = $deviceOperatingMode === 'back_office' && backFallback === '/'
        ? '/admin'
        : backFallback;
</script>

<div class="management-page h-screen flex flex-col overflow-hidden bg-bg-base text-text-main">
    <AdminPageHeader {title} {eyebrow} {description} backFallback={resolvedBackFallback} {showBack}>
        <slot name="actions" />
    </AdminPageHeader>
    <div class="management-content flex-1 rounded-lg bg-bg-panel border border-border-flat shadow-[0_12px_32px_var(--shadow)]">
        <slot />
    </div>
</div>

<!-- Modal slot -->
<slot name="modal" />

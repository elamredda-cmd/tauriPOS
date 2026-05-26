<script lang="ts">
    export let title: string;
</script>

<div class="p-6 h-screen flex flex-col overflow-hidden bg-bg-base text-text-main">
    <header class="flex justify-between items-center mb-6 shrink-0">
        <div class="flex items-center gap-4">
            <a href="/" class="btn-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </a>
            <h1 class="text-3xl m-0">{title}</h1>
        </div>
        <div class="flex gap-3">
            <slot name="actions" />
        </div>
    </header>
    <div class="flex-1 overflow-y-auto rounded-md bg-bg-panel border border-border-flat">
        <slot />
    </div>
</div>

<!-- Modal slot -->
<slot name="modal" />

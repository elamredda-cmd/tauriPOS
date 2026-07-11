<script lang="ts">
    import TouchKeyboard from '$lib/components/TouchKeyboard.svelte';

    let value = 'Coca Cola';
    let visible = true;
    let selectionStart = value.length;
    let selectionEnd = value.length;
</script>

<main class="flex min-h-screen items-end bg-bg-base p-4">
    <div class="w-full overflow-hidden rounded-xl border border-border-flat bg-bg-panel shadow-xl">
        <TouchKeyboard
            bind:value
            bind:visible
            bind:selectionStart
            bind:selectionEnd
            title="Item Name"
            placeholder="Enter item name"
            onSelectionChange={(start, end) => {
                selectionStart = start;
                selectionEnd = end;
            }}
        />
    </div>
</main>

<script lang="ts">
    import { loyaltyCodeValidationError, normalizeLoyaltyCode } from '$lib/customerLoyaltyCode';

    export let value = "";
    export let height = 54;

    const patterns: Record<string, string> = {
        "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
        "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
        "A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn",
        "F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn",
        "K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn",
        "P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn",
        "U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn",
        "Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","*":"nwnnwnwnn",
        "$":"nwnwnwnnn","/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn",
    };

    $: normalizedValue = normalizeLoyaltyCode(value);
    $: validationError = loyaltyCodeValidationError(normalizedValue);
    $: encoded = validationError ? '' : `*${normalizedValue}*`;
    $: bars = (() => {
        let x = 0;
        const result: { x: number; width: number }[] = [];
        for (const character of encoded) {
            const pattern = patterns[character] || patterns["-"];
            for (let index = 0; index < pattern.length; index++) {
                const width = pattern[index] === "w" ? 3 : 1;
                if (index % 2 === 0) result.push({ x, width });
                x += width;
            }
            x += 1;
        }
        return { items: result, width: Math.max(x, 1) };
    })();
</script>

<div class="loyalty-barcode rounded-[.55rem] bg-white p-[.65rem] text-center text-black">
    {#if validationError}
        <div class="flex min-h-[72px] items-center justify-center font-semibold text-slate-600" role="status">
            Barcode unavailable
        </div>
    {:else}
        <svg
            class="block w-full fill-black"
            style="height:{height}px"
            viewBox="0 0 {bars.width} {height}"
            preserveAspectRatio="none"
            aria-label="Barcode {normalizedValue}"
        >
            {#each bars.items as bar}<rect x={bar.x} y="0" width={bar.width} height={height} />{/each}
        </svg>
        <strong class="mt-[.3rem] block font-mono text-[.82rem] tracking-[.16em]">{normalizedValue}</strong>
    {/if}
</div>

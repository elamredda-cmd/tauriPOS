<script lang="ts">
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

    $: encoded = `*${value.toUpperCase().replace(/[^0-9A-Z. $/+%-]/g, "")}*`;
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

<div class="loyalty-barcode">
    <svg style="height:{height}px" viewBox="0 0 {bars.width} {height}" preserveAspectRatio="none" aria-label="Barcode {value}">
        {#each bars.items as bar}<rect x={bar.x} y="0" width={bar.width} height={height} />{/each}
    </svg>
    <strong>{value}</strong>
</div>

<style>
    .loyalty-barcode { padding: .65rem; color: #000; text-align: center; border-radius: .55rem; background: #fff; }
    svg { width: 100%; height: 54px; display: block; fill: #000; }
    strong { display: block; margin-top: .3rem; font-family: ui-monospace, monospace; font-size: .82rem; letter-spacing: .16em; }
</style>

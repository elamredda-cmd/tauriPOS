<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import { now, settingsDB, uuid } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        BARCODE_RULES_SETTING_KEY,
        PRICE_RULE_PRESET,
        WEIGHT_RULE_PRESET,
        addEan13CheckDigit,
        getBarcodeRules,
        parseScaleBarcode,
        validateBarcodeRule,
        type BarcodeRule,
    } from '$lib/barcodeRules';

    type DigitKind = 'prefix' | 'product' | 'value' | 'check' | 'unused';
    type DiagramDigit = { position: number; value: string; kind: DigitKind };

    let rules: BarcodeRule[] = getBarcodeRules($settingsDB);
    let testBarcode = '';
    let testResult = '';

    function addRule(preset: BarcodeRule) {
        rules = [...rules, { ...preset, id: uuid() }];
    }

    function removeRule(id: string) {
        rules = rules.filter((rule) => rule.id !== id);
    }

    function useEasyLayout(rule: BarcodeRule) {
        rule.totalLength = 13;
        rule.productStart = rule.prefix.length + 1;
        rule.valueStart = rule.productStart + rule.productLength;
        rules = [...rules];
    }

    function updatePrefix(rule: BarcodeRule, value: string) {
        rule.prefix = value.replace(/\D/g, '').slice(0, 6);
        useEasyLayout(rule);
    }

    function sampleBarcode(rule: BarcodeRule): string {
        const digits = Array(rule.totalLength).fill('0');
        for (let index = 0; index < rule.prefix.length && index < digits.length; index++) {
            digits[index] = rule.prefix[index];
        }
        const productSample = '1234567890'.repeat(3);
        for (let index = 0; index < rule.productLength; index++) {
            const target = rule.productStart - 1 + index;
            if (target < digits.length) digits[target] = productSample[index];
        }
        const valueSample = rule.valueType === 'price' ? '00699' : '01500';
        const paddedValue = valueSample.padStart(rule.valueLength, '0').slice(-rule.valueLength);
        for (let index = 0; index < rule.valueLength; index++) {
            const target = rule.valueStart - 1 + index;
            if (target < digits.length) digits[target] = paddedValue[index];
        }
        if (rule.totalLength === 13) return addEan13CheckDigit(digits.slice(0, 12).join(''));
        return digits.join('');
    }

    function digitKind(rule: BarcodeRule, position: number): DigitKind {
        if (rule.validateCheckDigit && position === rule.totalLength) return 'check';
        if (position <= rule.prefix.length) return 'prefix';
        if (position >= rule.productStart && position < rule.productStart + rule.productLength) return 'product';
        if (position >= rule.valueStart && position < rule.valueStart + rule.valueLength) return 'value';
        return 'unused';
    }

    function diagram(rule: BarcodeRule, barcode = ''): DiagramDigit[] {
        const value = barcode.length === rule.totalLength ? barcode : sampleBarcode(rule);
        return Array.from({ length: rule.totalLength }, (_, index) => ({
            position: index + 1,
            value: value[index] || '0',
            kind: digitKind(rule, index + 1),
        }));
    }

    function kindLabel(rule: BarcodeRule, kind: DigitKind): string {
        if (kind === 'prefix') return 'Prefix';
        if (kind === 'product') return 'Product PLU';
        if (kind === 'value') return rule.valueType === 'price' ? 'Total Price' : 'Weight';
        if (kind === 'check') return 'Check';
        return 'Unused';
    }

    async function saveRules() {
        for (const rule of rules) {
            const error = validateBarcodeRule(rule);
            if (error) {
                toast(`${rule.name || 'Barcode rule'}: ${error}`, 'error');
                return;
            }
        }
        const setting = { key: BARCODE_RULES_SETTING_KEY, value: JSON.stringify(rules), updatedAt: now() };
        settingsDB.update((list) => {
            const index = list.findIndex((item) => item.key === setting.key);
            if (index >= 0) list[index] = setting;
            else list.push(setting);
            return list;
        });
        await upsert('settings', setting, 'key');
        toast('Barcode rules saved');
    }

    function testRules() {
        const parsed = parseScaleBarcode(testBarcode, rules);
        if (!parsed) {
            testResult = 'Not recognized. Check the prefix, layout, barcode length, and check digit.';
            return;
        }
        const value = parsed.rule.valueType === 'price'
            ? `£${parsed.value.toFixed(parsed.rule.decimalPlaces)}`
            : `${parsed.value.toFixed(parsed.rule.decimalPlaces)} kg`;
        testResult = `${parsed.rule.name}: Product PLU ${parsed.scalePlu}, ${parsed.rule.valueType} ${value}`;
    }
</script>

<MgmtPage title="Scale Barcode Rules" backFallback="/settings">
    <div slot="actions" class="flex gap-2">
        <button class="btn btn-secondary" on:click={() => addRule(PRICE_RULE_PRESET)}>Add Price Rule</button>
        <button class="btn btn-secondary" on:click={() => addRule(WEIGHT_RULE_PRESET)}>Add Weight Rule</button>
        <button class="btn btn-primary" on:click={saveRules}>Save Rules</button>
    </div>

    <div class="p-6 flex flex-col gap-6">
        <section class="settings-section">
            <h3 class="settings-section-title">Build the Barcode from Left to Right</h3>
            <p class="text-text-muted">Match the colored blocks to a label printed by your scale. The POS recognizes a scale barcode by its prefix, then reads the Product PLU and price or weight from the configured blocks.</p>
        </section>

        {#each rules as rule, index (rule.id)}
            <section class="settings-section flex flex-col gap-5">
                <div class="flex justify-between items-start gap-4">
                    <div>
                        <h3 class="settings-section-title !mb-1">{rule.name || `Rule ${index + 1}`}</h3>
                        <p class="text-text-muted text-sm">{rule.valueType === 'price' ? 'Embedded-price labels are accepted at checkout.' : 'Weight labels can be tested, but checkout is blocked until weight stock support is enabled.'}</p>
                    </div>
                    <div class="flex gap-2">
                        <button class="btn btn-secondary" on:click={() => useEasyLayout(rule)}>Arrange Standard Layout</button>
                        <button class="btn btn-danger" on:click={() => removeRule(rule.id)}>Remove</button>
                    </div>
                </div>

                <div class="barcode-board">
                    <div class="barcode-bars" aria-hidden="true"></div>
                    <div class="barcode-digits">
                        {#each diagram(rule) as digit}
                            <div class="barcode-digit barcode-{digit.kind}" title="{kindLabel(rule, digit.kind)}, digit {digit.position}">
                                <span class="barcode-position">{digit.position}</span>
                                <strong>{digit.value}</strong>
                            </div>
                        {/each}
                    </div>
                    <div class="barcode-legend">
                        {#each ['prefix', 'product', 'value', 'check'] as kind}
                            <span class="legend-{kind}"><i></i>{kindLabel(rule, kind as DigitKind)}</span>
                        {/each}
                    </div>
                    <div class="barcode-reading">
                        <span><b>Prefix:</b> {rule.prefix}</span>
                        <span><b>Product PLU:</b> {sampleBarcode(rule).slice(rule.productStart - 1, rule.productStart - 1 + rule.productLength)}</span>
                        <span><b>{rule.valueType === 'price' ? 'Price' : 'Weight'}:</b> {rule.valueType === 'price' ? '£6.99' : '1.500 kg'}</span>
                        <span><b>Check digit:</b> {sampleBarcode(rule).slice(-1)}</span>
                    </div>
                </div>
                {#if validateBarcodeRule(rule)}
                    <p class="p-3 rounded-sm border border-danger text-danger bg-danger/10">
                        Layout needs attention: {validateBarcodeRule(rule)}
                    </p>
                {:else}
                    <p class="text-success font-semibold">
                        This rule reads: {rule.prefix} + {rule.productLength}-digit Product PLU + {rule.valueLength}-digit {rule.valueType === 'price' ? 'Price' : 'Weight'} + Check Digit
                    </p>
                {/if}

                <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div class="barcode-block-editor block-prefix">
                        <h4>1. Scale Prefix</h4>
                        <p>This tells the POS which rule to use.</p>
                        <label>Digits printed first</label>
                        <input value={rule.prefix} inputmode="numeric" on:input={(event) => updatePrefix(rule, event.currentTarget.value)} />
                    </div>
                    <div class="barcode-block-editor block-product">
                        <h4>2. Product PLU</h4>
                        <p>This finds the item in your product list.</p>
                        <label>Number of digits</label>
                        <input type="number" min="1" max="9" bind:value={rule.productLength} on:change={() => useEasyLayout(rule)} />
                    </div>
                    <div class="barcode-block-editor block-value">
                        <h4>3. {rule.valueType === 'price' ? 'Total Price' : 'Weight'}</h4>
                        <p>This becomes the sale price or measured weight.</p>
                        <div class="grid grid-cols-2 gap-3">
                            <label>Digits<input type="number" min="1" max="9" bind:value={rule.valueLength} on:change={() => useEasyLayout(rule)} /></label>
                            <label>Decimals<input type="number" min="0" max={rule.valueLength} bind:value={rule.decimalPlaces} /></label>
                        </div>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="field span-2"><label>Rule Name</label><input bind:value={rule.name} /></div>
                    <div class="field">
                        <CustomSelect label="Embedded Value" bind:value={rule.valueType} options={[
                            { label: 'Total price', value: 'price' },
                            { label: 'Weight in kilograms', value: 'weight' },
                        ]} />
                    </div>
                    <div class="field"><TouchToggle bind:checked={rule.enabled} label="Enabled" /></div>
                    <div class="field"><TouchToggle bind:checked={rule.validateCheckDigit} label="Validate EAN Check Digit" /></div>
                </div>

                <details class="advanced-layout">
                    <summary>Advanced Layout for Unusual Scale Barcodes</summary>
                    <p class="text-text-muted text-sm mt-3">Only change these when your scale leaves gaps or prints fields in a different order. Positions start at digit 1.</p>
                    <div class="form-grid mt-4">
                        <div class="field"><label>Total Digits</label><input type="number" min="1" bind:value={rule.totalLength} /></div>
                        <div class="field"><label>Product Code Starts At</label><input type="number" min="1" bind:value={rule.productStart} /></div>
                        <div class="field"><label>Product Code Digits</label><input type="number" min="1" bind:value={rule.productLength} /></div>
                        <div class="field"><label>Value Starts At</label><input type="number" min="1" bind:value={rule.valueStart} /></div>
                        <div class="field"><label>Value Digits</label><input type="number" min="1" bind:value={rule.valueLength} /></div>
                    </div>
                </details>
            </section>
        {/each}

        {#if rules.length === 0}
            <section class="settings-section text-center">
                <h3 class="settings-section-title">No Barcode Rules Yet</h3>
                <p class="text-text-muted">Add a price or weight rule to start building its barcode.</p>
            </section>
        {/if}

        <section class="settings-section">
            <h3 class="settings-section-title">Scan a Label to Test It</h3>
            <div class="flex gap-3">
                <input class="flex-1" bind:value={testBarcode} inputmode="numeric" placeholder="Scan or type a scale barcode" on:keydown={(event) => event.key === 'Enter' && testRules()} />
                <button class="btn btn-secondary" on:click={testRules}>Test Barcode</button>
            </div>
            {#if testBarcode && rules.length > 0 && testBarcode.length === rules[0].totalLength}
                <div class="barcode-digits mt-4">
                    {#each diagram(rules[0], testBarcode) as digit}
                        <div class="barcode-digit barcode-{digit.kind}"><span class="barcode-position">{digit.position}</span><strong>{digit.value}</strong></div>
                    {/each}
                </div>
            {/if}
            {#if testResult}<p class="mt-4 p-3 bg-bg-panel border border-border-flat rounded-sm">{testResult}</p>{/if}
        </section>
    </div>
</MgmtPage>

<style>
    .barcode-board { background:#fff; color:#111827; border:1px solid #cbd5e1; border-radius:10px; padding:18px; overflow-x:auto; }
    .barcode-bars { height:58px; min-width:760px; opacity:.75; background:repeating-linear-gradient(90deg,#111 0 2px,transparent 2px 5px,#111 5px 6px,transparent 6px 10px,#111 10px 13px,transparent 13px 16px); }
    .barcode-digits { display:grid; grid-template-columns:repeat(13,minmax(46px,1fr)); gap:3px; min-width:760px; }
    .barcode-digit { position:relative; display:flex; align-items:center; justify-content:center; height:58px; border:2px solid; border-radius:5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:24px; }
    .barcode-position { position:absolute; top:2px; left:4px; font-size:9px; opacity:.6; }
    .barcode-prefix,.legend-prefix i { background:#dbeafe; border-color:#3b82f6; }
    .barcode-product,.legend-product i { background:#dcfce7; border-color:#22c55e; }
    .barcode-value,.legend-value i { background:#fef3c7; border-color:#f59e0b; }
    .barcode-check,.legend-check i { background:#f3e8ff; border-color:#a855f7; }
    .barcode-unused { background:#f1f5f9; border-color:#cbd5e1; }
    .barcode-legend,.barcode-reading { display:flex; flex-wrap:wrap; gap:12px 22px; margin-top:14px; font-size:13px; }
    .barcode-legend span { display:flex; align-items:center; gap:6px; font-weight:700; }
    .barcode-legend i { width:14px; height:14px; border:2px solid; border-radius:3px; }
    .barcode-reading { padding-top:12px; border-top:1px solid #e2e8f0; }
    .barcode-block-editor { border:2px solid; border-radius:8px; padding:16px; background:var(--bg-panel); }
    .barcode-block-editor h4 { font-size:17px; margin:0 0 4px; }
    .barcode-block-editor p { color:var(--text-muted); font-size:13px; margin-bottom:14px; }
    .barcode-block-editor label { display:flex; flex-direction:column; gap:6px; color:var(--text-muted); font-size:13px; font-weight:700; }
    .block-prefix { border-color:#3b82f6; }
    .block-product { border-color:#22c55e; }
    .block-value { border-color:#f59e0b; }
    .advanced-layout { border:1px solid var(--border-flat); border-radius:6px; padding:14px; background:var(--bg-panel); }
    .advanced-layout summary { cursor:pointer; color:var(--text-muted); font-weight:700; }
</style>

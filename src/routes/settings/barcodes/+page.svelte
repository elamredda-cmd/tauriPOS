<script lang="ts">
    import { PoundSterling, Save, Scale } from '@lucide/svelte';
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import TouchKeyboardButton from '$lib/components/TouchKeyboardButton.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import { now, settingsDB, uuid, type Setting } from '$lib/stores/db';
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
        validateBarcodeRuleSet,
        type BarcodeRule,
        type BarcodeRuleValueType,
        type ParsedScaleBarcode,
    } from '$lib/barcodeRules';

    type DigitKind = 'prefix' | 'product' | 'value' | 'check' | 'unused';
    type DiagramDigit = { position: number; value: string; kind: DigitKind };
    type TestState = 'idle' | 'success' | 'error';

    function currentSettingValue(): string {
        return $settingsDB.find((setting) => setting.key === BARCODE_RULES_SETTING_KEY)?.value || '[]';
    }

    function parseRulesValue(value: string): BarcodeRule[] {
        const setting: Setting = { key: BARCODE_RULES_SETTING_KEY, value, updatedAt: '' };
        return getBarcodeRules([setting]);
    }

    let loadedSettingValue = currentSettingValue();
    let observedSettingValue = loadedSettingValue;
    let rules: BarcodeRule[] = getBarcodeRules($settingsDB);
    let activeRuleId = rules[0]?.id || '';
    let dirty = false;
    let saving = false;
    let externalUpdatePending = false;
    let pendingRemoveId = '';

    let testBarcode = '';
    let testedBarcode = '';
    let testState: TestState = 'idle';
    let testMessage = '';
    let testParsed: ParsedScaleBarcode | null = null;

    $: activeRule = rules.find((rule) => rule.id === activeRuleId) || rules[0] || null;
    $: activeRuleError = activeRule ? validateBarcodeRule(activeRule) : null;
    $: ruleSetError = validateBarcodeRuleSet(rules);
    $: pendingRemoveRule = rules.find((rule) => rule.id === pendingRemoveId) || null;
    $: remoteSettingValue = $settingsDB.find((setting) => setting.key === BARCODE_RULES_SETTING_KEY)?.value || '[]';
    $: {
        const remoteValue = remoteSettingValue;
        if (remoteValue !== observedSettingValue) {
            observedSettingValue = remoteValue;
            if (dirty && remoteValue !== loadedSettingValue) {
                externalUpdatePending = true;
            } else if (!dirty) {
                loadRulesValue(remoteValue);
            }
        }
    }

    function loadRulesValue(value: string) {
        const next = parseRulesValue(value);
        rules = next;
        activeRuleId = next.some((rule) => rule.id === activeRuleId) ? activeRuleId : next[0]?.id || '';
        loadedSettingValue = value;
        observedSettingValue = value;
        dirty = false;
        externalUpdatePending = false;
        clearTestResult();
    }

    function clearTestResult() {
        testedBarcode = '';
        testState = 'idle';
        testMessage = '';
        testParsed = null;
    }

    function commitRules(next: BarcodeRule[], nextActiveId = activeRuleId) {
        rules = next;
        activeRuleId = next.some((rule) => rule.id === nextActiveId) ? nextActiveId : next[0]?.id || '';
        dirty = true;
        clearTestResult();
    }

    function updateRule(id: string, patch: Partial<BarcodeRule>) {
        commitRules(rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule), id);
    }

    function inputNumber(event: Event, fallback: number): number {
        const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
        return Number.isFinite(value) ? value : fallback;
    }

    function addRule(preset: BarcodeRule) {
        const rule = { ...preset, id: uuid() };
        commitRules([...rules, rule], rule.id);
    }

    function requestRemoveRule(id: string) {
        pendingRemoveId = id;
    }

    function confirmRemoveRule() {
        if (!pendingRemoveId) return;
        const index = rules.findIndex((rule) => rule.id === pendingRemoveId);
        const next = rules.filter((rule) => rule.id !== pendingRemoveId);
        const nextActive = next[Math.min(Math.max(index, 0), Math.max(next.length - 1, 0))]?.id || '';
        commitRules(next, nextActive);
        pendingRemoveId = '';
    }

    function arrangeStandard(rule: BarcodeRule, patch: Partial<BarcodeRule> = {}) {
        const next = { ...rule, ...patch, totalLength: 13 as const };
        next.productStart = next.prefix.length + 1;
        next.valueStart = next.productStart + next.productLength;
        updateRule(rule.id, next);
    }

    function updatePrefix(rule: BarcodeRule, value: string) {
        arrangeStandard(rule, { prefix: value.replace(/\D/g, '').slice(0, 6) });
    }

    function sampleBarcode(rule: BarcodeRule): string {
        const digits = Array(13).fill('0');
        for (let index = 0; index < rule.prefix.length && index < 12; index++) digits[index] = rule.prefix[index];
        const productSample = '1234567890'.repeat(3);
        for (let index = 0; index < rule.productLength; index++) {
            const target = rule.productStart - 1 + index;
            if (target >= 0 && target < 12) digits[target] = productSample[index] || '0';
        }
        const valueSample = rule.valueType === 'price' ? '00699' : '01500';
        const paddedValue = valueSample.padStart(rule.valueLength, '0').slice(-rule.valueLength);
        for (let index = 0; index < rule.valueLength; index++) {
            const target = rule.valueStart - 1 + index;
            if (target >= 0 && target < 12) digits[target] = paddedValue[index] || '0';
        }
        return addEan13CheckDigit(digits.slice(0, 12).join(''));
    }

    function digitKind(rule: BarcodeRule, position: number): DigitKind {
        if (rule.format === 'EAN-13' && position === rule.totalLength) return 'check';
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

    function sampleValue(rule: BarcodeRule): string {
        const barcode = sampleBarcode(rule);
        const digits = barcode.slice(rule.valueStart - 1, rule.valueStart - 1 + rule.valueLength);
        const value = Number.parseInt(digits, 10) / 10 ** rule.decimalPlaces;
        return rule.valueType === 'price' ? `£${value.toFixed(rule.decimalPlaces)}` : `${value.toFixed(rule.decimalPlaces)} kg`;
    }

    function testRules() {
        const conflict = validateBarcodeRuleSet(rules);
        testedBarcode = testBarcode.trim();
        testParsed = null;
        if (conflict) {
            testState = 'error';
            testMessage = conflict;
            return;
        }
        const parsed = parseScaleBarcode(testedBarcode, rules);
        if (!parsed) {
            testState = 'error';
            testMessage = 'Not recognized. Check the prefix, length, layout, and check digit.';
            return;
        }
        testParsed = parsed;
        testState = 'success';
        const value = parsed.rule.valueType === 'price'
            ? `£${parsed.value.toFixed(parsed.rule.decimalPlaces)}`
            : `${parsed.value.toFixed(parsed.rule.decimalPlaces)} kg`;
        testMessage = `${parsed.rule.name}: PLU ${parsed.scalePlu}, ${value}`;
    }

    async function saveRules() {
        if (saving) return;
        const error = validateBarcodeRuleSet(rules);
        if (error) {
            toast(error, 'error');
            return;
        }
        if (externalUpdatePending) {
            toast('Newer barcode rules arrived from another till. Reload them before saving.', 'error');
            return;
        }

        saving = true;
        const value = JSON.stringify(rules);
        const setting = { key: BARCODE_RULES_SETTING_KEY, value, updatedAt: now() };
        try {
            await upsert('settings', setting, 'key');
            loadedSettingValue = value;
            observedSettingValue = value;
            dirty = false;
            settingsDB.update((list) => [...list.filter((item) => item.key !== setting.key), setting]);
            toast('Barcode rules saved', 'success');
        } catch (error) {
            toast(`Barcode rules were not saved: ${error}`, 'error');
        } finally {
            saving = false;
        }
    }
</script>

<svelte:head>
    <title>Scale Barcode Rules - L&amp;Bj POS</title>
</svelte:head>

<div class="barcode-page">
    <AdminPageHeader
        title="Scale Barcode Rules"
        eyebrow="Settings"
        description={`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}${dirty ? ' · Unsaved changes' : ''}`}
        backFallback="/settings"
        padded
    >
        <button type="button" class="btn btn-secondary" disabled={saving} on:click={() => addRule(PRICE_RULE_PRESET)}>
            <PoundSterling size={18} strokeWidth={2.35} aria-hidden="true" />
            Price Rule
        </button>
        <button type="button" class="btn btn-secondary" disabled={saving} on:click={() => addRule(WEIGHT_RULE_PRESET)}>
            <Scale size={18} strokeWidth={2.35} aria-hidden="true" />
            Weight Rule
        </button>
        <button type="button" class="btn btn-primary" disabled={saving || !dirty || Boolean(ruleSetError) || externalUpdatePending} on:click={saveRules}>
            <Save size={18} strokeWidth={2.35} aria-hidden="true" />
            {saving ? 'Saving' : 'Save'}
        </button>
    </AdminPageHeader>

    <main class="barcode-main">
        <section class="rule-bar" aria-label="Barcode rules">
            <div class="rule-tabs">
                {#each rules as rule}
                    <button type="button" class:active={rule.id === activeRule?.id} class:invalid={Boolean(validateBarcodeRule(rule))} on:click={() => activeRuleId = rule.id}>
                        <i class:enabled={rule.enabled}></i>
                        <span>{rule.name || 'Unnamed rule'}</span>
                        <small>{rule.valueType === 'price' ? 'Price' : 'Weight'} · {rule.prefix}</small>
                    </button>
                {/each}
                {#if rules.length === 0}<span class="no-rules-label">No barcode rules</span>{/if}
            </div>
            {#if dirty}<b class="dirty-state">Unsaved</b>{/if}
        </section>

        {#if externalUpdatePending}
            <section class="sync-warning">
                <span>Newer rules arrived from another till.</span>
                <button type="button" on:click={() => loadRulesValue(observedSettingValue)}>Reload Latest</button>
            </section>
        {:else if ruleSetError}
            <section class="rule-warning"><span>{ruleSetError}</span></section>
        {/if}

        <div class="barcode-workspace">
            <section class="editor-panel">
                {#if activeRule}
                    <header class="panel-header">
                        <div>
                            <span>Selected rule</span>
                            <h2>{activeRule.name || 'Unnamed rule'}</h2>
                        </div>
                        <div class="panel-actions">
                            <button type="button" disabled={saving} on:click={() => arrangeStandard(activeRule)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h7"></path><path d="m17 14 3 3-3 3"></path></svg>
                                Standard
                            </button>
                            <button type="button" class="danger" disabled={saving} on:click={() => requestRemoveRule(activeRule.id)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
                                Remove
                            </button>
                        </div>
                    </header>

                    <div class="editor-scroll">
                        <div class="barcode-board">
                            <div class="barcode-bars" aria-hidden="true"></div>
                            <div class="barcode-digits">
                                {#each diagram(activeRule) as digit}
                                    <div class="barcode-digit barcode-{digit.kind}" title={`${kindLabel(activeRule, digit.kind)}, digit ${digit.position}`}>
                                        <span>{digit.position}</span><strong>{digit.value}</strong>
                                    </div>
                                {/each}
                            </div>
                            <div class="barcode-reading">
                                <span><b>Prefix</b>{activeRule.prefix || '—'}</span>
                                <span><b>PLU</b>{sampleBarcode(activeRule).slice(activeRule.productStart - 1, activeRule.productStart - 1 + activeRule.productLength)}</span>
                                <span><b>{activeRule.valueType === 'price' ? 'Price' : 'Weight'}</b>{sampleValue(activeRule)}</span>
                                <span><b>Check</b>{sampleBarcode(activeRule).slice(-1)}</span>
                            </div>
                        </div>

                        {#if activeRuleError}<div class="inline-error">{activeRuleError}</div>{/if}

                        <div class="primary-fields">
                            <label class="prefix-field" for="rule-prefix">
                                <span>Scale prefix</span>
                                <input id="rule-prefix" value={activeRule.prefix} inputmode="numeric" maxlength="6" on:input={(event) => updatePrefix(activeRule, event.currentTarget.value)} />
                            </label>
                            <label for="rule-plu-digits">
                                <span>PLU digits</span>
                                <input id="rule-plu-digits" type="number" min="1" max="9" value={activeRule.productLength} on:change={(event) => arrangeStandard(activeRule, { productLength: inputNumber(event, activeRule.productLength) })} />
                            </label>
                            <label for="rule-value-digits">
                                <span>{activeRule.valueType === 'price' ? 'Price' : 'Weight'} digits</span>
                                <input id="rule-value-digits" type="number" min="1" max="9" value={activeRule.valueLength} on:change={(event) => arrangeStandard(activeRule, { valueLength: inputNumber(event, activeRule.valueLength) })} />
                            </label>
                            <label for="rule-decimals">
                                <span>Decimals</span>
                                <input id="rule-decimals" type="number" min="0" max={activeRule.valueLength} value={activeRule.decimalPlaces} on:change={(event) => updateRule(activeRule.id, { decimalPlaces: inputNumber(event, activeRule.decimalPlaces) })} />
                            </label>
                        </div>

                        <div class="rule-settings">
                            <label class="name-field" for="rule-name">
                                <span>Rule name</span>
                                <input id="rule-name" value={activeRule.name} maxlength="40" on:input={(event) => updateRule(activeRule.id, { name: event.currentTarget.value })} />
                            </label>
                            <div class="select-field">
                                <CustomSelect
                                    label="Embedded value"
                                    value={activeRule.valueType}
                                    options={[{ label: 'Total price', value: 'price' }, { label: 'Weight in kilograms', value: 'weight' }]}
                                    on:change={(event) => updateRule(activeRule.id, { valueType: event.detail as BarcodeRuleValueType })}
                                />
                            </div>
                            <button type="button" class="switch-control" class:active={activeRule.enabled} role="switch" aria-checked={activeRule.enabled} on:click={() => updateRule(activeRule.id, { enabled: !activeRule.enabled })}>
                                <span>Enabled</span><i><b></b></i>
                            </button>
                            <button type="button" class="switch-control" class:active={activeRule.validateCheckDigit} role="switch" aria-checked={activeRule.validateCheckDigit} on:click={() => updateRule(activeRule.id, { validateCheckDigit: !activeRule.validateCheckDigit })}>
                                <span>Validate check digit</span><i><b></b></i>
                            </button>
                        </div>

                        <details class="advanced-layout">
                            <summary>Advanced EAN-13 positions</summary>
                            <div class="advanced-fields">
                                <label for="product-start"><span>PLU starts</span><input id="product-start" type="number" min="1" max="12" value={activeRule.productStart} on:change={(event) => updateRule(activeRule.id, { productStart: inputNumber(event, activeRule.productStart) })} /></label>
                                <label for="product-length"><span>PLU digits</span><input id="product-length" type="number" min="1" max="11" value={activeRule.productLength} on:change={(event) => updateRule(activeRule.id, { productLength: inputNumber(event, activeRule.productLength) })} /></label>
                                <label for="value-start"><span>Value starts</span><input id="value-start" type="number" min="1" max="12" value={activeRule.valueStart} on:change={(event) => updateRule(activeRule.id, { valueStart: inputNumber(event, activeRule.valueStart) })} /></label>
                                <label for="value-length"><span>Value digits</span><input id="value-length" type="number" min="1" max="11" value={activeRule.valueLength} on:change={(event) => updateRule(activeRule.id, { valueLength: inputNumber(event, activeRule.valueLength) })} /></label>
                            </div>
                        </details>
                    </div>
                {:else}
                    <div class="empty-editor">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5v14"></path><path d="M8 5v14"></path><path d="M12 5v14"></path><path d="M17 5v14"></path><path d="M21 5v14"></path></svg>
                        <strong>No barcode rules</strong>
                    </div>
                {/if}
            </section>

            <aside class="tester-panel">
                <header class="panel-header">
                    <div><span>Scanner test</span><h2>Test a Label</h2></div>
                </header>
                <div class="tester-body">
                    <div class="test-input-row">
                        <div class="test-input-wrap">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5v14"></path><path d="M7 5v14"></path><path d="M11 5v14"></path><path d="M16 5v14"></path><path d="M21 5v14"></path></svg>
                            <input id="scale-barcode-test" value={testBarcode} inputmode="numeric" data-touch-keyboard="button" placeholder="Scan barcode" aria-label="Scan or type a scale barcode" on:input={(event) => { testBarcode = event.currentTarget.value.replace(/\D/g, '').slice(0, 32); clearTestResult(); }} on:keydown={(event) => event.key === 'Enter' && testRules()} />
                            <TouchKeyboardButton targetId="scale-barcode-test" label="Open barcode keyboard" embedded />
                        </div>
                        <button type="button" class="test-button" disabled={!testBarcode || rules.length === 0} on:click={testRules}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                            Test
                        </button>
                    </div>

                    {#if testState !== 'idle'}
                        <div class="test-result" class:success={testState === 'success'} class:error={testState === 'error'}>
                            {#if testState === 'success'}
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"></path></svg>
                            {:else}
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5"></path><path d="M12 17h.01"></path><circle cx="12" cy="12" r="9"></circle></svg>
                            {/if}
                            <span>{testMessage}</span>
                        </div>
                    {/if}

                    {#if testParsed}
                        <div class="test-diagram">
                            <div class="barcode-digits compact">
                                {#each diagram(testParsed.rule, testedBarcode) as digit}
                                    <div class="barcode-digit barcode-{digit.kind}"><span>{digit.position}</span><strong>{digit.value}</strong></div>
                                {/each}
                            </div>
                            <dl>
                                <div><dt>Rule</dt><dd>{testParsed.rule.name}</dd></div>
                                <div><dt>Product PLU</dt><dd>{testParsed.scalePlu}</dd></div>
                                <div><dt>{testParsed.rule.valueType === 'price' ? 'Total price' : 'Weight'}</dt><dd>{testParsed.rule.valueType === 'price' ? `£${testParsed.value.toFixed(testParsed.rule.decimalPlaces)}` : `${testParsed.value.toFixed(testParsed.rule.decimalPlaces)} kg`}</dd></div>
                                <div><dt>Check digit</dt><dd>Valid</dd></div>
                            </dl>
                        </div>
                    {:else if activeRule && testState === 'idle'}
                        <div class="sample-panel">
                            <span>Example for {activeRule.name}</span>
                            <strong>{sampleBarcode(activeRule)}</strong>
                            <small>PLU 12345 · {sampleValue(activeRule)}</small>
                        </div>
                    {/if}
                </div>
            </aside>
        </div>
    </main>
</div>

<ConfirmDialog
    show={Boolean(pendingRemoveId)}
    title="Remove Barcode Rule"
    message={`Remove “${pendingRemoveRule?.name || 'this rule'}”? The change is not permanent until you save.`}
    confirmText="Remove Rule"
    variant="danger"
    on:confirm={confirmRemoveRule}
    on:cancel={() => pendingRemoveId = ''}
/>

<style>
    .barcode-page { box-sizing: border-box; width: 100vw; height: 100dvh; min-height: 600px; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-base); color: var(--text-main); }
    .panel-header span { display: block; color: var(--accent-primary); font-size: .68rem; line-height: 1; font-weight: 900; text-transform: uppercase; }
    button:disabled { cursor: not-allowed; opacity: .4; }

    .barcode-main { flex: 1; min-height: 0; padding: 0 var(--app-page-gutter, 1.5rem) var(--app-page-gutter, 1.5rem); display: flex; flex-direction: column; gap: .55rem; }
    .rule-bar { min-height: 52px; display: flex; align-items: center; gap: .65rem; }
    .rule-tabs { min-width: 0; flex: 1; display: flex; gap: .4rem; overflow-x: auto; }
    .rule-tabs button { min-width: 150px; height: 48px; padding: .4rem .55rem; display: grid; grid-template-columns: 10px minmax(0,1fr); grid-template-rows: 1fr 1fr; column-gap: .45rem; align-items: center; border: 1px solid var(--border-flat); border-radius: 6px; background: var(--bg-card); color: var(--text-main); text-align: left; }
    .rule-tabs button.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 13%, var(--bg-card)); }
    .rule-tabs button.invalid { border-color: var(--danger); }
    .rule-tabs button > i { grid-row: 1 / -1; width: 9px; height: 9px; border-radius: 50%; background: var(--text-muted); }
    .rule-tabs button > i.enabled { background: var(--success); }
    .rule-tabs span, .rule-tabs small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rule-tabs span { font-size: .78rem; font-weight: 900; }
    .rule-tabs small { color: var(--text-muted); font-size: .63rem; }
    .no-rules-label { color: var(--text-muted); font-weight: 800; }
    .dirty-state { padding: .3rem .48rem; border-radius: 4px; background: color-mix(in srgb, var(--warning) 16%, var(--bg-card)); color: var(--warning); font-size: .68rem; }
    .sync-warning, .rule-warning { min-height: 42px; padding: .45rem .7rem; display: flex; align-items: center; justify-content: space-between; gap: .65rem; border: 1px solid var(--warning); border-radius: 6px; background: color-mix(in srgb, var(--warning) 10%, var(--bg-panel)); color: var(--warning); font-size: .78rem; font-weight: 800; }
    .rule-warning { border-color: var(--danger); color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, var(--bg-panel)); }
    .sync-warning button { min-height: 32px; padding: 0 .65rem; border-radius: 4px; background: var(--warning); color: #111; font-weight: 900; }

    .barcode-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(530px,1.25fr) minmax(330px,.75fr); gap: .65rem; }
    .editor-panel, .tester-panel { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--border-flat); border-radius: 8px; background: var(--bg-panel); }
    .panel-header { min-height: 60px; padding: .7rem .8rem; display: flex; align-items: center; justify-content: space-between; gap: .65rem; border-bottom: 1px solid var(--border-flat); }
    .panel-header h2 { margin: .22rem 0 0; overflow: hidden; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
    .panel-actions { display: flex; gap: .38rem; }
    .panel-actions button { min-height: 38px; padding: 0 .55rem; display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); font-size: .72rem; font-weight: 850; }
    .panel-actions button.danger { color: var(--danger); }
    .panel-actions svg { width: 16px; height: 16px; }
    .editor-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: .65rem; display: flex; flex-direction: column; gap: .65rem; scrollbar-color: var(--accent-primary) var(--bg-card); }

    .barcode-board { padding: .55rem; overflow: hidden; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #111827; }
    .barcode-bars { height: 34px; opacity: .78; background: repeating-linear-gradient(90deg,#111 0 2px,transparent 2px 5px,#111 5px 6px,transparent 6px 10px,#111 10px 13px,transparent 13px 16px); }
    .barcode-digits { display: grid; grid-template-columns: repeat(13,minmax(0,1fr)); gap: 2px; }
    .barcode-digit { position: relative; min-width: 0; height: 45px; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 2px solid; border-radius: 4px; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
    .barcode-digit span { position: absolute; top: 1px; left: 3px; font-size: 7px; opacity: .65; }
    .barcode-digit strong { font-size: 1rem; }
    .barcode-prefix { background:#dbeafe; border-color:#3b82f6; }
    .barcode-product { background:#dcfce7; border-color:#22c55e; }
    .barcode-value { background:#fef3c7; border-color:#f59e0b; }
    .barcode-check { background:#f3e8ff; border-color:#a855f7; }
    .barcode-unused { background:#f1f5f9; border-color:#cbd5e1; }
    .barcode-reading { margin-top: .5rem; padding-top: .45rem; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: .45rem; border-top: 1px solid #e2e8f0; }
    .barcode-reading span { min-width: 0; overflow: hidden; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
    .barcode-reading b { display: block; color: #64748b; font-size: .58rem; text-transform: uppercase; }
    .inline-error { padding: .5rem .65rem; border: 1px solid var(--danger); border-radius: 5px; background: color-mix(in srgb,var(--danger) 10%,transparent); color: var(--danger); font-size: .75rem; font-weight: 800; }

    .primary-fields { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: .48rem; }
    .primary-fields label, .rule-settings > label, .advanced-fields label { min-width: 0; color: var(--text-muted); font-size: .66rem; font-weight: 900; }
    .primary-fields label > span, .rule-settings label > span, .advanced-fields label > span { display: block; margin-bottom: .25rem; }
    input { box-sizing: border-box; width: 100%; height: 42px; padding: 0 .58rem; border: 1px solid var(--border-flat); border-radius: 5px; outline: 0; background: var(--bg-base); color: var(--text-main); font: inherit; }
    input:focus { border-color: var(--accent-primary); }
    .rule-settings { padding-top: .65rem; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .5rem; border-top: 1px solid var(--border-flat); }
    .name-field { align-self: end; }
    .select-field { align-self: end; }
    .select-field :global(button) { height: 42px; border-radius: 5px; box-shadow: none; }
    .switch-control { min-height: 46px; padding: .5rem .6rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); font-size: .76rem; font-weight: 850; text-align: left; }
    .switch-control.active { border-color: color-mix(in srgb,var(--success) 60%,var(--border-flat)); }
    .switch-control > i { width: 36px; height: 21px; padding: 2px; flex: 0 0 auto; display: block; border-radius: 12px; background: var(--bg-card-hover); }
    .switch-control > i b { width: 17px; height: 17px; display: block; border-radius: 50%; background: var(--text-muted); }
    .switch-control.active > i { background: var(--success); }
    .switch-control.active > i b { margin-left: 15px; background: #fff; }
    .advanced-layout { border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); }
    .advanced-layout summary { padding: .65rem; cursor: pointer; color: var(--text-muted); font-size: .74rem; font-weight: 850; }
    .advanced-fields { padding: 0 .65rem .65rem; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: .45rem; }
    .empty-editor { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .65rem; color: var(--text-muted); }
    .empty-editor svg { width: 48px; height: 48px; }

    .tester-body { flex: 1; min-height: 0; overflow-y: auto; padding: .7rem; display: flex; flex-direction: column; gap: .65rem; }
    .test-input-row { display: flex; gap: .42rem; }
    .test-input-wrap { position: relative; min-width: 0; flex: 1; }
    .test-input-wrap > svg { position: absolute; z-index: 1; left: .6rem; top: 50%; width: 17px; height: 17px; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
    .test-input-wrap > input { padding-left: 2rem; padding-right: 2.7rem; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
    .test-button { min-width: 76px; height: 42px; padding: 0 .65rem; display: inline-flex; align-items: center; justify-content: center; gap: .28rem; border-radius: 5px; background: var(--accent-primary); color: #fff; font-weight: 900; }
    .test-button svg { width: 17px; height: 17px; }
    .test-result { padding: .6rem; display: flex; align-items: flex-start; gap: .48rem; border: 1px solid; border-radius: 5px; font-size: .76rem; font-weight: 800; }
    .test-result svg { width: 19px; height: 19px; flex: 0 0 auto; }
    .test-result.success { border-color: var(--success); background: color-mix(in srgb,var(--success) 10%,transparent); color: var(--success); }
    .test-result.error { border-color: var(--danger); background: color-mix(in srgb,var(--danger) 10%,transparent); color: var(--danger); }
    .test-diagram { display: flex; flex-direction: column; gap: .65rem; }
    .barcode-digits.compact .barcode-digit { height: 40px; }
    .barcode-digits.compact .barcode-digit strong { font-size: .78rem; }
    .test-diagram dl { margin: 0; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .4rem; }
    .test-diagram dl div { min-width: 0; padding: .55rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); }
    .test-diagram dt { color: var(--text-muted); font-size: .62rem; font-weight: 850; text-transform: uppercase; }
    .test-diagram dd { margin: .18rem 0 0; overflow: hidden; font-size: .8rem; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
    .sample-panel { margin-top: auto; padding: .8rem; display: flex; flex-direction: column; gap: .35rem; border: 1px dashed var(--border-flat); border-radius: 6px; background: var(--bg-card); }
    .sample-panel span, .sample-panel small { color: var(--text-muted); font-size: .7rem; }
    .sample-panel strong { overflow-wrap: anywhere; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 1.18rem; }

    @media (max-width: 860px) {
        .barcode-page { height: auto; min-height: 100dvh; overflow-y: auto; }
        .barcode-main { min-height: 980px; }
        .barcode-workspace { grid-template-columns: 1fr; }
        .editor-panel { min-height: 620px; }
        .tester-panel { min-height: 320px; }
    }
    @media (max-width: 660px) {
        .primary-fields, .advanced-fields { grid-template-columns: repeat(2,minmax(0,1fr)); }
    }
</style>

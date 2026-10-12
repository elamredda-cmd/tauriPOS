import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { native } = vi.hoisted(() => ({ native: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native }));
vi.mock('svelte', () => ({ tick: async () => undefined }));

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.resetModules();
    native.mockReturnValue(true);
    vi.stubGlobal('document', { body: { classList: { add: vi.fn(), remove: vi.fn() } } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('native system printing lifecycle', () => {
    it('awaits the native invocation and retains one immutable document after it resolves', async () => {
        const pending = deferred();
        const print = vi.fn(() => pending.promise);
        vi.stubGlobal('window', { print });
        const module = await import('./systemPrint');
        const running = module.printSystemText('Mock receipt', 'Item 1 £1.69');
        await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
        expect(get(module.systemPrintJob)).toMatchObject({ kind: 'text', text: 'Item 1 £1.69' });
        expect(document.body.classList.remove).not.toHaveBeenCalled();
        pending.resolve();
        await running;
        expect(get(module.systemPrintJob)).toMatchObject({ title: 'Mock receipt', text: 'Item 1 £1.69' });
        expect(document.body.classList.remove).not.toHaveBeenCalled();
        module.clearSystemPrintSnapshot();
        expect(get(module.systemPrintJob)).toBeNull();
        expect(document.body.classList.remove).toHaveBeenCalledWith('system-printing');
    });

    it('freezes a receipt payload instead of allowing later sale/store changes into its preview', async () => {
        vi.stubGlobal('window', { print: vi.fn() });
        const module = await import('./systemPrint');
        const payload = { store: { name: 'Original shop' }, order: { id: 'receipt-1' },
            lines: [{ productName: '0EGGS', lineTotal: 169 }], design: { footerText: 'Original footer' } };
        await module.printSystemReceipt(payload as any);
        payload.store.name = 'Changed shop';
        payload.lines[0].lineTotal = 999;
        payload.design.footerText = 'Changed footer';
        expect(get(module.systemPrintJob)).toMatchObject({ kind: 'receipt', payload: {
            store: { name: 'Original shop' }, lines: [{ lineTotal: 169 }], design: { footerText: 'Original footer' },
        } });
    });

    it('replaces, rather than accumulates, native snapshots on the next queued print', async () => {
        const first = deferred();
        const print = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(undefined);
        vi.stubGlobal('window', { print });
        const module = await import('./systemPrint');
        const one = module.printSystemText('First', 'First document');
        const two = module.printSystemText('Second', 'Second document');
        await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        expect(get(module.systemPrintJob)).toMatchObject({ title: 'First' });
        first.resolve();
        await Promise.all([one, two]);
        expect(print).toHaveBeenCalledTimes(2);
        expect(get(module.systemPrintJob)).toMatchObject({ title: 'Second', text: 'Second document' });
    });

    it('propagates a rejected native print request and removes only its failed snapshot', async () => {
        vi.stubGlobal('window', { print: vi.fn().mockRejectedValue(Error('print permission denied')) });
        const module = await import('./systemPrint');
        await expect(module.printSystemText('Mock', 'Never printed')).rejects.toThrow('print permission denied');
        expect(get(module.systemPrintJob)).toBeNull();
        expect(document.body.classList.remove).toHaveBeenCalledWith('system-printing');
    });

    it('freezes a queued receipt at submission rather than when the preceding print resolves', async () => {
        const first = deferred();
        const print = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(undefined);
        vi.stubGlobal('window', { print });
        const module = await import('./systemPrint');
        const one = module.printSystemText('First', 'First document');
        const payload = { store: { name: 'Queued shop' }, order: { id: 'receipt-2' },
            lines: [{ productName: '0EGGS', lineTotal: 169 }], design: { footerText: 'Queued footer' } };
        const two = module.printSystemReceipt(payload as any);
        payload.lines[0].lineTotal = 999;
        await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        first.resolve();
        await Promise.all([one, two]);
        expect(get(module.systemPrintJob)).toMatchObject({ kind: 'receipt', payload: { lines: [{ lineTotal: 169 }] } });
    });

    it('keeps the queue usable after failure and accepts a browser void print result', async () => {
        native.mockReturnValue(false);
        const print = vi.fn().mockRejectedValueOnce(Error('failed')).mockReturnValueOnce(undefined);
        vi.stubGlobal('window', { print });
        const module = await import('./systemPrint');
        await expect(module.printSystemText('Failed', 'Failed')).rejects.toThrow('failed');
        await module.printSystemText('Retry', 'Retry');
        expect(print).toHaveBeenCalledTimes(2);
        expect(get(module.systemPrintJob)).toBeNull();
    });
});

/** Evaluate the real route handlers with a Promise-returning macOS print shim. */
function labelRoute(route: 'label-print' | 'settings/labels', print: () => unknown, nativeMode = true) {
    const source = readFileSync(new URL(`../routes/${route}/+page.svelte`, import.meta.url), 'utf8');
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
    const tree = ts.createSourceFile('route.ts', script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const names = ['printLabels', ...(route === 'label-print' ? ['clearSelected'] : [])];
    const handlers = tree.statements.filter(statement => ts.isFunctionDeclaration(statement)
        && names.includes(statement.name?.text || '')).map(statement => statement.getText(tree)).join('\n');
    const common = `let printingLabels=false, labelPrinter={enabled:true,connection:'system',protocol:'system'};
let selectedProduct={id:'egg',name:'0EGGS',price:169}; let $storeDB={name:'Mock shop'};
let design={widthMm:50,heightMm:30}; let quantity=1,activeTab='item'; let systemPrintSnapshot=null;`;
    const quick = `let totalLabels=1,printerReady=true,systemPrintMode=true;
let selectedProducts=[{product:selectedProduct,quantity:1}],printSheetProducts=[],printSheetContext=null;
let selected=new Map([['egg',selectedProducts[0]]]); let searchInput=null;`;
    const context = { window: { print }, isTauri: () => nativeMode, tick: async () => undefined,
        clearSystemPrintSnapshot: vi.fn(), toast: vi.fn(), structuredClone, api: undefined as any };
    runInNewContext(ts.transpile(`${common}\n${quick}\n${handlers}\napi={printLabels,
${route === 'label-print' ? 'clearSelected,' : ''}
state:()=>({printingLabels,selectedProducts,selected,printSheetProducts,printSheetContext,systemPrintSnapshot}),
mutateOriginal:()=>{selectedProduct.price=999;$storeDB.name='Changed';design.widthMm=100;quantity=9;}};`,
    { target: ts.ScriptTarget.ES2022 }), context);
    return context;
}

describe('label native system-print snapshots', () => {
    it('keeps the quick-label snapshot and selection until explicit Clear after native invocation', async () => {
        const pending = deferred();
        const print = vi.fn(() => pending.promise);
        const route = labelRoute('label-print', print);
        const running = route.api.printLabels();
        await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
        expect(route.api.state().printingLabels).toBe(true);
        expect(route.api.state().printSheetProducts).toHaveLength(1);
        await route.api.printLabels();
        expect(print).toHaveBeenCalledOnce();
        route.api.mutateOriginal();
        pending.resolve();
        await running;
        expect(route.api.state().printingLabels).toBe(false);
        expect(route.api.state().printSheetProducts[0].price).toBe(169);
        expect(route.api.state().printSheetContext).toMatchObject({ store: { name: 'Mock shop' }, design: { widthMm: 50 } });
        expect(route.api.state().selectedProducts[0].quantity).toBe(1);
        expect(route.clearSystemPrintSnapshot).toHaveBeenCalledOnce();
        expect(route.toast).toHaveBeenCalledWith(expect.stringContaining('Print dialog requested'), 'info');
        route.api.clearSelected();
        expect(route.api.state().selected.size).toBe(0);
        expect(route.api.state().printSheetProducts).toHaveLength(0);
        expect(route.api.state().printSheetContext).toBeNull();
    });

    it('catches a rejected asynchronous quick-label request without clearing selected quantities', async () => {
        const route = labelRoute('label-print', () => Promise.reject(Error('OS print unavailable')));
        await route.api.printLabels();
        expect(route.api.state().printingLabels).toBe(false);
        expect(route.api.state().selectedProducts[0].quantity).toBe(1);
        expect(route.api.state().printSheetProducts).toHaveLength(0);
        expect(route.toast).toHaveBeenCalledWith(expect.stringContaining('OS print unavailable'), 'error');
    });

    it('cleans browser void-print temporary DOM while retaining selected quantities', async () => {
        const route = labelRoute('label-print', () => undefined, false);
        await route.api.printLabels();
        expect(route.api.state().selectedProducts[0].quantity).toBe(1);
        expect(route.api.state().printSheetProducts).toHaveLength(0);
    });

    it('freezes designer item/store/design/copy count and retains its native print sheet', async () => {
        const pending = deferred();
        const print = vi.fn(() => pending.promise);
        const route = labelRoute('settings/labels', print);
        const running = route.api.printLabels();
        await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
        expect(route.api.state().printingLabels).toBe(true);
        route.api.mutateOriginal();
        await route.api.printLabels();
        expect(print).toHaveBeenCalledOnce();
        pending.resolve();
        await running;
        expect(route.api.state().printingLabels).toBe(false);
        expect(route.api.state().systemPrintSnapshot).toMatchObject({ product: { price: 169 },
            store: { name: 'Mock shop' }, design: { widthMm: 50 }, copies: 1 });
        expect(route.clearSystemPrintSnapshot).toHaveBeenCalledOnce();
    });

    it('catches a rejected asynchronous designer request and finishes its busy state', async () => {
        const route = labelRoute('settings/labels', () => Promise.reject(Error('OS print unavailable')));
        await route.api.printLabels();
        expect(route.api.state().printingLabels).toBe(false);
        expect(route.api.state().systemPrintSnapshot).toBeNull();
        expect(route.toast).toHaveBeenCalledWith(expect.stringContaining('OS print unavailable'), 'error');
    });

    it('grants only the existing main-window print capability required by the macOS shim', () => {
        const capability = JSON.parse(readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
        expect(capability.windows).toEqual(['main']);
        expect(capability.permissions).toContain('core:webview:allow-print');
    });

    it('emits receipt visibility rules only for an active receipt/report print, not ordinary labels', () => {
        const source = readFileSync(new URL('./components/Receipt.svelte', import.meta.url), 'utf8');
        const css = compile(source, { filename: 'Receipt.svelte', generate: 'client' }).css?.code || '';
        expect(css).toContain('body.system-printing *');
        expect(css).toContain('body.system-printing .receipt-print-target');
        expect(css).not.toMatch(/(?:^|[{};,])\s*body\s+\*\s*\{/);
        expect(css).not.toMatch(/(?:^|[{};,])\s*\.receipt-print-target(?:\s+\*)?\s*[{,]/);
        // Both real label handlers remove the receipt-printing mode before
        // preparing their independent sheet, making these gated rules inert.
        for (const route of ['label-print', 'settings/labels']) {
            const handler = readFileSync(new URL(`../routes/${route}/+page.svelte`, import.meta.url), 'utf8');
            expect(handler).toContain('clearSystemPrintSnapshot();');
            expect(handler.indexOf('clearSystemPrintSnapshot();')).toBeLessThan(handler.indexOf('await Promise.resolve(window.print())'));
        }
    });

    it('removes screen viewport clipping for printed documents and sizes both frozen label sheets', () => {
        const globalCss = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
        const printing = globalCss.slice(globalCss.indexOf('@media print {'));
        expect(printing).toContain('html, body {');
        expect(printing).toContain('height: auto !important;');
        expect(printing).toContain('width: auto !important;');
        expect(printing).toContain('overflow: visible !important;');
        for (const [route, snapshot] of [['label-print','printSheetContext'], ['settings/labels','systemPrintSnapshot']]) {
            const source = readFileSync(new URL(`../routes/${route}/+page.svelte`, import.meta.url), 'utf8');
            expect(source).toContain(`(${snapshot}?.design || design).widthMm`);
            expect(source).toContain(`(${snapshot}?.design || design).heightMm`);
            expect(source).toContain('size: ${printPageWidth}mm ${printPageHeight}mm; margin: 0;');
        }
    });
});

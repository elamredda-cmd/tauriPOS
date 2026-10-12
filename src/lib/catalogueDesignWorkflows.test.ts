import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function routeSource(route: string) {
    return readFileSync(new URL(`../routes/${route}/+page.svelte`, import.meta.url), 'utf8');
}

/** Execute the actual route handlers, not a rewritten approximation. */
function runHandlers(route: string, names: string[], prefix: string, exposed: string, mocks: Record<string, unknown> = {}) {
    const script = routeSource(route).split('<script lang="ts">')[1].split('</script>')[0];
    const ast = ts.createSourceFile('route.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const handlers = ast.statements.filter(statement => ts.isFunctionDeclaration(statement)
        && names.includes(statement.name?.text || '')).map(statement => statement.getText(ast));
    expect(handlers).toHaveLength(names.length);
    const context = { console: { error: vi.fn(), warn: vi.fn() }, toast: vi.fn(), now: () => '2026-10-12T20:00:00.000Z', nativeQaEnabled: false,
        isTauri: () => false, clearSystemPrintSnapshot: vi.fn(), structuredClone,
        $storeDB: { name: 'Mock store' }, design: { widthMm: 50, heightMm: 30 }, printSheetContext: null,
        api: undefined as any, ...mocks };
    runInNewContext(ts.transpile(`${prefix}\n${handlers.join('\n')}\napi = { ${exposed} };`, { target: ts.ScriptTarget.ES2022 }), context);
    return context;
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const itemPrefix = `
let savingItem=false, imageUploading=false, generatingPlu=false, showModal=true, itemDraftVersion=1;
let itemSaveWarning='', priceString='', desktopPriceString='';
let $deviceOperatingMode='checkout', configuredPluLengths=[5], goodsMenuCount=0;
let currentItem={id:'item-1',name:'Submitted item',price:100,categoryId:'cat',stockLevel:7,showInGoods:false};
let originalItem={...currentItem,stockLevel:3}, isEditing=true;
function normalizeDesktopPrice() {};
`;

const itemApi = `saveItem, state:()=>({savingItem,showModal,itemSaveWarning,currentItem,originalItem}),
setDraft:(draft:any)=>currentItem=draft`;

describe('catalogue async submissions', () => {
    it('prevents duplicate item saves and freezes the submitted stock/details', async () => {
        const pending = deferred();
        const updateProductFields = vi.fn((..._args: any[]) => pending.promise);
        const setStockLevel = vi.fn(async () => {});
        const context = runHandlers('items', ['saveItem'], itemPrefix, itemApi, {
            updateProductFields, setStockLevel, addProduct: vi.fn(), toPounds: (p: number) => p / 100,
            loadItemsPage: vi.fn(async () => {}), refreshGoodsMenuCount: vi.fn(async () => {}),
        });
        const first = context.api.saveItem();
        await context.api.saveItem();
        context.api.setDraft({ id: 'other', name: 'Changed while awaiting', price: 999, stockLevel: 99 });
        expect(context.api.state().savingItem).toBe(true);
        pending.resolve();
        await first;
        expect(updateProductFields).toHaveBeenCalledTimes(1);
        expect(updateProductFields.mock.calls[0][0]).toMatchObject({ id: 'item-1', name: 'Submitted item' });
        expect(setStockLevel).toHaveBeenCalledWith('item-1', 7, 3);
        expect(context.api.state().savingItem).toBe(false);
    });

    it('accurately reports partial details save and refreshes the retry stock baseline', async () => {
        const fresh = { id: 'item-1', name: 'Submitted item', price: 100, categoryId: 'cat', stockLevel: 4, updatedAt: 'fresh' };
        const context = runHandlers('items', ['saveItem'], itemPrefix, itemApi, {
            updateProductFields: vi.fn(async () => {}), setStockLevel: vi.fn(async () => { throw new Error('Stock conflict'); }),
            getProductsByIds: vi.fn(async () => [fresh]), toPounds: (p: number) => p / 100,
            loadItemsPage: vi.fn(async () => {}), refreshGoodsMenuCount: vi.fn(async () => {}),
        });
        await context.api.saveItem();
        expect(context.api.state().itemSaveWarning).toContain('Item details were saved');
        expect(context.api.state().itemSaveWarning).toContain('stock change was not confirmed');
        expect(context.api.state().originalItem.stockLevel).toBe(4);
        expect(context.api.state().currentItem.stockLevel).toBe(4);
        expect(context.api.state().showModal).toBe(true);
    });

    it('closes the stale item editor if the partial-save snapshot cannot be read', async () => {
        const context = runHandlers('items', ['saveItem'], itemPrefix, itemApi, {
            updateProductFields: vi.fn(async () => {}), setStockLevel: vi.fn(async () => { throw new Error('Stock failed'); }),
            getProductsByIds: vi.fn(async () => { throw new Error('Read failed'); }),
            loadItemsPage: vi.fn(async () => {}), refreshGoodsMenuCount: vi.fn(async () => {}),
        });
        await context.api.saveItem();
        expect(context.api.state().showModal).toBe(false);
        expect(context.api.state().itemSaveWarning).toContain('Reopen this item');
    });

    it('does not apply a generated PLU to another editor generation, even for the same item ID', async () => {
        const pending = deferred<string>();
        const lookup = vi.fn(() => pending.promise);
        const context = runHandlers('items', ['generateScalePlu'], itemPrefix + 'let selectedPluLength=5;',
            `generateScalePlu, replace:()=>{itemDraftVersion++;currentItem={id:'item-1',scalePlu:'manual'};generatingPlu=false;}, state:()=>currentItem`,
            { findNextAvailableScalePlu: lookup });
        const first = context.api.generateScalePlu();
        await context.api.generateScalePlu();
        context.api.replace();
        pending.resolve('12345');
        await first;
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(context.api.state().scalePlu).toBe('manual');
    });

    it('applies a generated PLU only to the original open draft', async () => {
        const context = runHandlers('items', ['generateScalePlu'], itemPrefix + 'let selectedPluLength=5;',
            'generateScalePlu, state:()=>({currentItem,generatingPlu})', { findNextAvailableScalePlu: vi.fn(async () => '12345') });
        await context.api.generateScalePlu();
        expect(context.api.state().currentItem.scalePlu).toBe('12345');
        expect(context.api.state().generatingPlu).toBe(false);
    });

    it('prevents duplicate Goods Menu submission and editing during a delayed commit', async () => {
        const pending = deferred();
        const batch = vi.fn(() => pending.promise);
        const context = runHandlers('items', ['normalizeGoodsMenuOrder', 'toggleGoodsMenuItem', 'moveGoodsMenuItem', 'saveGoodsMenu'], `
let savingGoods=false, goodsMenuLoading=false, showGoodsMenu=true;
let goodsMenuSelected=[{id:'one',name:'One',showInGoods:true,goodsSortOrder:1}];
let availableGoodsDraft=[], goodsMenuOriginal=new Map([['one',{showInGoods:false,goodsSortOrder:0}]]);
function availableMatchesSearch(){return true;}
`, 'saveGoodsMenu, toggleGoodsMenuItem, state:()=>({savingGoods,goodsMenuSelected})', {
            batchUpdateGoodsMenu: batch, loadItemsPage: vi.fn(async () => {}), refreshGoodsMenuCount: vi.fn(async () => {}),
        });
        const first = context.api.saveGoodsMenu();
        await context.api.saveGoodsMenu();
        context.api.toggleGoodsMenuItem({ id: 'two', name: 'Two', showInGoods: false });
        expect(context.api.state().goodsMenuSelected).toHaveLength(1);
        pending.resolve();
        await first;
        expect(batch).toHaveBeenCalledTimes(1);
        expect(context.api.state().savingGoods).toBe(false);
    });

    it('prevents duplicate supplier rows and captures an immutable submitted draft', async () => {
        const pending = deferred();
        const upsert = vi.fn(() => pending.promise);
        const context = runHandlers('suppliers', ['save'], `
let cur={id:'supplier-1',name:' Original '}, editing=false, saving=false, show=true;
let $suppliersDB=[];
const suppliersDB={update:(work:any)=>$suppliersDB=work($suppliersDB)};
`, 'save, mutate:()=>cur.name="Changed", state:()=>({saving,rows:$suppliersDB})', { upsert, loadPage: vi.fn(async () => {}) });
        const first = context.api.save();
        await context.api.save();
        context.api.mutate();
        pending.resolve();
        await first;
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(context.api.state().rows).toHaveLength(1);
        expect(context.api.state().rows[0].name).toBe('Original');
    });

    it('keeps a failed supplier draft and clears its busy state for an intentional retry', async () => {
        const context = runHandlers('suppliers', ['save'], `let cur={id:'one',name:'Supplier'},editing=false,saving=false,show=true;`,
            'save,state:()=>({saving,show,cur})', { upsert: vi.fn(async () => { throw new Error('Failed'); }) });
        await context.api.save();
        expect(context.api.state()).toMatchObject({ saving: false, show: true, cur: { name: 'Supplier' } });
    });

    it('sends one frozen tax snapshot instead of partially committing per-row writes', async () => {
        const pending = deferred();
        const saveTaxRateSnapshot = vi.fn((..._args: any[]) => pending.promise);
        const context = runHandlers('tax-rates', ['save'], `
let saving=false,cur={id:'new',name:' New ',isDefault:true},ratePercent=5,editing=false,show=true;
let expectedRates=[{id:'old',name:'Old',rate:0.2,isDefault:true}];
`, 'save,mutate:()=>{cur.name="Changed";expectedRates[0].name="Changed";},state:()=>({saving,show})', { saveTaxRateSnapshot });
        const first = context.api.save();
        await context.api.save();
        context.api.mutate();
        pending.resolve();
        await first;
        expect(saveTaxRateSnapshot).toHaveBeenCalledTimes(1);
        expect(saveTaxRateSnapshot.mock.calls[0][0]).toMatchObject({ name: 'New', rate: 0.05, isDefault: true });
        expect(saveTaxRateSnapshot.mock.calls[0][1][0].name).toBe('Old');
        expect(context.api.state()).toMatchObject({ saving: false, show: false });
    });

    it('ignores a delayed supplier page after a newer search completes', async () => {
        const first = deferred<{ rows: any[]; total: number }>();
        const getSuppliersPage = vi.fn().mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce({ rows: [{ id: 'new', name: 'New result' }], total: 1 });
        const context = runHandlers('suppliers', ['loadPage'], `let loadVersion=0,mounted=true,loading=false,loadError='',rows=[],total=0,appliedSearch='old',page=0; const PAGE_SIZE=25;`,
            'loadPage,search:()=>appliedSearch="new",state:()=>({rows,total,loading})', { getSuppliersPage });
        const oldLoad = context.api.loadPage();
        context.api.search();
        await context.api.loadPage();
        first.resolve({ rows: [{ id: 'old' }], total: 200 });
        await oldLoad;
        expect(context.api.state()).toMatchObject({ rows: [{ id: 'new' }], total: 1, loading: false });
    });
});

const scalePrefix = `
let pages=[{id:'old',productIds:['old-product']},{id:'new',productIds:['new-product','missing-product']}];
let activePageId='new', activePage=pages[1], selectedProducts=[{id:'old-product',name:'Old'}];
let selectedLoading=false,selectedError='',selectedLoadVersion=0, saveBusy=false,dirty=false;
let availableProducts=[];
function scheduleAvailableSearch() {};
`;

describe('scale assignments and unsaved exit', () => {
    it('blocks Add while the selected page is loading', () => {
        const context = runHandlers('design/scale', ['add', 'commitSelectedIds'], scalePrefix + 'selectedLoading=true;',
            'add,state:()=>pages');
        context.api.add({ id: 'available' });
        expect(context.api.state()[1].productIds).toEqual(['new-product', 'missing-product']);
    });

    it('uses canonical page IDs for Add, retaining missing assignments and excluding stale display rows', () => {
        const context = runHandlers('design/scale', ['add', 'commitSelectedIds'], scalePrefix,
            'add,state:()=>pages');
        context.api.add({ id: 'available' });
        expect(context.api.state()[1].productIds).toEqual(['new-product', 'missing-product', 'available']);
        expect(context.api.state()[1].productIds).not.toContain('old-product');
    });

    it('ignores a delayed selected-page read after a subsequent page switch', async () => {
        const pending = deferred<any[]>();
        const context = runHandlers('design/scale', ['loadSelectedProducts'], scalePrefix,
            `loadSelectedProducts,switchPage:()=>{activePageId='old';},state:()=>({selectedProducts,selectedLoading})`,
            { getProductsByIds: vi.fn(() => pending.promise) });
        const first = context.api.loadSelectedProducts(['new-product'], 'new');
        expect(context.api.state().selectedProducts).toHaveLength(0);
        context.api.switchPage();
        pending.resolve([{ id: 'new-product' }]);
        await first;
        expect(context.api.state().selectedProducts).toHaveLength(0);
    });

    it('requests confirmation rather than immediately discarding a dirty Reload Latest', () => {
        const applyLatestLayout = vi.fn();
        const context = runHandlers('design/scale', ['reloadLatestLayout'], `let saveBusy=false,dirty=true,pendingExit=null,showUnsavedDialog=false;`,
            'reloadLatestLayout,state:()=>({dirty,pendingExit,showUnsavedDialog})', { applyLatestLayout });
        context.api.reloadLatestLayout();
        expect(applyLatestLayout).not.toHaveBeenCalled();
        expect(context.api.state()).toMatchObject({ dirty: true, pendingExit: { kind: 'reload' }, showUnsavedDialog: true });
    });

    it('cancels dirty internal navigation and offers the three-way exit instead of discarding', () => {
        const script = routeSource('design/scale').split('<script lang="ts">')[1].split('</script>')[0];
        const ast = ts.createSourceFile('scale.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const registration = ast.statements.find(statement => ts.isExpressionStatement(statement)
            && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === 'beforeNavigate');
        expect(registration).toBeDefined();
        let callback: any;
        const context = { beforeNavigate: (handler: any) => callback = handler, api: undefined as any };
        runInNewContext(ts.transpile(`let allowNavigation=false,dirty=true,saveBusy=false,pendingExit=null,showUnsavedDialog=false;${registration!.getText(ast)};api=()=>({pendingExit,showUnsavedDialog});`, { target: ts.ScriptTarget.ES2022 }), context);
        const cancel = vi.fn();
        callback({ cancel, willUnload: false, to: { url: new URL('http://localhost/design') } });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(context.api()).toMatchObject({ pendingExit: { kind: 'navigate', url: 'http://localhost/design' }, showUnsavedDialog: true });
    });

    it('does not navigate away when Save Changes fails', async () => {
        const goto = vi.fn();
        const context = runHandlers('design/scale', ['finishExit'], `let saveBusy=false,pendingExit={kind:'navigate',url:'/design'},showUnsavedDialog=true,dirty=true,allowNavigation=false,pages=[];`,
            'finishExit,state:()=>({dirty,showUnsavedDialog,allowNavigation})', { save: vi.fn(async () => false), goto });
        await context.api.finishExit(true);
        expect(goto).not.toHaveBeenCalled();
        expect(context.api.state()).toMatchObject({ dirty: true, showUnsavedDialog: true, allowNavigation: false });
    });

    it('performs explicit Discard and allows the requested navigation', async () => {
        const goto = vi.fn(async () => {});
        const context = runHandlers('design/scale', ['finishExit'], `let saveBusy=false,pendingExit={kind:'navigate',url:'/design'},showUnsavedDialog=true,dirty=true,allowNavigation=false,pages=[];`,
            'finishExit,state:()=>({dirty,showUnsavedDialog,allowNavigation})', { goto });
        await context.api.finishExit(false);
        expect(goto).toHaveBeenCalledWith('/design');
        expect(context.api.state()).toMatchObject({ dirty: false, showUnsavedDialog: false, allowNavigation: true });
    });
});

describe('label system printing and bounded searches', () => {
    it('keeps label quantities after the system print dialog returns without a result', async () => {
        const clearSelected = vi.fn();
        const context = runHandlers('label-print', ['printLabels'], `
let totalLabels=3,printingLabels=false,labelPrinter={enabled:true},printerReady=true,systemPrintMode=true;
let selectedProducts=[{product:{id:'one',name:'One'},quantity:3}],printSheetProducts=[];
`, 'printLabels,state:()=>({printingLabels,selectedProducts,printSheetProducts})', {
            tick: async () => {}, window: { print: vi.fn() }, clearSelected,
        });
        await context.api.printLabels();
        expect(clearSelected).not.toHaveBeenCalled();
        expect(context.api.state().selectedProducts[0].quantity).toBe(3);
        expect(context.api.state().printingLabels).toBe(false);
        expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('Selected labels were kept'), 'info');
    });

    it('keeps label quantities if the system dialog cannot open', async () => {
        const context = runHandlers('label-print', ['printLabels'], `
let totalLabels=2,printingLabels=false,labelPrinter={enabled:true},printerReady=true,systemPrintMode=true;
let selectedProducts=[{product:{id:'one'},quantity:2}],printSheetProducts=[];
`, 'printLabels,state:()=>selectedProducts', { tick: async () => {}, window: { print: () => { throw new Error('No print service'); } } });
        await context.api.printLabels();
        expect(context.api.state()[0].quantity).toBe(2);
    });

    it('queries later label result pages and reports capped totals', async () => {
        const getProductsPage = vi.fn(async () => ({ rows: [{ id: 'item-101' }], total: 1000, totalIsCapped: true }));
        const context = runHandlers('label-print', ['loadProductMatches'], `let productPage=1,productLoadToken=0,productsLoading=false,productLoadError='',mounted=true,matches=[],productTotal=0,productTotalCapped=false; const PRODUCT_PAGE_SIZE=100;`,
            'loadProductMatches,state:()=>({matches,productTotal,productTotalCapped})', { getProductsPage });
        await context.api.loadProductMatches('item');
        expect(getProductsPage).toHaveBeenCalledWith({ query: 'item', status: 'active', limit: 100, offset: 100 });
        expect(context.api.state()).toMatchObject({ productTotal: 1000, productTotalCapped: true });
    });

    it('does not select a stale scanned label search after the query changes', async () => {
        const pending = deferred<any[]>();
        const selectProduct = vi.fn();
        const context = runHandlers('label-print', ['handleSearchKeydown'], `let printingLabels=false,productSearchTimer=null,search='old',searchSelectionToken=0,productPage=0,mounted=true;`,
            'handleSearchKeydown,change:()=>{search="new";searchSelectionToken++;}',
            { loadProductMatches: vi.fn(() => pending.promise), selectProduct });
        const first = context.api.handleSearchKeydown({ key: 'Enter', preventDefault: vi.fn(), repeat: false });
        context.api.change();
        pending.resolve([{ id: 'old', barcode: 'old', isActive: true }]);
        await first;
        expect(selectProduct).not.toHaveBeenCalled();
    });

    it('pages scale catalogue matches before hiding assigned IDs, retaining a way to reach later products', async () => {
        const getProductsPage = vi.fn(async () => ({ rows: [{ id: 'assigned' }, { id: 'item-101' }], total: 201, totalIsCapped: false }));
        const context = runHandlers('design/scale', ['loadAvailableProducts'], `let availableLoadVersion=0,availableLoading=false,availableError='',availablePage=1,search='',availableProducts=[],availableRawCount=0,availableTotal=0,availableTotalCapped=false;const AVAILABLE_PAGE_SIZE=100;let assignedProductIds=new Set(['assigned']);`,
            'loadAvailableProducts,state:()=>({availableProducts,availableRawCount,availableTotal})', { getProductsPage });
        await context.api.loadAvailableProducts();
        expect(getProductsPage).toHaveBeenCalledWith({ query: '', status: 'active', weighableOnly: true, limit: 100, offset: 100 });
        expect(context.api.state().availableProducts).toEqual([{ id: 'item-101' }]);
        expect(context.api.state().availableRawCount).toBe(2);
        expect(context.api.state().availableTotal).toBe(201);
    });

    it('wires modal focus trapping, busy dismissal guards and a fixed Add Page action', () => {
        const items = routeSource('items');
        expect(items).toContain('use:modalFocusTrap={{ dismiss: closeItemEditor, dismissDisabled: savingItem || imageUploading }}');
        expect(items).toContain('use:modalFocusTrap={{ dismiss: closeGoodsMenu, dismissDisabled: savingGoods }}');
        expect(items).toContain('height: min(700px, calc(100dvh - 2rem))');
        const scale = routeSource('design/scale');
        expect(scale.indexOf('class="add-scale-page"')).toBeGreaterThan(scale.indexOf('<div class="scale-page-actions">'));
        expect(scale).toContain('beforeNavigate(navigation =>');
        expect(scale).toContain('Unsaved Scale layout');
        expect(scale).toContain('Assigned items are hidden.');
        expect(routeSource('suppliers')).toContain('getSuppliersPage({ query: appliedSearch, limit: PAGE_SIZE, offset: page * PAGE_SIZE })');
    });
});

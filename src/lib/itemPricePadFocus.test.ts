import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function fixture() {
    const source = readFileSync('src/routes/items/+page.svelte', 'utf8');
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
    const tree = ts.createSourceFile('items.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = ['closePricePad', 'handlePricePadKey'];
    const handlers = tree.statements.filter(node => ts.isFunctionDeclaration(node)
        && names.includes(node.name?.text || '')).map(node => node.getText(tree));
    expect(handlers).toHaveLength(names.length);
    let release!: () => void;
    const render = new Promise<void>(resolve => { release = resolve; });
    const opener = { isConnected: true, focus: vi.fn() };
    const context = { tick: () => render, opener, api: undefined as any };
    runInNewContext(ts.transpile(`
        let showModal=true, showPricePad=true, itemDraftVersion=1, pricePadOpener=opener;
        let priceString='123',currentItem={price:100};
        const MAX_ITEM_PRICE_PENCE=999999999,MAX_ITEM_PRICE_DIGITS=9;
        ${handlers.join('\n')}
        api={closePricePad,handlePricePadKey,state:()=>({showModal,showPricePad,currentItem}),
            closeParent:()=>{showModal=false;itemDraftVersion++;},
            replaceDraft:()=>{itemDraftVersion++;},reopenPad:()=>{showPricePad=true;}};
    `, { target: ts.ScriptTarget.ES2022 }), context);
    return { api: context.api, opener, release, source };
}

describe('native item price pad opener restoration', () => {
    it('restores Selling Price after the nested scope is removed, without closing the editor', async () => {
        const test = fixture();
        const closed = test.api.closePricePad();
        expect(test.api.state()).toMatchObject({ showModal: true, showPricePad: false });
        expect(test.opener.focus).not.toHaveBeenCalled();
        test.release();
        await closed;
        expect(test.opener.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(test.source).toContain('bind:this={pricePadOpener}');
        expect(test.source).toContain('use:modalFocusTrap={{ dismiss: closePricePad }}');
    });
    it('also returns focus to the opener after confirming the price', async () => {
        const test = fixture();
        test.api.handlePricePadKey('ENTER');
        test.release();
        await vi.waitFor(() => expect(test.opener.focus).toHaveBeenCalledOnce());
        expect(test.api.state()).toMatchObject({ showModal: true, showPricePad: false, currentItem: { price: 123 } });
    });
    it.each(['closeParent', 'replaceDraft', 'reopenPad'])('does not steal focus after %s', async change => {
        const test = fixture();
        const closed = test.api.closePricePad();
        test.api[change]();
        test.release();
        await closed;
        expect(test.opener.focus).not.toHaveBeenCalled();
    });
    it('does not focus a removed opener', async () => {
        const test = fixture();
        const closed = test.api.closePricePad();
        test.opener.isConnected = false;
        test.release();
        await closed;
        expect(test.opener.focus).not.toHaveBeenCalled();
    });
});

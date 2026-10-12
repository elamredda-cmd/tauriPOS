import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CATALOGUE_INTEGRITY_MIGRATION, catalogueCategoryUsageSql, catalogueDeletionError, catalogueIntegrityTriggerSql, catalogueTaxDefaultInitializationSql, removeCatalogueWithAuthority } from './catalogueIntegrity';

describe('authoritative catalogue deletion', () => {
    it('uses integral native-decodable totals instead of unsupported MariaDB DECIMAL sums', () => {
        expect(catalogueCategoryUsageSql).toContain('CAST(COUNT(*) AS SIGNED) AS total');
        expect(catalogueCategoryUsageSql).toContain('CAST(SUM(CASE WHEN isActive = 1 THEN 1 ELSE 0 END) AS SIGNED) AS active');
        const source = readFileSync(new URL('./stores/database.ts', import.meta.url), 'utf8');
        expect(source).toContain('await server.select(catalogueCategoryUsageSql)');
    });
    it('does not delete locally or publish a tombstone when the server rejects eligibility', async () => {
        const removeLocally = vi.fn();
        const mirrorFailed = vi.fn();
        await expect(removeCatalogueWithAuthority({ shared: true,
            removeOnServer: async () => { throw new Error('CATALOGUE_INTEGRITY: This category is used by items'); },
            removeLocally, mirrorFailed,
        })).rejects.toThrow('used by items');
        expect(removeLocally).not.toHaveBeenCalled();
        expect(mirrorFailed).not.toHaveBeenCalled();
    });

    it('commits server-first and never requeues a confirmed deletion on mirror failure', async () => {
        const events: string[] = [];
        await removeCatalogueWithAuthority({ shared: true,
            removeOnServer: async () => { events.push('server'); },
            removeLocally: async () => { events.push('local'); throw new Error('cache busy'); },
            mirrorFailed: () => { events.push('refresh pending'); },
        });
        expect(events).toEqual(['server', 'local', 'refresh pending']);
    });

    it('keeps single-till rejection visible and never calls MariaDB', async () => {
        const removeOnServer = vi.fn();
        await expect(removeCatalogueWithAuthority({ shared: false, removeOnServer,
            removeLocally: async () => { throw new Error('used'); }, mirrorFailed: vi.fn(),
        })).rejects.toThrow('used');
        expect(removeOnServer).not.toHaveBeenCalled();
    });

    it('gives the operator the specific authoritative rejection', () => {
        expect(catalogueDeletionError(new Error('database: CATALOGUE_INTEGRITY: Choose another default'), 'Failed'))
            .toBe('Choose another default');
    });

    it('wires category usage failure as an explicit stop, not an empty count', () => {
        const source = readFileSync(new URL('../routes/categories/+page.svelte', import.meta.url), 'utf8');
        expect(source).toContain('const loaded = await loadCategoryUsage()');
        expect(source).toContain("if (!loaded) { toast(usageError, 'error'); return; }");
        expect(source).toContain('usageError = \'Could not check item usage.');
        expect(source).not.toContain('Could not clear the deleted default category');
    });

    it.each(['read failure', 'used category', 'unused category', 'default category'])('runs actual category handlers fail-closed: %s', async scenario => {
        const source = readFileSync(new URL('../routes/categories/+page.svelte', import.meta.url), 'utf8');
        const usageHandlers = source.slice(source.indexOf('    function categoryUsage('), source.indexOf('    async function save('));
        const confirmationHandler = source.slice(source.indexOf('    async function confirmDel('), source.indexOf('    async function handleDel('));
        const getCategoryUsageSummary = vi.fn(async () => {
            if (scenario === 'read failure') throw new Error('database unavailable');
            return scenario === 'used category' ? [{ categoryId: 'target', total: 2, active: 1, deactivated: 1 }] : [];
        });
        const context = { getCategoryUsageSummary, toast: vi.fn(), console: { warn: vi.fn() }, handlers: undefined as any };
        const code = `let categoryUsageById = new Map(); let usageLoading = false; let usageError = '';
            let checkingUsageId = ''; let deleting = false; let defaultCategoryId = ${JSON.stringify(scenario === 'default category' ? 'target' : '')};
            let idToDelete = ''; let showDelConfirm = false;
            ${usageHandlers}\n${confirmationHandler}
            handlers = { confirmDel, state: () => ({showDelConfirm, idToDelete, usageError}) };`;
        runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), context);
        await context.handlers.confirmDel('target');
        expect(context.handlers.state().showDelConfirm).toBe(scenario === 'unused category');
        if (scenario === 'read failure') expect(context.handlers.state().usageError).toContain('Could not check item usage');
        if (scenario === 'default category') expect(getCategoryUsageSummary).not.toHaveBeenCalled();
    });

    it('guards both parent tables, changed product references, defaults and standalone tombstones', () => {
        const sql = catalogueIntegrityTriggerSql().join('\n');
        for (const name of ['categories_delete', 'tax_rates_delete', 'products_insert', 'products_update', 'default_insert', 'default_update', 'tombstone_insert', 'tombstone_update']) {
            expect(sql).toContain(`pos_catalogue_${name}`);
        }
        expect(sql).toContain('LIMIT 1 FOR UPDATE');
        expect(sql).toContain('pos_catalogue_presence');
    });

    it('keeps indexed columns unchanged and validates collation metadata', () => {
        expect(catalogueIntegrityTriggerSql().join('\n')).toContain('id = CONVERT(NEW.categoryId USING utf8mb4) COLLATE utf8mb4_unicode_ci');
        expect(() => catalogueIntegrityTriggerSql([])).toThrow('Missing catalogue collation');
        expect(() => catalogueIntegrityTriggerSql([{ tableName: 'categories', columnName: 'id', charset: 'utf8mb4', collation: 'unsafe; SQL' }])).toThrow('Invalid catalogue collation');
    });

    it('guards default uniqueness across old clients without a same-table trigger read', () => {
        expect(CATALOGUE_INTEGRITY_MIGRATION).toBe('catalogue_integrity_v3');
        const taxTriggers = catalogueIntegrityTriggerSql().filter(sql => /TRIGGER pos_catalogue_tax_rates_/.test(sql));
        expect(taxTriggers).toHaveLength(3);
        for (const sql of taxTriggers) {
            expect(sql).toContain('FROM pos_tax_default_registry WHERE id = 1 FOR UPDATE');
            expect(sql).not.toMatch(/FROM tax_rates/);
        }
        expect(taxTriggers.join('\n')).toContain('Another tax rate is already default');
        expect(taxTriggers.join('\n')).toContain('catalogueTaxDefault USING utf8mb4');
        expect(catalogueTaxDefaultInitializationSql).toContain('(SELECT id FROM tax_rates WHERE isDefault = 1)');
        expect(catalogueTaxDefaultInitializationSql).not.toMatch(/LIMIT|MIN\(|MAX\(|UPDATE|IGNORE/);
    });

    it('labels only server-confirmed catalogue tombstones as authoritative cache deletes', () => {
        const source = readFileSync(new URL('./stores/database.ts', import.meta.url), 'utf8');
        const start = source.indexOf('async function applyTombstoneRows(');
        const sync = source.slice(start, source.indexOf('async function applyTombstones(', start));
        expect(sync).toContain("['categories', 'tax_rates'].includes(t.table_name) ? { authoritativeCatalogueDelete: true }");
        expect(sync).not.toContain('queueId');
    });
});

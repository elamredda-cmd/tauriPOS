import { describe, expect, it } from 'vitest';
import { canCancelSetup, sameMysqlTarget } from './setupSafety';
describe('setup maintenance safety', () => {
    const cfg = { host: 'ShopHost', port: 3306, database: 'pos', user: 'pos_app', password: 'fixture' };
    it('recognizes the same target independently of credential updates', () => {
        expect(sameMysqlTarget(cfg, { ...cfg, host: ' shophOSt ', password: 'updated' })).toBe(true);
        expect(sameMysqlTarget(cfg, { ...cfg, database: 'other' })).toBe(false);
        expect(sameMysqlTarget(null, cfg)).toBe(false);
    });
    it('allows non-mutating return only for a configured authenticated administrator', () => {
        const safe = { configured: true, activeAdmin: true, pendingRestore: false, committing: false, adminRecovery: false };
        expect(canCancelSetup(safe)).toBe(true);
        for (const unsafe of [ { configured: false }, { activeAdmin: false }, { pendingRestore: true }, { committing: true }, { adminRecovery: true } ]) {
            expect(canCancelSetup({ ...safe, ...unsafe })).toBe(false);
        }
    });
});

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { get, writable } from 'svelte/store';
import { sameMysqlTarget } from './setupSafety';
import { createSyncStartupRecovery } from './syncStartupRecovery';
import type { PosConnectionState } from './stores/connection';

/** Run the actual route's async handler with isolated fallible services, not a duplicate implementation. */
function handler(name: string, state: string, services: Record<string, unknown>, path = 'src/routes/settings/advanced/+page.svelte', fields = 'checkingSchemas, refreshingConflicts, busy, schemaStatus, conflictStatus, syncConflicts') {
    const source = readFileSync(path, 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
    const tree = ts.createSourceFile('settings.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const node = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
    const js = ts.transpileModule(`${state}\n${node.getText(tree)}\nreturn {run: ${name}, state: () => ({${fields}})};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return Function(...Object.keys(services), js)(...Object.values(services));
}
const initial = `let checkingSchemas=false, refreshingConflicts=false, busy=false, schemaStatus='', conflictStatus='', syncConflicts=[{id:'kept'}];`;

describe('maintenance handler failure feedback', () => {
    it('finishes a rejected schema check with retry guidance', async () => {
        const route = handler('validateSchemas', initial, { validateDatabaseSchemas: vi.fn(async () => { throw Error('offline'); }), cleanError: String });
        await route.run();
        expect(route.state().checkingSchemas).toBe(false);
        expect(route.state().schemaStatus).toContain('Database check failed');
        expect(route.state().schemaStatus).toContain('retry');
    });
    it('keeps conflicts visible and finishes the busy state when refresh fails', async () => {
        const route = handler('refreshConflicts', initial, { getSyncConflicts: vi.fn(async () => { throw Error('query'); }), cleanError: String });
        await route.run();
        expect(route.state().refreshingConflicts).toBe(false);
        expect(route.state().syncConflicts).toEqual([{id:'kept'}]);
        expect(route.state().conflictStatus).toContain('Press Refresh to retry');
    });
    it('keeps the conflict and reports a rejected dismissal', async () => {
        const notify = vi.fn();
        const route = handler('performConflictDismiss', initial, { isRetainedLocalSaleConflict: () => false,
            dismissSyncConflict: vi.fn(async () => { throw Error('blocked'); }), refreshConflicts: vi.fn(), cleanError: String, toast: notify });
        await route.run({id:'kept'});
        expect(route.state().busy).toBe(false);
        expect(route.state().syncConflicts).toEqual([{id:'kept'}]);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('conflict is kept'), 'error');
    });
    it('suppresses repeated schema and conflict refresh calls while pending', async () => {
        let finish!: () => void;
        const service = vi.fn(() => new Promise<void>(resolve => { finish=resolve; }).then(() => ({ok: true})));
        const route = handler('validateSchemas', initial, { validateDatabaseSchemas: service, cleanError: String });
        const first=route.run(); await route.run();
        expect(service).toHaveBeenCalledTimes(1); finish(); await first;
    });
});

describe('hardware test single-flight handlers', () => {
    it.each([
        ['testReceiptPrinter', 'sendReceiptPrinterTest', 'testingReceipt', 'receiptTestStatus'],
        ['testLabelPrinter', 'sendLabelPrinterTest', 'testingLabel', 'labelTestStatus'],
        ['testDrawer', 'openCashDrawer', 'testingDrawer', 'drawerTestStatus'],
    ])('guards %s while pending and finishes after a hardware failure', async (name, serviceName, flag, status) => {
        let fail!: (error: Error) => void;
        const hardware=vi.fn(() => new Promise((_, reject) => { fail=reject; }));
        const route=handler(name, `let ${flag}=false, ${status}=''; const receipt={devicePath:'fixture'}, label={devicePath:'fixture'}, drawer={devicePath:'fixture'};`,
            {[serviceName]:hardware, toast:vi.fn()}, 'src/routes/settings/printers/+page.svelte', `${flag}, ${status}`);
        const first=route.run(); await route.run();
        expect(hardware).toHaveBeenCalledTimes(1);
        expect(route.state()[flag]).toBe(true);
        fail(Error('offline')); await first;
        expect(route.state()[flag]).toBe(false);
        expect(route.state()[status]).toMatch(/failed/i);
    });
});

describe('provider read failure feedback', () => {
    it('keeps provider read failures separate from missing setup', async () => {
        const route=handler('refreshProviders', 'let providersLoading=true, sumupLoadError=false, dojoLoadError=false, sumupConfig=null, dojoConfig=null;',
            {loadSumupConfig:async () => { throw Error('read'); }, loadDojoConfig:async () => ({ready:false,enabled:false}), console:{warn:vi.fn()}},
            'src/routes/settings/payments/+page.svelte', 'providersLoading, sumupLoadError, dojoLoadError, sumupConfig, dojoConfig');
        await route.run();
        expect(route.state().providersLoading).toBe(false);
        expect(route.state().sumupLoadError).toBe(true);
        expect(route.state().dojoLoadError).toBe(false);
    });
});

describe('actual setup reconnect-only handler', () => {
    const cfg={host:'test.invalid',port:3306,user:'fixture',password:'fixture',database:'fixture'};
    const before: PosConnectionState={mode:'multi',mysqlConfig:cfg,mysqlOnline:true,mysqlReady:true,mysqlStatus:'online',syncError:null};
    const awaitingRevalidation={...before,mysqlOnline:false,mysqlReady:false,mysqlStatus:'pending'};
    function isolatedSetup(probe: boolean, qa = false) {
        const state=writable<PosConnectionState>({...before,mysqlConfig:{...cfg}});
        const events: string[]=[];
        const bootstrap={ forcePushToServer:vi.fn(), wipeAndPullFromServer:vi.fn(), migrateLocalDataToServer:vi.fn(), replaceMariaDbDataFromThisTill:vi.fn(), initMysqlDb:vi.fn() };
        const gates={epoch:vi.fn(async () => {events.push('epoch');}),financial:vi.fn(async () => {events.push('financial');}),
            backgroundStop:vi.fn(),onReady:vi.fn(() => {events.push('ready');expect(get(state).mysqlReady).toBe(true);})};
        const services={connectionState:state,get,buildConfig:() => cfg,testMysqlConnection:vi.fn(async () => {events.push('probe');return probe;}),resetMysqlConnection:vi.fn(),
            captureConnectionSettings:vi.fn(async () => {events.push('capture');return { rows: [{ key:'pos_mode',value:get(state).mode,updatedAt:'before' }] };}),
            restoreConnectionSettings:vi.fn(async () => undefined),nativeQaEnabled:qa,nativeQaCheckpoint:vi.fn(async () => undefined),
            verifyDatabaseIdentityBeforeSchemaMutation:vi.fn(async () => {events.push('preflight');}),sameMysqlTarget,
            ensureDatabaseIdentityForSync:vi.fn(async () => {events.push('identity');}),
            getMysqlDb:vi.fn(async () => ({})),saveMode:vi.fn(async () => {events.push('save');
                state.update(value => ({...value,mode:'multi',mysqlConfig:{...cfg},mysqlOnline:false,mysqlReady:false,mysqlStatus:'pending',syncError:null}));}),
            startBackgroundSync:vi.fn(async () => {events.push('background');expect(get(state).mysqlReady).toBe(false);}),
            setSetupProgress:vi.fn(),cleanError:String,goto:vi.fn(async () => {events.push('navigate');}),...bootstrap};
        // Exercise the real recovery coordinator. The already-ready runtime
        // has an accepted schema checkpoint before setup suspends it; no fake
        // "ready" result is supplied to the extracted handler.
        const coordinator=createSyncStartupRecovery({state,ops:{
            identityPreflight:services.verifyDatabaseIdentityBeforeSchemaMutation,
            schema:bootstrap.initMysqlDb,identity:services.ensureDatabaseIdentityForSync,
            epoch:gates.epoch,financial:gates.financial,backgroundStart:services.startBackgroundSync,
            backgroundStop:gates.backgroundStop,onReady:gates.onReady,
        }});
        void coordinator.start(cfg);
        const syncStartupRecovery={
            suspend:vi.fn(() => {events.push('suspend');const resume=coordinator.suspend();return () => {events.push('resume');resume();};}),
            waitForIdle:vi.fn(async () => {events.push('wait-idle');await coordinator.waitForIdle();}),
            start:vi.fn(async (candidate: typeof cfg) => {events.push('startup');await coordinator.start(candidate);}),
        };
        const route=handler('handleConnect', "let connecting=false,testResult='idle',reconnectOnly=true,restoreNotice=null;",
            {...services,syncStartupRecovery},'src/routes/setup/+page.svelte','connecting, testResult');
        return {route,state,services,bootstrap,syncStartupRecovery,gates,events,coordinator};
    }
    it('reconnects the existing target without import, repair or cache replacement', async () => {
        const test=isolatedSetup(true);
        await test.route.run();
        for (const call of Object.values(test.bootstrap)) expect(call).not.toHaveBeenCalled();
        expect(test.services.saveMode).toHaveBeenCalledWith('multi',cfg);
        expect(test.services.goto).toHaveBeenCalledWith('/settings/advanced');
        expect(test.syncStartupRecovery.suspend).toHaveBeenCalledTimes(1);
        expect(test.syncStartupRecovery.waitForIdle).toHaveBeenCalledTimes(1);
        expect(test.syncStartupRecovery.start).toHaveBeenCalledWith(cfg);
        expect(test.gates.epoch).toHaveBeenCalledTimes(1);
        expect(test.gates.financial).toHaveBeenCalledTimes(1);
        expect(test.events.filter(event => ['suspend','wait-idle','capture','probe','save','startup','epoch','financial','background','ready','navigate','resume'].includes(event)))
            .toEqual(['suspend','wait-idle','capture','probe','save','startup','epoch','financial','background','ready','navigate','resume']);
        expect(get(test.state)).toMatchObject({mysqlOnline:true,mysqlReady:true,mysqlStatus:'online',syncError:null});
    });
    it('retains the previous connection when candidate probing fails', async () => {
        const test=isolatedSetup(false);
        await test.route.run();
        expect(get(test.state)).toEqual(awaitingRevalidation);
        expect(test.services.saveMode).not.toHaveBeenCalled();
        expect(test.services.verifyDatabaseIdentityBeforeSchemaMutation).not.toHaveBeenCalled();
        for (const call of Object.values(test.bootstrap)) expect(call).not.toHaveBeenCalled();
        expect(test.syncStartupRecovery.start).not.toHaveBeenCalled();
        expect(test.events).toEqual(['suspend','wait-idle','capture','probe','resume']);
        expect(test.route.state()).toEqual({connecting:false,testResult:'fail'});
    });
    it('restores the durable snapshot after a native post-save rejection and recovers the UI', async () => {
        const test=isolatedSetup(true,true);
        test.services.nativeQaCheckpoint.mockRejectedValueOnce(Error('controlled post-save rejection'));
        await test.route.run();
        expect(test.services.saveMode).toHaveBeenCalledExactlyOnceWith('multi',cfg);
        expect(test.services.restoreConnectionSettings).toHaveBeenCalledWith({ rows:[{key:'pos_mode',value:'multi',updatedAt:'before'}] });
        expect(get(test.state)).toEqual(awaitingRevalidation);
        expect(test.services.goto).not.toHaveBeenCalled();
        expect(test.syncStartupRecovery.start).not.toHaveBeenCalled();
        expect(test.events.at(-1)).toBe('resume');
        expect(test.route.state()).toEqual({connecting:false,testResult:'fail'});
    });
    it('restores the no-credentials snapshot when a configured standalone till fails after reconnect save', async () => {
        const test=isolatedSetup(true,true);
        const standalone={...before,mode:'single',mysqlConfig:null,mysqlReady:false};
        test.state.set(standalone as any);
        test.services.nativeQaCheckpoint.mockRejectedValueOnce(Error('controlled post-save rejection'));
        await test.route.run();
        expect(test.services.restoreConnectionSettings).toHaveBeenCalledWith({ rows:[{key:'pos_mode',value:'single',updatedAt:'before'}] });
        expect(get(test.state)).toEqual({...standalone,mysqlOnline:false,mysqlReady:false,mysqlStatus:'online'});
        expect(test.services.startBackgroundSync).not.toHaveBeenCalled();
        expect(test.services.goto).not.toHaveBeenCalled();
    });
    it('blocks the till rather than publishing the old connection after rollback failure', async () => {
        const test=isolatedSetup(true,true);
        test.services.nativeQaCheckpoint.mockRejectedValueOnce(Error('controlled post-save rejection'));
        test.services.restoreConnectionSettings.mockRejectedValueOnce(Error('disk full'));
        await test.route.run();
        expect(get(test.state)).toMatchObject({mode:null,mysqlConfig:null,mysqlReady:false,mysqlStatus:'blocked'});
        expect(get(test.state).syncError).toContain('could not be restored');
        expect(test.services.startBackgroundSync).not.toHaveBeenCalled();
    });

    it('waits for an obsolete startup gate before probing or touching candidate configuration', async () => {
        const test=isolatedSetup(true);
        let finish!: () => void;
        test.syncStartupRecovery.waitForIdle.mockImplementationOnce(() => new Promise<void>(resolve => {finish=resolve;}));
        const pending=test.route.run();
        expect(test.syncStartupRecovery.suspend).toHaveBeenCalledTimes(1);
        expect(test.services.captureConnectionSettings).not.toHaveBeenCalled();
        expect(test.services.testMysqlConnection).not.toHaveBeenCalled();
        expect(test.services.resetMysqlConnection).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(test.services.testMysqlConnection).toHaveBeenCalledTimes(1);
        expect(test.events.at(-1)).toBe('resume');
    });

    it.each(['epoch','financial'] as const)('does not publish ready or navigate when the %s authority gate fails', async gate => {
        const test=isolatedSetup(true);
        test.gates[gate].mockRejectedValueOnce(Error(`controlled ${gate} recovery failure`));
        await test.route.run();
        expect(test.services.saveMode).toHaveBeenCalledExactlyOnceWith('multi',cfg);
        expect(test.services.restoreConnectionSettings).toHaveBeenCalledWith({rows:[{key:'pos_mode',value:'multi',updatedAt:'before'}]});
        expect(get(test.state)).toEqual(awaitingRevalidation);
        expect(test.gates.onReady).not.toHaveBeenCalled();
        expect(test.services.startBackgroundSync).not.toHaveBeenCalled();
        expect(test.services.goto).not.toHaveBeenCalled();
        expect(test.route.state()).toEqual({connecting:false,testResult:'fail'});
        expect(test.events.at(-1)).toBe('resume');
        if (gate==='epoch') expect(test.gates.financial).not.toHaveBeenCalled();
    });

    it('prevents an overlapping reconnect while safe startup remains pending', async () => {
        const test=isolatedSetup(true);
        let finish!: () => void;
        test.gates.financial.mockImplementationOnce(() => new Promise<void>(resolve => {finish=resolve;}));
        const pending=test.route.run();
        for (let pass=0;pass<32;pass++) await Promise.resolve();
        await test.route.run();
        expect(test.services.testMysqlConnection).toHaveBeenCalledTimes(1);
        expect(get(test.state).mysqlReady).toBe(false);
        expect(test.services.goto).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(test.gates.onReady).toHaveBeenCalledTimes(1);
        expect(test.events.filter(event => event==='resume')).toHaveLength(1);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const native = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: native.load } }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('shared MariaDB pool lifecycle', () => {
    const config = { host: 'fixture.invalid', port: 3306, user: 'fixture', password: 'fixture', database: 'fixture' };
    let connection: typeof import('./connection');
    let mysql: typeof import('./mysql');
    let pool: typeof import('./mysqlPool');
    let events: string[];

    const database = (uri: string, name = 'pool') => ({
        path: uri,
        select: vi.fn(async () => [{ reachable: 1 }]),
        close: vi.fn(async () => { events.push(`close:${name}`); }),
    });

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        native.load.mockReset();
        events = [];
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        connection = await import('./connection');
        mysql = await import('./mysql');
        pool = await import('./mysqlPool');
        connection.connectionState.set({ mode: 'multi', mysqlConfig: config,
            mysqlOnline: false, mysqlReady: false, mysqlStatus: 'pending', syncError: null });
        native.load.mockImplementation(async (uri: string) => {
            events.push('load:pool');
            return database(uri);
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('shares one in-flight load and cached instance across both public APIs', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        const opened = database(connection.buildMysqlUri(config));
        native.load.mockReturnValueOnce(loading.promise);
        const reachable = connection.getMysqlDb();
        const application = mysql.getDb();
        await vi.advanceTimersByTimeAsync(0);
        expect(native.load).toHaveBeenCalledOnce();
        loading.resolve(opened);
        expect(await reachable).toBe(opened);
        expect(await application).toBe(opened);
        expect(await connection.getMysqlDb()).toBe(opened);
        expect(await mysql.getDb()).toBe(opened);
        expect(native.load).toHaveBeenCalledOnce();
        expect(opened.select).toHaveBeenCalledExactlyOnceWith('SELECT 1');
        expect(opened.close).not.toHaveBeenCalled();
    });

    it('allows a cold LAN connection to take longer than the old 1.2 second budget', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        native.load.mockReturnValueOnce(loading.promise);
        const opening = mysql.getDb();
        const opened = database(connection.buildMysqlUri(config));
        await vi.advanceTimersByTimeAsync(2500);
        loading.resolve(opened);
        expect(await opening).toBe(opened);
    });

    it('keeps a healthy pool when an unrelated startup error marks mysqlOnline false', async () => {
        const opened = await mysql.getDb();
        connection.connectionState.update(state => ({ ...state, mysqlOnline: false,
            mysqlReady: false, syncError: 'Identity verification blocked startup' }));
        expect(await mysql.getDb()).toBe(opened);
        expect(await connection.getMysqlDb()).toBe(opened);
        expect(native.load).toHaveBeenCalledOnce();
        expect(get(connection.connectionState)).toMatchObject({ mysqlOnline: true,
            mysqlReady: false, mysqlStatus: 'pending', syncError: 'Identity verification blocked startup' });
    });

    it('retries after a failed native connection', async () => {
        native.load.mockRejectedValueOnce(Error('connection refused'));
        await expect(mysql.getDb()).rejects.toThrow('connection refused');
        expect(await mysql.getDb()).toBeTruthy();
        expect(native.load).toHaveBeenCalledTimes(2);
    });

    it('does not let retry overtake a timed-out native load or its cleanup', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        const old = database(connection.buildMysqlUri(config), 'late');
        native.load.mockImplementationOnce(() => { events.push('load:late'); return loading.promise; });
        const outcome = mysql.getDb().catch(error => error);
        await vi.advanceTimersByTimeAsync(pool.MYSQL_CONNECTION_TIMEOUT_MS);
        expect(await outcome).toEqual(Error('MariaDB connection timed out'));
        const retry = mysql.getDb();
        await vi.advanceTimersByTimeAsync(0);
        expect(native.load).toHaveBeenCalledOnce();
        loading.resolve(old);
        const current = await retry;
        expect(current).not.toBe(old);
        expect(events).toEqual(['load:late', 'close:late', 'load:pool']);
        expect(await mysql.getDb()).toBe(current);
        expect(old.select).not.toHaveBeenCalled();
    });

    it('also drains a timed-out verification query before opening its replacement', async () => {
        const verification = deferred<Array<{ reachable: number }>>();
        const old = database(connection.buildMysqlUri(config), 'query');
        old.select.mockReturnValueOnce(verification.promise);
        native.load.mockResolvedValueOnce(old);
        const outcome = mysql.getDb().catch(error => error);
        await vi.advanceTimersByTimeAsync(pool.MYSQL_CONNECTION_TIMEOUT_MS);
        expect(await outcome).toEqual(Error('MariaDB connection timed out'));
        const retry = mysql.getDb();
        await vi.advanceTimersByTimeAsync(0);
        expect(native.load).toHaveBeenCalledOnce();
        verification.resolve([{ reachable: 1 }]);
        expect(await retry).not.toBe(old);
        expect(events).toEqual(['close:query', 'load:pool']);
    });

    it('closes an obsolete in-flight load before a same-URI reset retry starts', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        const old = database(connection.buildMysqlUri(config), 'obsolete');
        native.load.mockImplementationOnce(() => { events.push('load:obsolete'); return loading.promise; });
        const outcome = mysql.getDb().catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        connection.resetMysqlConnection();
        const retry = mysql.getDb();
        expect(await outcome).toEqual(Error('MariaDB connection was reset while opening'));
        expect(native.load).toHaveBeenCalledOnce();
        loading.resolve(old);
        expect(await retry).not.toBe(old);
        expect(events).toEqual(['load:obsolete', 'close:obsolete', 'load:pool']);
    });

    it('suppresses stale config results when the URI changes during an open', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        const old = database(connection.buildMysqlUri(config), 'old-uri');
        native.load.mockReturnValueOnce(loading.promise);
        const obsolete = connection.getMysqlDb();
        await vi.advanceTimersByTimeAsync(0);
        const nextConfig = { ...config, host: 'next.invalid' };
        connection.connectionState.update(state => ({ ...state, mysqlConfig: nextConfig }));
        const current = mysql.getDb();
        expect(await obsolete).toBeNull();
        loading.resolve(old);
        expect((await current).path).toBe(connection.buildMysqlUri(nextConfig));
        expect(events).toEqual(['close:old-uri', 'load:pool']);
    });

    it('does not publish a stale open as online after switching to local-only mode', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        native.load.mockReturnValueOnce(loading.promise);
        const obsolete = connection.getMysqlDb();
        await vi.advanceTimersByTimeAsync(0);
        connection.connectionState.update(state => ({ ...state, mode: 'single', mysqlStatus: 'online', syncError: null }));
        loading.resolve(database(connection.buildMysqlUri(config)));
        expect(await obsolete).toBeNull();
        expect(get(connection.connectionState)).toMatchObject({ mode: 'single', mysqlOnline: false,
            mysqlReady: false, mysqlStatus: 'online', syncError: null });
    });

    it('serializes slow cached close and repeated resets before replacement load', async () => {
        const old = await mysql.getDb() as unknown as ReturnType<typeof database>;
        const closing = deferred<void>();
        old.close.mockImplementationOnce(async () => { events.push('close:start'); await closing.promise; events.push('close:end'); });
        connection.resetMysqlConnection();
        mysql.resetCachedConnection();
        const opening = connection.getMysqlDb();
        await vi.advanceTimersByTimeAsync(0);
        expect(native.load).toHaveBeenCalledOnce();
        closing.resolve();
        const replacement = await opening;
        expect(replacement).not.toBe(old);
        expect(events).toEqual(['load:pool', 'close:start', 'close:end', 'load:pool']);
        expect(old.close).toHaveBeenCalledOnce();
        expect(await mysql.getDb()).toBe(replacement);
    });

    it('rejects a cached mysql.getDb result if reset happens before its continuation', async () => {
        await mysql.getDb();
        const stale = mysql.getDb().catch(error => error);
        connection.resetMysqlConnection();
        expect(await stale).toEqual(Error('MariaDB connection was reset while opening'));
        expect(await mysql.getDb()).toBeTruthy();
        expect(native.load).toHaveBeenCalledTimes(2);
    });

    it('rejects a cached mysql.getDb result when another URI replaces it before its continuation', async () => {
        await mysql.getDb();
        const stale = mysql.getDb().catch(error => error);
        const nextConfig = { ...config, database: 'next' };
        const current = mysql.getDb(nextConfig);
        expect(await stale).toEqual(Error('MariaDB connection was reset while opening'));
        expect((await current).path).toBe(connection.buildMysqlUri(nextConfig));
        expect(native.load).toHaveBeenCalledTimes(2);
    });

    it('keeps no-config behavior and can reuse a cached pool through mysql.getDb()', async () => {
        connection.connectionState.update(state => ({ ...state, mysqlConfig: null }));
        expect(await connection.getMysqlDb()).toBeNull();
        await expect(mysql.getDb()).rejects.toThrow('no config provided');
        const opened = await mysql.getDb(config);
        expect(await mysql.getDb()).toBe(opened);
        expect(await connection.getMysqlDb()).toBeNull();
    });

    it('does not replace or close the live pool for a same-URI settings probe', async () => {
        const opened = await mysql.getDb();
        expect(await connection.testMysqlConnection(config)).toBe(true);
        expect(await mysql.getDb()).toBe(opened);
        expect(native.load).toHaveBeenCalledOnce();
        expect((opened as unknown as ReturnType<typeof database>).close).not.toHaveBeenCalled();
    });

    it('cleans up a separate candidate probe without disturbing the live pool', async () => {
        const opened = await mysql.getDb();
        const candidate = database(connection.buildMysqlUri({ ...config, database: 'candidate' }), 'candidate');
        native.load.mockResolvedValueOnce(candidate);
        expect(await connection.testMysqlConnection({ ...config, database: 'candidate' })).toBe(true);
        expect(candidate.close).toHaveBeenCalledOnce();
        expect(await mysql.getDb()).toBe(opened);
        expect((opened as unknown as ReturnType<typeof database>).close).not.toHaveBeenCalled();
    });

    it('does not report a stale same-URI settings probe as successful after reset', async () => {
        await mysql.getDb();
        const probing = connection.testMysqlConnection(config);
        connection.resetMysqlConnection();
        expect(await probing).toBe(false);
        expect(await mysql.getDb()).toBeTruthy();
        expect(native.load).toHaveBeenCalledTimes(2);
    });

    it('waits for a timed-out settings probe to settle and close before a same-URI load', async () => {
        const loading = deferred<ReturnType<typeof database>>();
        const late = database(connection.buildMysqlUri(config), 'probe');
        native.load.mockReturnValueOnce(loading.promise);
        const testing = connection.testMysqlConnection(config);
        await vi.advanceTimersByTimeAsync(pool.MYSQL_CONNECTION_TIMEOUT_MS);
        expect(await testing).toBe(false);
        const opening = mysql.getDb();
        await vi.advanceTimersByTimeAsync(0);
        expect(native.load).toHaveBeenCalledOnce();
        loading.resolve(late);
        expect(await opening).not.toBe(late);
        expect(events).toEqual(['close:probe', 'load:pool']);
    });

    it('keeps pending readiness and its startup error after successful heartbeat', async () => {
        connection.connectionState.update(state => ({ ...state, syncError: 'Startup timed out' }));
        expect(await connection.pingMysql()).toBe(true);
        expect(get(connection.connectionState)).toMatchObject({ mysqlOnline: true,
            mysqlReady: false, mysqlStatus: 'pending', syncError: 'Startup timed out' });
    });

    it('makes a heartbeat failure unready and drops the shared pool', async () => {
        const opened = await mysql.getDb() as unknown as ReturnType<typeof database>;
        connection.connectionState.update(state => ({ ...state, mysqlOnline: true, mysqlReady: true }));
        opened.select.mockRejectedValueOnce(Error('link interrupted'));
        expect(await connection.pingMysql()).toBe(false);
        expect(get(connection.connectionState)).toMatchObject({ mysqlOnline: false, mysqlReady: false, mysqlStatus: 'offline' });
        expect(await mysql.getDb()).not.toBe(opened);
        expect(opened.close).toHaveBeenCalledOnce();
    });

    it('does not allow a stale heartbeat failure to reset a newer same-URI pool', async () => {
        const old = await mysql.getDb() as unknown as ReturnType<typeof database>;
        const query = deferred<Array<{ reachable: number }>>();
        old.select.mockReturnValueOnce(query.promise);
        const ping = connection.pingMysql();
        await vi.advanceTimersByTimeAsync(0);
        connection.resetMysqlConnection();
        const replacement = await mysql.getDb();
        connection.connectionState.update(state => ({ ...state, mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online' }));
        query.reject(Error('old query failed'));
        expect(await ping).toBe(false);
        expect(await mysql.getDb()).toBe(replacement);
        expect(get(connection.connectionState)).toMatchObject({ mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online' });
        expect(native.load).toHaveBeenCalledTimes(2);
    });

    it('compares configuration exactly without treating changed credentials as the same connection', () => {
        expect(connection.sameMysqlConnectionConfig(config, { ...config })).toBe(true);
        for (const changed of [{ password: 'next' }, { host: 'next.invalid' }, { user: 'next' }, { port: 3307 }, { database: 'next' }]) {
            expect(connection.sameMysqlConnectionConfig(config, { ...config, ...changed })).toBe(false);
        }
        expect(connection.sameMysqlConnectionConfig(null, null)).toBe(true);
        expect(connection.sameMysqlConnectionConfig(config, null)).toBe(false);
    });
});

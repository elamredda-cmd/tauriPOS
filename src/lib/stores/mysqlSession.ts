import { invoke } from '@tauri-apps/api/core';
import type Database from '@tauri-apps/plugin-sql';

export async function withMysqlSession<T>(mysqlUri: string, purpose: 'report' | 'schema', operation: (database: Database) => Promise<T>): Promise<T> {
    const token = await invoke<string>('open_mysql_session', { mysqlUri, purpose });
    const database = {
        select: async <R>(sql: string, values: unknown[] = []): Promise<R> => {
            const result = await invoke<{ rows: R }>('query_mysql_session', { token, sql, values, select: true });
            return result.rows;
        },
        execute: async (sql: string, values: unknown[] = []) => invoke('query_mysql_session', { token, sql, values, select: false }),
    } as Database;
    try { return await operation(database); }
    finally {
        // Do not replace a useful query/migration error with a cleanup error.
        // The native idle-session reaper also releases abandoned connections.
        await invoke('close_mysql_session', { token }).catch(error => console.warn('Database session cleanup failed:', error));
    }
}

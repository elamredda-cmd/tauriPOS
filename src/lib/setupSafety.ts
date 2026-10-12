import type { MysqlConfig } from '$lib/stores/connection';

export function sameMysqlTarget(a: MysqlConfig | null, b: MysqlConfig): boolean {
    return Boolean(a && a.host.trim().toLowerCase() === b.host.trim().toLowerCase()
        && Number(a.port) === Number(b.port) && a.database === b.database && a.user === b.user);
}

export function canCancelSetup(options: {
    configured: boolean; activeAdmin: boolean; pendingRestore: boolean; committing: boolean;
    adminRecovery: boolean;
}): boolean {
    return options.configured && options.activeAdmin && !options.pendingRestore
        && !options.committing && !options.adminRecovery;
}

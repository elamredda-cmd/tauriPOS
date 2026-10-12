import { createSyncStartupRecovery } from '$lib/syncStartupRecovery';
import { connectionState } from './connection';
import { initMysqlDb } from './mysql';
import {
    ensureDatabaseIdentityForSync,
    hasRestorePendingMariaDbReplace,
    reconcileServerDataEpochBeforeFinancialRecovery,
    recoverOnlineFinancialIntent,
    RESTORE_PENDING_MARIADB_REPLACE_MESSAGE,
    startBackgroundSync,
    stopBackgroundSync,
    verifyDatabaseIdentityBeforeSchemaMutation,
} from './database';

/** One startup authority for launch, reconnect and the dashboard's retry. */
export const syncStartupRecovery = createSyncStartupRecovery({
    state: connectionState,
    ops: {
        identityPreflight: async () => {
            if (await hasRestorePendingMariaDbReplace()) {
                throw new Error(`MARIADB_RESTORE_MAINTENANCE: ${RESTORE_PENDING_MARIADB_REPLACE_MESSAGE}`);
            }
            await verifyDatabaseIdentityBeforeSchemaMutation();
        },
        schema: initMysqlDb,
        identity: ensureDatabaseIdentityForSync,
        epoch: reconcileServerDataEpochBeforeFinancialRecovery,
        financial: recoverOnlineFinancialIntent,
        backgroundStart: startBackgroundSync,
        backgroundStop: stopBackgroundSync,
        onError: (error) => console.warn('POS: MariaDB sync blocked/deferred:', error),
    },
});

import { getApp, getApps, initializeApp } from 'firebase/app';
import {
    getAuth,
    indexedDBLocalPersistence,
    inMemoryPersistence,
    setPersistence,
    signInAnonymously,
    signOut,
} from 'firebase/auth';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';
import {
    ensureDatabaseIdentityForSync,
    getConnectedTills,
    getDb,
    getOrdersPage,
    getReportSnapshot,
    type ReportSnapshot,
} from '$lib/stores/database';
import { getOrCreateOwnerAppPairingCode, getOwnerCloudConfig } from '$lib/ownerCloudConfig';
import { OWNER_CLOUD_DATA_CHANGED_EVENT, OWNER_CLOUD_STATUS_EVENT } from '$lib/ownerCloudEvents';

const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBD4CiLpjjZNfXnJm87NbYpkR-knpJZXMs',
    authDomain: 'lbj-pos-owner.firebaseapp.com',
    projectId: 'lbj-pos-owner',
    storageBucket: 'lbj-pos-owner.firebasestorage.app',
    messagingSenderId: '661219606167',
    appId: '1:661219606167:web:ddfabb115befbddf7f33d2',
};

const FULL_REFRESH_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const CHANGE_DEBOUNCE_MS = 4 * 1000;
const CLOSED_REPORT_OUTBOX_KEY = 'owner_closed_report_outbox_v1';

type CloudStatus = 'disabled' | 'connecting' | 'live' | 'offline' | 'error';

let fullRefreshTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let publishPromise: Promise<void> | null = null;
let reporterStarted = false;
let authPersistenceReady = false;

export interface OwnerClosedReportInput {
    reportId: string;
    businessDate: string;
    periodStart: string;
    periodEnd: string;
    scope: 'till' | 'system';
    tillId: string;
    tillName: string;
    closedById: string;
    closedByName: string;
    reportText: string;
    overview: {
        totalRevenue: number;
        totalTransactions: number;
        refundTransactions: number;
        avgTransactionValue: number;
        totalItemsSold: number;
    };
    breakdown: {
        totalCash: number;
        totalCard: number;
        totalLoyalty: number;
        unrecordedAmount: number;
        unrecordedTxCount: number;
    };
    topProducts: Array<{
        name: string;
        sku: string;
        qtySold: number;
        totalRevenue: number;
        avgPrice: number;
    }>;
}

function localDateKey(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function emitStatus(status: CloudStatus, message: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(OWNER_CLOUD_STATUS_EVENT, {
        detail: { status, message, changedAt: new Date().toISOString() },
    }));
}

function cleanNumber(value: unknown): number {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.round(number) : 0;
}

function emptyReportSnapshot(): ReportSnapshot {
    return {
        overview: {
            totalRevenue: 0,
            totalTransactions: 0,
            refundTransactions: 0,
            avgTransactionValue: 0,
            totalItemsSold: 0,
        },
        breakdown: {
            totalCash: 0,
            totalCard: 0,
            totalLoyalty: 0,
            cashTxCount: 0,
            cardTxCount: 0,
            splitTxCount: 0,
            loyaltyTxCount: 0,
            totalAmount: 0,
            unrecordedAmount: 0,
            unrecordedTxCount: 0,
        },
        topProducts: [],
        tillOptions: [],
        tillSummaries: [],
        dailyTrend: [],
        business: {
            grossSales: 0,
            refunds: 0,
            voids: 0,
            voidTransactions: 0,
            netSales: 0,
            taxTotal: 0,
            discountTotal: 0,
            costTotal: 0,
            grossProfit: 0,
        },
        employeeSales: [],
        source: 'sqlite',
    };
}

function snapshotSectionError(label: string, error: unknown): string {
    console.warn(`owner cloud: ${label} section failed`, error);
    return `${label} is temporarily unavailable`;
}

async function ensureReporterSession() {
    const config = await getOwnerCloudConfig();
    const identity = await ensureDatabaseIdentityForSync();
    if (!identity?.shopId) throw new Error('Shop identity is unavailable');
    const pairingCode = config.pairingCode || await getOrCreateOwnerAppPairingCode();
    const app = getApps().length > 0 ? getApp() : initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    if (!authPersistenceReady) {
        try {
            await setPersistence(auth, indexedDBLocalPersistence);
        } catch {
            await setPersistence(auth, inMemoryPersistence);
        }
        authPersistenceReady = true;
    }

    // Reporter credentials from the original manually provisioned flow may still
    // exist in restored settings. The shop QR secret is now the only authority.
    if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
    if (!auth.currentUser) await signInAnonymously(auth);
    const user = auth.currentUser;
    if (!user) throw new Error('Could not create the shop reporter session');
    const db = getFirestore(app);
    await setDoc(doc(db, 'shops', identity.shopId, 'devices', user.uid), {
        active: true,
        role: 'reporter',
        name: 'L&Bj POS',
        reporterSecret: pairingCode,
        registeredAt: serverTimestamp(),
    }, { merge: true });
    return {
        config: { ...config, enabled: true, pairingCode },
        db: getFirestore(app),
    };
}

async function buildSnapshot() {
    const businessDate = localDateKey();
    const identity = await ensureDatabaseIdentityForSync();
    if (!identity?.shopId) throw new Error('Shop identity is unavailable');

    const [reportResult, ordersResult, tillsResult, stockResult] = await Promise.allSettled([
        getReportSnapshot(businessDate, businessDate, 'revenue', 12),
        getOrdersPage({ status: 'all', limit: 30, offset: 0 }),
        getConnectedTills(),
        (async () => {
            const localDb = await getDb();
            const settingRows = await localDb.select<any[]>(
                `SELECT value
                 FROM settings
                 WHERE key = 'stock_tracking_enabled'
                 LIMIT 1`,
            );
            const enabled = String(settingRows[0]?.value ?? 'true').toLowerCase() !== 'false';
            if (!enabled) return { enabled, lowStockRows: [] as any[] };

            const lowStockRows = await localDb.select<any[]>(
                `SELECT id, name, sku, stockLevel
                 FROM products
                 WHERE isActive = 1 AND trackStock = 1 AND stockLevel <= 5
                 ORDER BY stockLevel ASC, name ASC
                 LIMIT 12`,
            );
            return { enabled, lowStockRows };
        })(),
    ]);

    const sectionWarnings: string[] = [];
    const report = reportResult.status === 'fulfilled'
        ? reportResult.value
        : emptyReportSnapshot();
    if (reportResult.status === 'rejected') {
        sectionWarnings.push(snapshotSectionError('Sales report', reportResult.reason));
    }
    const ordersPage = ordersResult.status === 'fulfilled'
        ? ordersResult.value
        : { rows: [], lines: [], payments: [], total: 0, overallTotal: 0 };
    if (ordersResult.status === 'rejected') {
        sectionWarnings.push(snapshotSectionError('Recent orders', ordersResult.reason));
    }
    const connectedTills = tillsResult.status === 'fulfilled' ? tillsResult.value : [];
    if (tillsResult.status === 'rejected') {
        sectionWarnings.push(snapshotSectionError('Till status', tillsResult.reason));
    }
    const stockState = stockResult.status === 'fulfilled'
        ? stockResult.value
        : { enabled: false, lowStockRows: [] };
    if (stockResult.status === 'rejected') {
        sectionWarnings.push(snapshotSectionError('Stock status', stockResult.reason));
    }

    const linesByOrder = new Map<string, any[]>();
    for (const line of ordersPage.lines) {
        const list = linesByOrder.get(String(line.orderId)) || [];
        list.push(line);
        linesByOrder.set(String(line.orderId), list);
    }
    const paymentsByOrder = new Map<string, any[]>();
    for (const payment of ordersPage.payments) {
        const list = paymentsByOrder.get(String(payment.orderId)) || [];
        list.push(payment);
        paymentsByOrder.set(String(payment.orderId), list);
    }

    const recentOrders = ordersPage.rows
        .filter(order => order.status !== 'hold')
        .slice(0, 20)
        .map(order => {
            const lines = linesByOrder.get(String(order.id)) || [];
            const payments = paymentsByOrder.get(String(order.id)) || [];
            return {
                id: String(order.id || ''),
                orderNumber: cleanNumber(order.orderNumber),
                total: cleanNumber(order.total),
                discountAmount: cleanNumber(order.discountAmount),
                status: String(order.status || ''),
                type: String(order.type || 'sale'),
                tillId: String(order.tillNumber || ''),
                tillName: String(order.tillName || order.tillNumber || 'Till'),
                cashierName: String(order.cashierName || 'Unknown'),
                completedAt: String(order.completedAt || order.createdAt || order.updatedAt || ''),
                paymentMethods: [...new Set(payments.map(payment => String(payment.method || 'unknown')))],
                itemCount: lines.reduce((sum, line) => sum + cleanNumber(line.quantity), 0),
                items: lines.slice(0, 4).map(line => ({
                    name: String(line.productName || 'Item'),
                    quantity: cleanNumber(line.quantity),
                    total: cleanNumber(line.lineTotal),
                })),
            };
        });

    const presenceByTill = new Map(connectedTills.map(till => [till.tillId, till]));
    const tills = report.tillSummaries.map(till => {
        const presence = presenceByTill.get(till.id);
        return {
            tillId: till.id,
            name: till.name,
            online: Boolean(presence),
            lastSeenAt: presence?.lastSeenAt || '',
            secondsAgo: cleanNumber(presence?.secondsAgo),
            sales: cleanNumber(till.netSales),
            grossSales: cleanNumber(till.grossSales),
            refunds: cleanNumber(till.refunds),
            transactions: cleanNumber(till.transactions),
            cash: cleanNumber(till.cashTotal),
            card: cleanNumber(till.cardTotal),
            itemsSold: cleanNumber(till.itemsSold),
        };
    });
    for (const presence of connectedTills) {
        if (tills.some(till => till.tillId === presence.tillId)) continue;
        tills.push({
            tillId: presence.tillId,
            name: presence.tillName,
            online: true,
            lastSeenAt: presence.lastSeenAt,
            secondsAgo: cleanNumber(presence.secondsAgo),
            sales: 0,
            grossSales: 0,
            refunds: 0,
            transactions: 0,
            cash: 0,
            card: 0,
            itemsSold: 0,
        });
    }

    return {
        schemaVersion: 1,
        shopId: identity.shopId,
        shopName: identity.shopName || 'Shop',
        businessDate,
        currency: 'GBP',
        source: report.source,
        warning: [report.warning, ...sectionWarnings].filter(Boolean).join(' '),
        grossSales: cleanNumber(report.business.grossSales),
        refunds: cleanNumber(report.business.refunds),
        voids: cleanNumber(report.business.voids),
        netSales: cleanNumber(report.business.netSales),
        taxTotal: cleanNumber(report.business.taxTotal),
        discountTotal: cleanNumber(report.business.discountTotal),
        grossProfit: cleanNumber(report.business.grossProfit),
        transactionCount: cleanNumber(report.overview.totalTransactions),
        refundTransactions: cleanNumber(report.overview.refundTransactions),
        itemCount: cleanNumber(report.overview.totalItemsSold),
        averageSale: cleanNumber(report.overview.avgTransactionValue),
        stockTrackingEnabled: stockState.enabled,
        payments: {
            cash: cleanNumber(report.breakdown.totalCash),
            card: cleanNumber(report.breakdown.totalCard),
            loyalty: cleanNumber(report.breakdown.totalLoyalty),
        },
        tills,
        recentOrders,
        topProducts: report.topProducts.map(product => ({
            name: product.name,
            sku: product.sku,
            quantity: cleanNumber(product.qtySold),
            revenue: cleanNumber(product.totalRevenue),
            averagePrice: cleanNumber(product.avgPrice),
        })),
        lowStock: stockState.lowStockRows.map(product => ({
            id: String(product.id || ''),
            name: String(product.name || 'Item'),
            sku: String(product.sku || ''),
            stock: cleanNumber(product.stockLevel),
        })),
        dailyTrend: report.dailyTrend.map(point => ({
            date: point.date,
            netSales: cleanNumber(point.netSales),
            transactions: cleanNumber(point.transactions),
        })),
        employees: report.employeeSales.slice(0, 10).map(employee => ({
            id: employee.employeeId,
            name: employee.employeeName,
            netSales: cleanNumber(employee.netSales),
            transactions: cleanNumber(employee.transactions),
            refunds: cleanNumber(employee.refunds),
            averageSale: cleanNumber(employee.avgTransaction),
        })),
    };
}

function readClosedReportOutbox(): OwnerClosedReportInput[] {
    if (typeof window === 'undefined') return [];
    try {
        const value = JSON.parse(localStorage.getItem(CLOSED_REPORT_OUTBOX_KEY) || '[]');
        return Array.isArray(value)
            ? value.filter(report => report && typeof report.reportId === 'string')
            : [];
    } catch {
        return [];
    }
}

function writeClosedReportOutbox(reports: OwnerClosedReportInput[]): void {
    if (typeof window === 'undefined') return;
    if (reports.length === 0) {
        localStorage.removeItem(CLOSED_REPORT_OUTBOX_KEY);
    } else {
        localStorage.setItem(CLOSED_REPORT_OUTBOX_KEY, JSON.stringify(reports));
    }
}

async function flushClosedReportOutbox(
    session?: Awaited<ReturnType<typeof ensureReporterSession>>,
): Promise<void> {
    const pending = readClosedReportOutbox();
    if (pending.length === 0) return;
    const activeSession = session || await ensureReporterSession();
    if (!activeSession) throw new Error('Owner cloud reporting is not configured');
    const identity = await ensureDatabaseIdentityForSync();
    if (!identity?.shopId) throw new Error('Shop identity is unavailable');

    const remaining = [...pending];
    while (remaining.length > 0) {
        const report = remaining[0];
        const reportRef = doc(activeSession.db, 'shops', identity.shopId, 'reports', report.reportId);
        const deletionRef = doc(
            activeSession.db,
            'shops',
            identity.shopId,
            'reportDeletions',
            report.reportId,
        );
        const deleted = (await getDoc(deletionRef)).exists();
        if (!deleted) {
            await setDoc(reportRef, {
                schemaVersion: 2,
                reportType: 'end_of_day',
                shopId: identity.shopId,
                shopName: identity.shopName || 'Shop',
                businessDate: report.businessDate,
                currency: 'GBP',
                periodStart: report.periodStart,
                periodEnd: report.periodEnd,
                closedAt: report.periodEnd,
                scope: report.scope,
                tillId: report.tillId,
                tillName: report.tillName,
                closedById: report.closedById,
                closedByName: report.closedByName,
                reportText: report.reportText,
                netSales: cleanNumber(report.overview.totalRevenue),
                transactionCount: cleanNumber(report.overview.totalTransactions),
                refundTransactions: cleanNumber(report.overview.refundTransactions),
                itemCount: cleanNumber(report.overview.totalItemsSold),
                averageSale: cleanNumber(report.overview.avgTransactionValue),
                payments: {
                    cash: cleanNumber(report.breakdown.totalCash),
                    card: cleanNumber(report.breakdown.totalCard),
                    loyalty: cleanNumber(report.breakdown.totalLoyalty),
                    unrecorded: cleanNumber(report.breakdown.unrecordedAmount),
                    unrecordedTransactions: cleanNumber(report.breakdown.unrecordedTxCount),
                },
                topProducts: report.topProducts.slice(0, 10).map(product => ({
                    name: String(product.name || 'Item'),
                    sku: String(product.sku || ''),
                    quantity: cleanNumber(product.qtySold),
                    revenue: cleanNumber(product.totalRevenue),
                    averagePrice: cleanNumber(product.avgPrice),
                })),
                dataUpdatedAt: serverTimestamp(),
                lastSeenAt: serverTimestamp(),
            });
        }
        remaining.shift();
        writeClosedReportOutbox(remaining);
    }
}

export async function queueOwnerClosedReport(report: OwnerClosedReportInput): Promise<boolean> {
    const pending = readClosedReportOutbox().filter(item => item.reportId !== report.reportId);
    pending.push(report);
    writeClosedReportOutbox(pending);
    try {
        await flushClosedReportOutbox();
        return true;
    } catch (error) {
        console.warn('owner cloud: closed report queued for retry', error);
        return false;
    }
}

export async function publishOwnerCloudSnapshot(): Promise<void> {
    if (publishPromise) return publishPromise;
    publishPromise = (async () => {
        const session = await ensureReporterSession();
        if (!session) {
            emitStatus('disabled', 'Owner cloud reporting is not configured');
            return;
        }
        emitStatus('connecting', 'Preparing live shop data');
        const identity = await ensureDatabaseIdentityForSync();
        if (!identity?.shopId) throw new Error('Shop identity is unavailable');
        const currentRef = doc(session.db, 'shops', identity.shopId, 'dashboard', 'current');
        let snapshot;
        try {
            snapshot = await buildSnapshot();
        } catch (error) {
            await setDoc(currentRef, {
                schemaVersion: 1,
                shopId: identity.shopId,
                shopName: identity.shopName || 'Shop',
                businessDate: localDateKey(),
                currency: 'GBP',
                warning: `The POS is online, but detailed reporting failed: ${String(error)}`,
                dataUpdatedAt: serverTimestamp(),
                lastSeenAt: serverTimestamp(),
            }, { merge: true });
            throw error;
        }
        await setDoc(currentRef, {
            ...snapshot,
            dataUpdatedAt: serverTimestamp(),
            lastSeenAt: serverTimestamp(),
        });
        try {
            await flushClosedReportOutbox(session);
        } catch (error) {
            console.warn('owner cloud: queued closed report retry failed', error);
        }
        emitStatus(
            'live',
            snapshot.warning ? `Owner app is live. ${snapshot.warning}` : 'Owner app data is live',
        );
    })().catch(error => {
        console.warn('owner cloud: snapshot publish failed', error);
        emitStatus(navigator.onLine ? 'error' : 'offline', String(error));
    }).finally(() => {
        publishPromise = null;
    });
    return publishPromise;
}

async function publishHeartbeat(): Promise<void> {
    try {
        const session = await ensureReporterSession();
        if (!session) return;
        const identity = await ensureDatabaseIdentityForSync();
        if (!identity?.shopId) return;
        await setDoc(doc(session.db, 'shops', identity.shopId, 'dashboard', 'current'), {
            lastSeenAt: serverTimestamp(),
        }, { merge: true });
        emitStatus('live', 'Owner app data is live');
    } catch (error) {
        emitStatus(navigator.onLine ? 'error' : 'offline', String(error));
    }
}

function scheduleChangedSnapshot(): void {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
        changeTimer = null;
        void publishOwnerCloudSnapshot();
    }, CHANGE_DEBOUNCE_MS);
}

export function startOwnerCloudReporter(): () => void {
    if (reporterStarted || typeof window === 'undefined') return () => {};
    reporterStarted = true;
    window.addEventListener(OWNER_CLOUD_DATA_CHANGED_EVENT, scheduleChangedSnapshot);
    fullRefreshTimer = setInterval(() => void publishOwnerCloudSnapshot(), FULL_REFRESH_MS);
    heartbeatTimer = setInterval(() => void publishHeartbeat(), HEARTBEAT_MS);
    setTimeout(() => void publishOwnerCloudSnapshot(), 2500);

    return () => {
        reporterStarted = false;
        window.removeEventListener(OWNER_CLOUD_DATA_CHANGED_EVENT, scheduleChangedSnapshot);
        if (fullRefreshTimer) clearInterval(fullRefreshTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (changeTimer) clearTimeout(changeTimer);
        fullRefreshTimer = null;
        heartbeatTimer = null;
        changeTimer = null;
    };
}

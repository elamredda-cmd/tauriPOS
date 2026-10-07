import { invoke, isTauri } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { buildMysqlUri, connectionState, type PosConnectionState } from '$lib/stores/connection';

export interface CashControlEntry {
    id: string;
    rootId: string;
    previousEntryId: string | null;
    revision: number;
    tillId: string;
    businessDate: string;
    periodStart: string;
    periodEnd: string;
    snapshotAt: string;
    openingFloatAmount: number;
    countedAmount: number;
    expectedAmount: number;
    varianceAmount: number;
    cashSalesAmount: number;
    accountCashAmount: number;
    cashMovementAmount: number;
    cashbackAmount: number;
    netCashAmount: number;
    reason: string;
    employeeId: string;
    employeeName: string;
    createdAt: string;
}

export interface CashControlContext {
    source: 'local' | 'shared';
    tillId: string;
    businessDate: string;
    periodStart: string;
    periodEnd: string;
    snapshotAt: string;
    cashSalesAmount: number;
    accountCashAmount: number;
    cashMovementAmount: number;
    cashbackAmount: number;
    netCashAmount: number;
    canCreate: boolean;
    blockedReason: string | null;
    entries: CashControlEntry[];
}

export interface CashControlPeriod {
    tillId: string;
    businessDate: string;
    periodStart: string;
    periodEnd: string;
}

export interface CashControlRequest extends CashControlPeriod {
    id: string;
    openingFloatAmount: number;
    countedAmount: number;
    reason: string;
    previousEntryId: string | null;
}

/** Parse money without rounding an invalid third decimal or accepting exponents. */
export function cashCountPence(value: string | number): number | null {
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [pounds, fraction = ''] = text.split('.');
    const amount = Number(pounds) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(amount) && amount <= 100_000_000 ? amount : null;
}

export function localBusinessDate(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function offsetTimestamp(date: Date): string {
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
    return `${localBusinessDate(date)}T00:00:00${sign}${hours}:${minutes}`;
}

/** Calendar-day bounds in the till's timezone, including daylight-saving changes. */
export function cashControlPeriod(tillId: string, businessDate: string, now = new Date()): CashControlPeriod {
    if (!tillId.trim()) throw new Error('Select a till first.');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
    if (!match) throw new Error('Choose a valid business date.');
    const [, y, m, d] = match;
    const start = new Date(Number(y), Number(m) - 1, Number(d));
    if (start.getFullYear() !== Number(y) || start.getMonth() !== Number(m) - 1 || start.getDate() !== Number(d)) {
        throw new Error('Choose a valid business date.');
    }
    if (start.getTime() > now.getTime()) throw new Error('A cash count cannot be recorded for a future day.');
    const end = new Date(Number(y), Number(m) - 1, Number(d) + 1);
    return { tillId: tillId.trim(), businessDate, periodStart: offsetTimestamp(start), periodEnd: offsetTimestamp(end) };
}

export function latestCashControlEntry(entries: CashControlEntry[]): CashControlEntry | null {
    return [...entries].sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt))[0] || null;
}

export function cashVarianceLabel(amount: number): string {
    return amount < 0 ? 'Short' : amount > 0 ? 'Over' : 'Balanced';
}

/** In-memory access identity only; never include the database password. */
export function cashControlSourceIdentity(state: PosConnectionState): string {
    return JSON.stringify(state.mode === 'multi'
        ? [state.mode, state.mysqlConfig?.host, state.mysqlConfig?.port, state.mysqlConfig?.database, state.mysqlConfig?.user]
        : [state.mode]);
}

function nativeCashControlSource(): { mysqlUri?: string } {
    if (!isTauri()) throw new Error('Private Cash Control is available in the installed Tauri app.');
    const state = get(connectionState);
    if (state.mode === 'multi') {
        if (!state.mysqlConfig || !state.mysqlOnline || !state.mysqlReady) {
            throw new Error('Reconnect to MariaDB before opening or saving private cash counts.');
        }
        return { mysqlUri: buildMysqlUri(state.mysqlConfig) };
    }
    if (state.mode !== 'single') throw new Error('Finish setting up this till before using Cash Control.');
    return {};
}

export async function loadCashControl(period: CashControlPeriod, employeeId: string, pin: string): Promise<CashControlContext> {
    return invoke('cash_control_context', { ...nativeCashControlSource(), ...period, employeeId, pin });
}

export async function saveCashControl(request: CashControlRequest, employeeId: string, pin: string): Promise<CashControlEntry> {
    return invoke('cash_control_save', { ...nativeCashControlSource(), employeeId, pin, request });
}

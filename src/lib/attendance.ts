import type { EmployeeAttendance } from '$lib/stores/db';

export const ATTENDANCE_CHANGED_EVENT = 'pos-attendance-changed';
export const ATTENDANCE_CORRECTION_CONFLICT_CODE = 'ATTENDANCE_CORRECTION_CONFLICT';
export const ATTENDANCE_CORRECTION_CONFLICT_MESSAGE =
    'This attendance record changed on another till. Review the latest version before correcting it again.';
export const ATTENDANCE_EXPORT_MAX_ROWS = 100_000;

/**
 * Quote a CSV cell and neutralise spreadsheet formula prefixes. Attendance
 * exports are commonly opened in Excel, where an employee name or note that
 * begins with one of these characters would otherwise be evaluated as a
 * formula instead of displayed as text.
 */
export function attendanceCsvCell(value: unknown): string {
    const raw = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
}

export function attendanceCorrectionVersionMatches(
    expectedUpdatedAt: string,
    authoritativeUpdatedAt: string,
): boolean {
    const expected = String(expectedUpdatedAt || '').trim();
    return expected.length > 0 && expected === String(authoritativeUpdatedAt || '').trim();
}

/**
 * A clock-out may only close the exact open session the user saw.
 */
export function attendanceOpenSessionMatches(
    expectedAttendanceId: string,
    authoritativeAttendanceId: string,
): boolean {
    const expected = String(expectedAttendanceId || '').trim();
    return Boolean(expected && expected === String(authoritativeAttendanceId || '').trim());
}

export function syncedTablesIncludeAttendance(tableNames: Iterable<string>): boolean {
    for (const tableName of tableNames) {
        if (tableName === 'employee_attendance') return true;
    }
    return false;
}

export function openAttendanceDeactivationMessage(employeeName: string): string {
    const name = employeeName.trim() || 'This staff member';
    return `${name} is still clocked in. Clock them out from Attendance before deactivating their account.`;
}

export function attendanceDurationSeconds(
    record: Pick<EmployeeAttendance, 'clockInAt' | 'clockOutAt' | 'status'>,
    currentTime = Date.now(),
): number {
    const start = new Date(record.clockInAt).getTime();
    const end = record.status === 'open' || !record.clockOutAt
        ? currentTime
        : new Date(record.clockOutAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    return Math.floor((end - start) / 1000);
}

export function formatAttendanceDuration(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function attendanceDateRange(startDate: string, endDate: string): { startAt: string; endAt: string } {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    if (!startDate || !endDate || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
        throw new Error('Choose a valid attendance date range');
    }
    if (end < start) throw new Error('The end date cannot be before the start date');
    end.setDate(end.getDate() + 1);
    return { startAt: start.toISOString(), endAt: end.toISOString() };
}

export function validateClosedAttendance(clockInAt: string, clockOutAt: string): void {
    const start = new Date(clockInAt).getTime();
    const end = new Date(clockOutAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error('Enter valid clock-in and clock-out times');
    }
    if (end <= start) throw new Error('Clock-out must be after clock-in');
    if (end - start > 7 * 24 * 60 * 60 * 1000) {
        throw new Error('One attendance session cannot be longer than 7 days');
    }
}

export function toDatetimeLocalValue(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}

export function fromDatetimeLocalValue(value: string): string {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) throw new Error('Enter a valid date and time');
    return date.toISOString();
}

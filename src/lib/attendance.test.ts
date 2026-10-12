import { describe, expect, it } from 'vitest';
import {
    ATTENDANCE_CHANGED_EVENT,
    ATTENDANCE_CORRECTION_CONFLICT_CODE,
    ATTENDANCE_CORRECTION_CONFLICT_MESSAGE,
    ATTENDANCE_EXPORT_MAX_ROWS,
    ATTENDANCE_CLOCK_SKEW_MS,
    findAttendanceOverlap,
    attendanceCorrectionVersionMatches,
    attendanceCsvCell,
    attendanceDateRange,
    attendanceDurationSeconds,
    attendanceOpenSessionMatches,
    formatAttendanceDuration,
    fromDatetimeLocalValue,
    openAttendanceDeactivationMessage,
    syncedTablesIncludeAttendance,
    toDatetimeLocalValue,
    validateClosedAttendance,
} from './attendance';

describe('employee attendance helpers', () => {
    it('calculates completed and open attendance durations without negative time', () => {
        expect(attendanceDurationSeconds({
            clockInAt: '2026-08-21T08:00:00.000Z',
            clockOutAt: '2026-08-21T16:30:00.000Z',
            status: 'closed',
        })).toBe(30_600);
        expect(attendanceDurationSeconds({
            clockInAt: '2026-08-21T08:00:00.000Z',
            clockOutAt: '',
            status: 'open',
        }, new Date('2026-08-21T10:15:00.000Z').getTime())).toBe(8_100);
        expect(attendanceDurationSeconds({
            clockInAt: '2026-08-21T10:00:00.000Z',
            clockOutAt: '2026-08-21T09:00:00.000Z',
            status: 'closed',
        })).toBe(0);
    });

    it('formats worked time as hours and minutes', () => {
        expect(formatAttendanceDuration(30_600)).toBe('8h 30m');
        expect(formatAttendanceDuration(-1)).toBe('0h 00m');
    });

    it('builds an inclusive local date range with an exclusive next-day end', () => {
        const range = attendanceDateRange('2026-08-20', '2026-08-21');
        expect(new Date(range.endAt).getTime() - new Date(range.startAt).getTime())
            .toBe(48 * 60 * 60 * 1000);
        expect(() => attendanceDateRange('2026-08-22', '2026-08-21')).toThrow(/end date/i);
    });

    it('validates completed sessions and limits accidental week-long entries', () => {
        expect(() => validateClosedAttendance(
            '2026-08-21T08:00:00.000Z',
            '2026-08-21T16:00:00.000Z',
        )).not.toThrow();
        expect(() => validateClosedAttendance(
            '2026-08-21T16:00:00.000Z',
            '2026-08-21T08:00:00.000Z',
        )).toThrow(/after clock-in/i);
        expect(() => validateClosedAttendance(
            '2026-08-01T08:00:00.000Z',
            '2026-08-21T08:00:00.000Z',
        )).toThrow(/7 days/i);
    });

    it('rejects future manual times beyond the documented clock skew', () => {
        const now = Date.parse('2026-10-12T12:00:00.000Z');
        expect(() => validateClosedAttendance('2026-10-12T08:00:00.000Z',
            new Date(now + ATTENDANCE_CLOCK_SKEW_MS).toISOString(), now)).not.toThrow();
        expect(() => validateClosedAttendance('2026-10-12T08:00:00.000Z',
            new Date(now + ATTENDANCE_CLOCK_SKEW_MS + 1).toISOString(), now)).toThrow(/future/);
    });

    it('checks every other session, treats open sessions as unbounded, and permits adjacent shifts', () => {
        const row = { id: 'candidate', employeeId: 'worker', status: 'closed' as const,
            clockInAt: '2026-10-12T08:00:00.000Z', clockOutAt: '2026-10-12T16:00:00.000Z' };
        const existing = { ...row, id: 'existing' };
        for (const [clockInAt, clockOutAt] of [
            ['07:00', '09:00'], ['09:00', '10:00'], ['15:00', '17:00'], ['07:00', '17:00'], ['08:00', '16:00'],
        ]) {
            expect(findAttendanceOverlap(row, [{ ...existing,
                clockInAt: `2026-10-12T${clockInAt}:00Z`, clockOutAt: `2026-10-12T${clockOutAt}:00Z`,
            }])?.id).toBe('existing');
        }
        expect(findAttendanceOverlap(row, [row])).toBeUndefined();
        expect(findAttendanceOverlap(row, [{ ...existing, employeeId: 'other-worker' }])).toBeUndefined();
        expect(findAttendanceOverlap(row, [{ ...existing, clockOutAt: row.clockInAt, clockInAt: '2026-10-12T06:00:00Z' }])).toBeUndefined();
        expect(findAttendanceOverlap(row, [{ ...existing, clockInAt: row.clockOutAt, clockOutAt: '2026-10-12T18:00:00Z' }])).toBeUndefined();
        expect(findAttendanceOverlap(row, [{ ...existing, status: 'open', clockOutAt: '', clockInAt: '2026-09-05T08:00:00Z' }])?.id).toBe('existing');
        expect(findAttendanceOverlap({ ...row, status: 'open', clockOutAt: '' }, [{ ...existing, clockInAt: '2026-10-13T08:00:00Z', clockOutAt: '2026-10-13T09:00:00Z' }])?.id).toBe('existing');
        expect(findAttendanceOverlap(row, [{ ...existing, clockInAt: '2026-10-12T09:00:00+01:00' }])?.id).toBe('existing');
    });

    it('round-trips datetime-local values through an ISO timestamp', () => {
        const iso = '2026-08-21T12:34:00.000Z';
        expect(fromDatetimeLocalValue(toDatetimeLocalValue(iso))).toBe(iso);
    });

    it('recognises attendance changes without treating other sync tables as attendance', () => {
        expect(ATTENDANCE_CHANGED_EVENT).toBe('pos-attendance-changed');
        expect(syncedTablesIncludeAttendance(new Set(['orders', 'employee_attendance']))).toBe(true);
        expect(syncedTablesIncludeAttendance(['employees', 'orders'])).toBe(false);
    });

    it('gives a clear clock-out instruction when deactivation is blocked', () => {
        expect(openAttendanceDeactivationMessage('Alex Staff')).toBe(
            'Alex Staff is still clocked in. Clock them out from Attendance before deactivating their account.',
        );
        expect(openAttendanceDeactivationMessage('  ')).toMatch(/^This staff member is still clocked in\./);
    });

    it('requires an exact non-empty attendance version for correction CAS', () => {
        const version = '2026-08-22T16:05:03.123Z';
        expect(attendanceCorrectionVersionMatches(version, version)).toBe(true);
        expect(attendanceCorrectionVersionMatches(version, '2026-08-22T16:06:00.000Z')).toBe(false);
        expect(attendanceCorrectionVersionMatches('', '')).toBe(false);
        expect(ATTENDANCE_CORRECTION_CONFLICT_CODE).toBe('ATTENDANCE_CORRECTION_CONFLICT');
        expect(ATTENDANCE_CORRECTION_CONFLICT_MESSAGE).toMatch(/changed on another till/i);
    });

    it('never substitutes a newer open session for the one being clocked out', () => {
        expect(attendanceOpenSessionMatches('session-a', 'session-a')).toBe(true);
        expect(attendanceOpenSessionMatches('session-a', 'session-b')).toBe(false);
        expect(attendanceOpenSessionMatches('', 'session-b')).toBe(false);
    });

    it('exports quoted CSV text without allowing spreadsheet formulas', () => {
        expect(attendanceCsvCell('Alex "AJ"')).toBe('"Alex ""AJ"""');
        expect(attendanceCsvCell('=HYPERLINK("https://example.test")'))
            .toBe('"\'=HYPERLINK(""https://example.test"")"');
        expect(attendanceCsvCell('+441234')).toBe('"\'+441234"');
        expect(attendanceCsvCell('normal note')).toBe('"normal note"');
        expect(ATTENDANCE_EXPORT_MAX_ROWS).toBeGreaterThan(10_000);
    });
});

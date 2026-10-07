import { describe, expect, it } from 'vitest';
import {
    ATTENDANCE_CHANGED_EVENT,
    ATTENDANCE_CORRECTION_CONFLICT_CODE,
    ATTENDANCE_CORRECTION_CONFLICT_MESSAGE,
    ATTENDANCE_EXPORT_MAX_ROWS,
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

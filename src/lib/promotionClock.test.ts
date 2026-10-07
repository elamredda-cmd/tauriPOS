import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextPromotionRefreshDelay, promotionEvaluationTime } from './promotionClock';

const now = Date.parse('2026-09-09T12:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();

describe('checkout promotion clock', () => {
    afterEach(() => vi.useRealTimers());

    it('wakes exactly when a scheduled offer starts', () => {
        expect(nextPromotionRefreshDelay([{ isActive: true, startAt: iso(250) }], now)).toBe(250);
    });

    it('expires immediately after the engine’s inclusive end instant', () => {
        expect(nextPromotionRefreshDelay([{ isActive: true, endAt: iso(0) }], now)).toBe(1);
        expect(nextPromotionRefreshDelay([{ isActive: true, endAt: iso(999) }], now)).toBe(1000);
    });

    it('uses the first discount or group boundary, ignoring inactive or invalid windows', () => {
        expect(nextPromotionRefreshDelay([
            { isActive: false, startAt: iso(1) },
            { isActive: true, startAt: 'invalid' },
            { isActive: true, startAt: iso(-100), endAt: iso(3000) },
            { isActive: true, startAt: iso(1200) },
        ], now)).toBe(1200);
    });

    it('keeps the lightweight minute heartbeat when nothing is due soon', () => {
        expect(nextPromotionRefreshDelay([], now)).toBe(60_000);
        expect(nextPromotionRefreshDelay([{ isActive: true, startAt: iso(90_000) }], now)).toBe(60_000);
        expect(nextPromotionRefreshDelay([{ isActive: true, endAt: iso(-1) }], now)).toBe(60_000);
    });

    it('evaluates a new scan at the current time even if a background timer was delayed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 40_000);
        expect(promotionEvaluationTime(iso(0))).toBe(iso(40_000));
    });
});

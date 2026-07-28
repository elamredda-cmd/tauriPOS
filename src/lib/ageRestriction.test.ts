import { describe, expect, it } from 'vitest';
import {
    AGE_RESTRICTION_SETTING_KEY,
    isAgeRestrictionEnabled,
    requiresAgeVerification,
} from './ageRestriction';

describe('age restriction settings', () => {
    it('defaults enforcement to enabled', () => {
        expect(isAgeRestrictionEnabled([])).toBe(true);
    });

    it('can disable and re-enable enforcement', () => {
        expect(isAgeRestrictionEnabled([
            { key: AGE_RESTRICTION_SETTING_KEY, value: 'false' },
        ])).toBe(false);
        expect(isAgeRestrictionEnabled([
            { key: AGE_RESTRICTION_SETTING_KEY, value: 'true' },
        ])).toBe(true);
    });

    it('only requires a check for marked products while enforcement is enabled', () => {
        expect(requiresAgeVerification({ isAgeRestricted: true }, [])).toBe(true);
        expect(requiresAgeVerification({ isAgeRestricted: false }, [])).toBe(false);
        expect(requiresAgeVerification({ isAgeRestricted: true }, [
            { key: AGE_RESTRICTION_SETTING_KEY, value: 'false' },
        ])).toBe(false);
    });
});

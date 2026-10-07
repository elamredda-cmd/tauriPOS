import { describe, expect, it } from 'vitest';
import { shouldShowConnectionStatus } from './connectionStatusVisibility';

describe('connection status visibility', () => {
    it('shows sync status on the main checkout screen', () => {
        expect(shouldShowConnectionStatus('checkout', '/')).toBe(true);
        expect(shouldShowConnectionStatus('checkout', '/', 'header')).toBe(true);
    });

    it.each([
        '/admin',
        '/items',
        '/customers',
        '/orders',
        '/reports',
        '/settings',
        '/settings/sync',
        '/customer-display',
        '/setup',
    ])('hides checkout sync status on %s', (pathname) => {
        expect(shouldShowConnectionStatus('checkout', pathname)).toBe(false);
    });

    it.each(['/', '/admin', '/items', '/orders', '/settings', '/settings/sync'])(
        'shows Back Office status only in the sidebar on %s',
        (pathname) => {
            expect(shouldShowConnectionStatus('back_office', pathname, 'sidebar')).toBe(true);
            expect(shouldShowConnectionStatus('back_office', pathname, 'header')).toBe(false);
            expect(shouldShowConnectionStatus('back_office', pathname)).toBe(false);
        },
    );

    it.each(['/', '/admin', '/items', '/orders', '/settings', '/settings/sync'])(
        'never shows a sidebar status in Checkout mode on %s',
        (pathname) => {
            expect(shouldShowConnectionStatus('checkout', pathname, 'sidebar')).toBe(false);
        },
    );

    it('waits for the device mode to load', () => {
        expect(shouldShowConnectionStatus(null, '/')).toBe(false);
        expect(shouldShowConnectionStatus(undefined, '/admin')).toBe(false);
        expect(shouldShowConnectionStatus(null, '/admin', 'sidebar')).toBe(false);
        expect(shouldShowConnectionStatus(undefined, '/admin', 'sidebar')).toBe(false);
    });
});

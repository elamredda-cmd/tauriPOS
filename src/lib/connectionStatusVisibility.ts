import type { DeviceOperatingMode } from './deviceMode';

export type ConnectionStatusPlacement = 'header' | 'sidebar';

/** Till status belongs on checkout; Back Office status belongs in its sidebar. */
export function shouldShowConnectionStatus(
    mode: DeviceOperatingMode | null | undefined,
    pathname: string,
    placement: ConnectionStatusPlacement = 'header',
): boolean {
    if (mode === 'back_office') return placement === 'sidebar';
    return mode === 'checkout' && pathname === '/' && placement === 'header';
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ native: true, existing: null as any, monitors: [] as any[], emit: vi.fn(), listeners: {} as Record<string, (event?: any) => void>, create: vi.fn(), commands: [] as string[] }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.native }));
vi.mock('$lib/deviceMode', () => ({ assertCheckoutDeviceMode: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emit, listen: vi.fn(async (name: string, callback: any) => { mocks.listeners[name] = callback; return () => {}; }) }));
vi.mock('@tauri-apps/api/window', () => ({ availableMonitors: async () => mocks.monitors, PhysicalPosition: class { constructor(public x: number, public y: number) {} } }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: class {
    constructor(label: string, options: unknown) { mocks.create(label, options); }
    static async getByLabel() { return mocks.existing; }
    async once(event: string, callback: any) { if (event === 'tauri://created') callback({}); return () => {}; }
    async setPosition(position: any) { mocks.commands.push(`position:${position.x},${position.y}`); }
    async setFullscreen(value: boolean) { mocks.commands.push(`fullscreen:${value}`); }
} }));
import { openCustomerDisplay, getDisplayMonitors, broadcastCustomerDisplay, type CustomerDisplayState } from './customerDisplay';

describe('customer window control', () => {
    beforeEach(() => {
        mocks.native = true; mocks.existing = null; mocks.commands = []; mocks.emit.mockReset(); mocks.create.mockReset();
        mocks.monitors = [{ name: 'Main', size: { width: 1920, height: 1080 }, position: { x: 0, y: 0 } }, { name: 'Customer', size: { width: 2048, height: 1536 }, position: { x: -2048, y: 0 } }];
        vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: vi.fn(() => '1') });
    });
    it('uses physical screen coordinates before entering full screen', async () => {
        await openCustomerDisplay(1);
        expect(mocks.create).toHaveBeenCalledWith('customer-display', expect.objectContaining({ fullscreen: false, focus: false }));
        expect(mocks.commands).toEqual(['position:-2048,0', 'fullscreen:true']);
    });
    it('repositions and shows an existing window', async () => {
        mocks.existing = { setFullscreen: vi.fn(), setPosition: vi.fn(), show: vi.fn() };
        await openCustomerDisplay(0);
        expect(mocks.existing.setFullscreen.mock.calls).toEqual([[false], [true]]);
        expect(mocks.existing.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 0 }));
        expect(mocks.existing.show).toHaveBeenCalledOnce();
    });
    it('explains browser limitations and handles a disconnected monitor', async () => {
        mocks.native = false;
        expect(await getDisplayMonitors()).toEqual([]);
        await expect(openCustomerDisplay()).rejects.toThrow('desktop app');
        mocks.native = true; mocks.monitors = [];
        await expect(openCustomerDisplay()).rejects.toThrow('No screens');
    });
    it('does not move the display onto the operator screen when the selected screen is disconnected', async () => {
        mocks.monitors = mocks.monitors.slice(0, 1);
        await expect(openCustomerDisplay(1)).rejects.toThrow('no longer connected');
        expect(mocks.create).not.toHaveBeenCalled();
    });
    it('sends the current basket when a newly loaded display is ready', async () => {
        const basket: CustomerDisplayState = { storeName: 'Shop', tillName: 'Till 1', lines: [], subtotal: 100, total: 100, discount: 0, status: 'shopping', message: '', change: 0 };
        await broadcastCustomerDisplay(basket);
        mocks.emit.mockClear();
        mocks.listeners['customer-display-ready']();
        expect(mocks.emit).toHaveBeenCalledWith('customer-display', 'customer-display-state', basket);
    });
});

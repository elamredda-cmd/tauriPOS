import { emitTo, listen } from '@tauri-apps/api/event';
import { availableMonitors, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '@tauri-apps/api/core';
import { assertCheckoutDeviceMode } from '$lib/deviceMode';

const CUSTOMER_DISPLAY_MONITOR_KEY = 'customer_display_monitor';
const CUSTOMER_DISPLAY_AUTO_OPEN_KEY = 'customer_display_auto_open';

let autoOpenStop: (() => void) | null = null;

export interface CustomerDisplayLine {
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
    discount: number;
    promotion?: CustomerDisplayPromotion;
}

export interface CustomerDisplayPromotion {
    status: 'applied' | 'eligible';
    label: string;
    text: string;
}

export interface CustomerDisplayState {
    storeName: string;
    tillName: string;
    lines: CustomerDisplayLine[];
    subtotal: number;
    discount: number;
    total: number;
    status: 'shopping' | 'payment' | 'complete';
    message: string;
    change: number;
}

export interface DisplayMonitor {
    index: number;
    name: string;
    width: number;
    height: number;
    x: number;
    y: number;
}

export async function getDisplayMonitors(): Promise<DisplayMonitor[]> {
    if (!isTauri()) return [];
    const monitors = await availableMonitors();
    return monitors.map((monitor, index) => ({
        index,
        name: monitor.name || `Screen ${index + 1}`,
        width: monitor.size.width,
        height: monitor.size.height,
        x: monitor.position.x,
        y: monitor.position.y,
    }));
}

export function getSavedCustomerDisplayMonitor(): number {
    return Number(localStorage.getItem(CUSTOMER_DISPLAY_MONITOR_KEY) || '1');
}

export function saveCustomerDisplayMonitor(index: number) {
    localStorage.setItem(CUSTOMER_DISPLAY_MONITOR_KEY, String(index));
}

export function getCustomerDisplayAutoOpen(): boolean {
    return localStorage.getItem(CUSTOMER_DISPLAY_AUTO_OPEN_KEY) !== 'false';
}

export function saveCustomerDisplayAutoOpen(enabled: boolean) {
    localStorage.setItem(CUSTOMER_DISPLAY_AUTO_OPEN_KEY, enabled ? 'true' : 'false');
}

export async function openCustomerDisplayOnSecondScreen(): Promise<boolean> {
    assertCheckoutDeviceMode('Opening the customer display');
    if (!getCustomerDisplayAutoOpen()) return false;
    const monitors = await availableMonitors();
    if (monitors.length < 2) return false;
    const savedIndex = getSavedCustomerDisplayMonitor();
    const monitorIndex = savedIndex > 0 && monitors[savedIndex] ? savedIndex : 1;
    await openCustomerDisplay(monitorIndex);
    return true;
}

export function startCustomerDisplayAutoOpenWatcher(): () => void {
    autoOpenStop?.();
    let attempts = 0;
    let stopped = false;
    const maxAttempts = 15;
    let timer: ReturnType<typeof setInterval>;

    const stop = () => {
        stopped = true;
        if (timer) clearInterval(timer);
        if (autoOpenStop === stop) autoOpenStop = null;
    };

    const attempt = async () => {
        if (stopped) return;
        attempts += 1;
        try {
            const opened = await openCustomerDisplayOnSecondScreen();
            if (opened || attempts >= maxAttempts || !getCustomerDisplayAutoOpen()) stop();
        } catch (error) {
            console.warn('customer display: auto-open failed:', error);
            if (attempts >= maxAttempts) stop();
        }
    };

    timer = setInterval(() => void attempt(), 4000);
    autoOpenStop = stop;
    void attempt();
    return stop;
}

export async function openCustomerDisplay(monitorIndex = getSavedCustomerDisplayMonitor()): Promise<void> {
    assertCheckoutDeviceMode('Opening the customer display');
    if (!isTauri()) throw new Error('Open the desktop app to use a second screen. You can preview the display here.');
    await startCustomerDisplayBridge();
    saveCustomerDisplayMonitor(monitorIndex);
    const monitors = await availableMonitors();
    if (!monitors.length) throw new Error('No screens are available. Connect a customer screen and refresh the screen list.');
    const monitor = monitors[monitorIndex];
    if (!monitor) throw new Error('The selected screen is no longer connected. Refresh the screen list and choose a screen.');
    const existing = await WebviewWindow.getByLabel('customer-display');
    if (existing) {
        await existing.setFullscreen(false);
        if (monitor) await existing.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
        await existing.setFullscreen(true);
        await existing.show();
        return;
    }

    const display = new WebviewWindow('customer-display', {
        url: '/customer-display',
        title: 'L&Bj POS Customer Display',
        decorations: false,
        fullscreen: false,
        focus: false,
        width: 1024,
        height: 768,
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The customer screen did not open. Please retry.')), 10000);
        display.once('tauri://created', () => { clearTimeout(timeout); resolve(); });
        display.once('tauri://error', (event) => { clearTimeout(timeout); reject(event.payload); });
    });
    await display.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
    await display.setFullscreen(true);
}

export async function closeCustomerDisplay(): Promise<void> {
    if (!isTauri()) return;
    const display = await WebviewWindow.getByLabel('customer-display');
    if (display) await display.close();
}

let latestState: CustomerDisplayState | null = null;
let bridgeReady: Promise<void> | null = null;
export function startCustomerDisplayBridge(): Promise<void> {
    if (!isTauri()) return Promise.resolve();
    if (!bridgeReady) bridgeReady = listen('customer-display-ready', () => {
        if (latestState) void emitTo('customer-display', 'customer-display-state', latestState);
    }).then(() => {}).catch((error) => { bridgeReady = null; console.warn('Customer display connection:', error); });
    return bridgeReady;
}
export async function broadcastCustomerDisplay(state: CustomerDisplayState): Promise<void> {
    latestState = state;
    if (!isTauri()) return;
    await startCustomerDisplayBridge();
    try {
        await emitTo('customer-display', 'customer-display-state', state);
    } catch {
        // The optional customer display is not open.
    }
}

import { emitTo } from '@tauri-apps/api/event';
import { availableMonitors, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface CustomerDisplayLine {
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
    discount: number;
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
    return Number(localStorage.getItem('customer_display_monitor') || '1');
}

export function saveCustomerDisplayMonitor(index: number) {
    localStorage.setItem('customer_display_monitor', String(index));
}

export async function openCustomerDisplay(monitorIndex = getSavedCustomerDisplayMonitor()): Promise<void> {
    saveCustomerDisplayMonitor(monitorIndex);
    const monitors = await availableMonitors();
    const monitor = monitors[monitorIndex] || monitors[0];
    const existing = await WebviewWindow.getByLabel('customer-display');
    if (existing) {
        if (monitor) await existing.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
        await existing.setFullscreen(true);
        await existing.show();
        return;
    }

    const display = new WebviewWindow('customer-display', {
        url: '/customer-display',
        title: 'L&Bj POS Customer Display',
        decorations: false,
        fullscreen: true,
        focus: false,
        x: monitor?.position.x,
        y: monitor?.position.y,
        width: monitor?.size.width || 1024,
        height: monitor?.size.height || 768,
    });
    await new Promise<void>((resolve, reject) => {
        display.once('tauri://created', () => resolve());
        display.once('tauri://error', (event) => reject(event.payload));
    });
}

export async function closeCustomerDisplay(): Promise<void> {
    const display = await WebviewWindow.getByLabel('customer-display');
    if (display) await display.close();
}

export async function broadcastCustomerDisplay(state: CustomerDisplayState): Promise<void> {
    try {
        await emitTo('customer-display', 'customer-display-state', state);
    } catch {
        // The optional customer display is not open.
    }
}

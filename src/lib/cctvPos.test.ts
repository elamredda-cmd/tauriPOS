import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDB, type Setting } from '$lib/stores/db';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
    formatCctvItemText,
    formatCctvReceiptText,
    resetCctvAutomaticQueue,
    sendCctvItemAdded,
    type CctvPosConfig,
} from '$lib/cctvPos';

const hikvisionConfig: CctvPosConfig = {
    enabled: true,
    host: '127.0.0.1',
    port: 10010,
    encoding: 'latin1',
    lineWidth: 32,
    sendItems: true,
    sendReceipts: true,
    framingPreset: 'hikvision',
    startMarker: '',
    lineSeparator: '\\r\\n',
    endMarker: '\\r\\n\\r\\n',
};

function setting(key: string, value: string): Setting {
    return { key, value, updatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('CCTV overlay formatting', () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset();
        resetCctvAutomaticQueue();
    });

    it('keeps a scanned item on one conservative Hikvision row', () => {
        const text = formatCctvItemText({
            name: 'Premium organic strawberries',
            price: 249,
            quantity: 2,
            tillName: 'Till 1',
            cashierName: 'Cashier',
        }, hikvisionConfig);

        expect(text).not.toMatch(/[\r\n]/);
        expect(text.length).toBeLessThanOrEqual(31);
        expect(text).toContain('2x');
        expect(text).toContain('£4.98');
    });

    it('keeps quantity, unit price, and total on each completed-sale row', () => {
        const text = formatCctvReceiptText({
            storeName: 'Shop',
            tillName: 'Till 1',
            cashierName: 'Cashier',
            paymentMethod: 'cash',
            subtotal: 250,
            discount: 0,
            total: 250,
            lines: [{
                name: 'Golden delicious apples',
                quantity: 2,
                unitPrice: 125,
                lineTotal: 250,
            }],
        }, hikvisionConfig);

        const rows = text.split('\n');
        expect(rows.every((row) => row.length <= 31)).toBe(true);
        expect(rows[0]).toContain('2x');
        expect(rows[0]).toContain('£1.25');
        expect(rows[0]).toContain('£2.50');
    });

    it('replaces a pending live scan with the newest scan', async () => {
        settingsDB.set([
            setting('cctv_pos_enabled', 'true'),
            setting('cctv_pos_host', '127.0.0.1'),
            setting('cctv_pos_port', '10010'),
            setting('cctv_pos_send_items', 'true'),
            setting('cctv_pos_framing', 'hikvision'),
        ]);

        let finishFirst: ((value: unknown) => void) | undefined;
        vi.mocked(invoke)
            .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
            .mockResolvedValue({
                localAddress: '127.0.0.1:50000',
                remoteAddress: '127.0.0.1:10010',
                bytesSent: 20,
            });

        const payload = { price: 100, quantity: 1, tillName: 'Till 1', cashierName: 'Cashier' };
        sendCctvItemAdded({ ...payload, name: 'First item' });
        sendCctvItemAdded({ ...payload, name: 'Older pending item' });
        sendCctvItemAdded({ ...payload, name: 'Newest item' });

        expect(invoke).toHaveBeenCalledTimes(1);
        finishFirst?.({
            localAddress: '127.0.0.1:50000',
            remoteAddress: '127.0.0.1:10010',
            bytesSent: 20,
        });

        await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
        const secondPayload = vi.mocked(invoke).mock.calls[1][1] as { text: string };
        expect(secondPayload.text).toContain('Newest item');
        expect(secondPayload.text).not.toContain('Older pending item');
    });
});

import { describe, it, expect } from 'vitest';
import { defaultDisplayContent, normalizeDisplayContent } from './customerDisplayContent';

describe('customer display saved content', () => {
    it('recovers safely from corrupt or missing preferences', () => {
        expect(normalizeDisplayContent(null)).toEqual(defaultDisplayContent());
        expect(normalizeDisplayContent({ slides: 'bad', size: 'NaN', color: 'url(evil)', font: 'evil' })).toEqual(defaultDisplayContent());
    });
    it('limits durations, text, fonts and colours from persisted data', () => {
        const config = normalizeDisplayContent({ size: 999, heading: 'x'.repeat(300), color: '#abcdef', background: 'red', font: 'serif', slides: [
            { id: 'a'.repeat(64) + '.png', name: 'Photo', kind: 'image', duration: -1 },
            { id: 'b'.repeat(64) + '.mp4', name: 'Video', kind: 'video', duration: 200 },
        ] });
        expect(config.size).toBe(88);
        expect(config.heading).toHaveLength(120);
        expect(config.color).toBe('#abcdef');
        expect(config.background).toBe(defaultDisplayContent().background);
        expect(config.slides.map(s => s.duration)).toEqual([2, 60]);
    });
    it('rejects paths and duplicate media, retaining playlist order', () => {
        const first = { id: 'a'.repeat(64) + '.png', kind: 'image', name: 'First' };
        const last = { id: 'b'.repeat(64) + '.mp4', kind: 'video', name: 'Last' };
        const config = normalizeDisplayContent({ slides: [first, { ...first, id: '../pos.db' }, first, last] });
        expect(config.slides.map(s => s.name)).toEqual(['First', 'Last']);
    });
    it('preserves text-only mode and style without requiring files', () => {
        const config = normalizeDisplayContent({ mode: 'text', heading: 'Our offer', body: 'Today only', bold: false, italic: true, align: 'right' });
        expect(config).toMatchObject({ mode: 'text', heading: 'Our offer', body: 'Today only', bold: false, italic: true, align: 'right', slides: [] });
    });
});

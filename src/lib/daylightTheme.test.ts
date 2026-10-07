import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const daylightRule = appCss.match(/\.theme-daylight\s*\{([^}]+)\}/)?.[1] || '';
const tokens = Object.fromEntries(
    [...daylightRule.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]),
);

function resolveToken(name: string): string {
    const value = tokens[name];
    if (!value) throw new Error(`Missing Daylight token ${name}`);
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    return alias ? resolveToken(alias[1]) : value;
}

function rgb(hex: string): number[] {
    if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected six-digit colour, received ${hex}`);
    return [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance(hex: string): number {
    const [red, green, blue] = rgb(hex).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * red + .7152 * green + .0722 * blue;
}

function contrast(first: string, second: string): number {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

describe('Daylight semantic palette', () => {
    it('defines every surface, text, state and component token without falling back to Midnight', () => {
        const required = [
            '--bg-base', '--bg-panel', '--bg-card', '--bg-card-hover',
            '--border-flat', '--border-focus', '--text-main', '--text-muted', '--text-dark', '--text-inverse',
            '--accent-primary', '--accent-primary-hover', '--success', '--warning', '--danger',
            '--overlay', '--shadow', '--card-shadow', '--tile-bg', '--tile-text',
            '--price-bg', '--price-text', '--sidebar-hover', '--sidebar-active',
        ];
        for (const name of required) expect(tokens[name], name).toBeTruthy();
        expect(daylightRule).toMatch(/color-scheme:\s*light\s*;/);
    });

    it.each([
        '--bg-panel', '--bg-card', '--border-flat', '--text-muted',
        '--accent-primary', '--success', '--warning', '--danger',
    ])('keeps %s and its RGB companion consistent', (name) => {
        expect(tokens[`${name}-rgb`].split(',').map(value => Number(value.trim()))).toEqual(rgb(resolveToken(name)));
    });

    const textSurfacePairs = ['--text-main', '--text-muted', '--accent-primary', '--success', '--warning', '--danger']
        .flatMap(text => ['--bg-base', '--bg-panel', '--bg-card', '--bg-card-hover'].map(surface => [text, surface]));

    it.each(textSurfacePairs)('%s remains readable on %s at normal text size', (text, surface) => {
        expect(contrast(resolveToken(text), resolveToken(surface))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['--accent-primary', '--accent-primary-hover', '--success', '--warning', '--danger'])(
        'white button text remains readable on %s',
        (surface) => {
            expect(resolveToken('--text-inverse')).toBe('#ffffff');
            expect(contrast(resolveToken('--text-inverse'), resolveToken(surface))).toBeGreaterThanOrEqual(4.5);
        },
    );

    it('keeps product names and price badges readable', () => {
        expect(contrast(resolveToken('--tile-text'), resolveToken('--tile-bg'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(resolveToken('--price-text'), resolveToken('--price-bg'))).toBeGreaterThanOrEqual(4.5);
    });

    it('gives Pay later completion light text on its dark amber background', () => {
        expect(appCss).toMatch(/\.theme-daylight\s+\.payment-modal\.is-account\s+\.payment-complete-btn\s*\{[^}]*color:\s*var\(--text-inverse\)/);
    });

    it.each(['date', 'datetime-local', 'time'])('uses light native %s controls', (type) => {
        const selector = `.theme-daylight input[type="${type}"]`;
        const afterSelector = appCss.slice(appCss.indexOf(selector) + selector.length);
        expect(appCss).toContain(selector);
        expect(afterSelector.slice(0, afterSelector.indexOf('}'))).toMatch(/color-scheme:\s*light\s*;/);
    });

    it.each(['input', 'textarea'])('retains the tested muted-text contrast for %s placeholders', (element) => {
        const selector = `.theme-daylight ${element}::placeholder`;
        const afterSelector = appCss.slice(appCss.indexOf(selector) + selector.length);
        expect(appCss).toContain(selector);
        expect(afterSelector.slice(0, afterSelector.indexOf('}'))).toMatch(/opacity:\s*1\s*;/);
    });
});

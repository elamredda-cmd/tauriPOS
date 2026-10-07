import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { emitTo } from '@tauri-apps/api/event';

export const DISPLAY_CONTENT_KEY = 'customer_display_content_v1';
export const DISPLAY_CONTENT_EVENT = 'customer-display-content';
export const displayFonts = [
    { id: 'sans', label: 'Modern', family: 'Arial, Helvetica, sans-serif' },
    { id: 'serif', label: 'Classic', family: 'Georgia, "Times New Roman", serif' },
    { id: 'rounded', label: 'Friendly', family: '"Trebuchet MS", Arial, sans-serif' },
    { id: 'mono', label: 'Typewriter', family: '"Courier New", monospace' },
];
export interface DisplaySlide {
    id: string;
    name: string;
    kind: 'image' | 'video' | 'text';
    duration: number;
    heading?: string;
    body?: string;
}
export interface DisplayContent {
    version: 1;
    mode: 'playlist' | 'text';
    slides: DisplaySlide[];
    heading: string;
    body: string;
    font: string;
    size: number;
    bold: boolean;
    italic: boolean;
    align: 'left' | 'center' | 'right';
    color: string;
    background: string;
    fit: 'contain' | 'cover';
    transition: 'fade' | 'none';
    overlay: boolean;
    duringSale: boolean;
}
export function defaultDisplayContent(): DisplayContent {
    return { version: 1, mode: 'playlist', slides: [], heading: 'Welcome to our shop',
        body: 'Thank you for shopping with us.', font: 'sans', size: 48, bold: true,
        italic: false, align: 'center', color: '#ffffff', background: '#132c42',
        fit: 'contain', transition: 'fade', overlay: false, duringSale: true };
}
const bounded = (v: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
const shortText = (v: unknown, fallback: string, limit: number) => typeof v === 'string' ? v.slice(0, limit) : fallback;
export function normalizeDisplayContent(value: unknown): DisplayContent {
    const d = defaultDisplayContent();
    if (!value || typeof value !== 'object') return d;
    const v = value as Partial<DisplayContent>;
    const color = (s: unknown, fallback: string) => typeof s === 'string' && /^#[\da-f]{6}$/i.test(s) ? s : fallback;
    const ids = new Set<string>();
    const slides: DisplaySlide[] = [];
    for (const slide of Array.isArray(v.slides) ? v.slides.slice(0, 24) : []) {
        if (!slide || !['image', 'video', 'text'].includes(slide.kind) || typeof slide.id !== 'string' || ids.has(slide.id)) continue;
        if (slide.kind !== 'text' && !/^(?:[a-f\d]{64}|[a-f\d-]{36})\.(jpg|jpeg|png|webp|mp4)$/i.test(slide.id)) continue;
        if (slide.kind === 'text' && !/^[a-f\d-]{36}$/i.test(slide.id)) continue;
        ids.add(slide.id);
        slides.push({ id: slide.id, name: shortText(slide.name, 'Slide', 160), kind: slide.kind,
            duration: bounded(slide.duration, 6, 2, 60), heading: shortText(slide.heading, '', 120), body: shortText(slide.body, '', 500) });
    }
    return { ...d, mode: v.mode === 'text' ? 'text' : 'playlist', slides,
        heading: shortText(v.heading, d.heading, 120), body: shortText(v.body, d.body, 500),
        font: displayFonts.some(f => f.id === v.font) ? v.font! : d.font,
        size: bounded(v.size, d.size, 24, 88), bold: v.bold !== false, italic: v.italic === true,
        align: v.align === 'left' || v.align === 'right' ? v.align : 'center',
        color: color(v.color, d.color), background: color(v.background, d.background),
        fit: v.fit === 'cover' ? 'cover' : 'contain', transition: v.transition === 'none' ? 'none' : 'fade',
        overlay: v.overlay === true, duringSale: v.duringSale !== false };
}
export function loadDisplayContent(): DisplayContent {
    try { return normalizeDisplayContent(JSON.parse(localStorage.getItem(DISPLAY_CONTENT_KEY) || 'null')); }
    catch { return defaultDisplayContent(); }
}
export async function saveDisplayContent(value: DisplayContent): Promise<DisplayContent> {
    const content = normalizeDisplayContent(value);
    localStorage.setItem(DISPLAY_CONTENT_KEY, JSON.stringify(content));
    if (isTauri()) await emitTo('customer-display', DISPLAY_CONTENT_EVENT, content).catch(() => {});
    return content;
}
function mediaDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('customer-display-media', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function browserMedia<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await mediaDb();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction('files', mode);
            const req = operation(tx.objectStore('files'));
            tx.oncomplete = () => resolve(req.result);
            tx.onabort = tx.onerror = () => reject(tx.error || req.error);
        });
    } finally { db.close(); }
}
export async function displayMediaUrl(id: string): Promise<string> {
    if (!/^(?:[a-f\d]{64}|[a-f\d-]{36})\.(jpg|jpeg|png|webp|mp4)$/i.test(id)) throw new Error('Invalid media');
    if (isTauri()) return convertFileSrc(await join(await appDataDir(), 'customer-display-media', id));
    const blob = await browserMedia<Blob | undefined>('readonly', store => store.get(id));
    if (!blob) throw new Error('Media is missing');
    return URL.createObjectURL(blob);
}
export async function removeDisplayMedia(id: string): Promise<void> {
    if (isTauri()) await invoke('remove_customer_display_media', { id });
    else await browserMedia('readwrite', store => store.delete(id));
}
export async function importDisplayMedia(files?: FileList | File[]): Promise<{ files: DisplaySlide[]; errors: string[] }> {
    if (isTauri()) {
        const result = await invoke<{ files: Omit<DisplaySlide, 'duration'>[]; errors: string[] }>('import_customer_display_media');
        return { files: result.files.map(file => ({ ...file, duration: 6 })), errors: result.errors };
    }
    const result: { files: DisplaySlide[]; errors: string[] } = { files: [], errors: [] };
    for (const file of Array.from(files || []).slice(0, 24)) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (!ext || !['jpg', 'jpeg', 'png', 'webp', 'mp4'].includes(ext)) { result.errors.push(`${file.name}: unsupported format`); continue; }
        const kind = ext === 'mp4' ? 'video' : 'image';
        if (file.size > (kind === 'image' ? 10 : 100) * 1024 * 1024) { result.errors.push(`${file.name}: file is too large`); continue; }
        const id = `${crypto.randomUUID()}.${ext}`;
        await browserMedia('readwrite', store => store.put(file, id));
        result.files.push({ id, name: file.name, kind, duration: 6 });
    }
    return result;
}
export async function validateDisplayMedia(slide: DisplaySlide): Promise<void> {
    const url = await displayMediaUrl(slide.id);
    try {
        await new Promise<void>((resolve, reject) => {
            const element = document.createElement(slide.kind === 'video' ? 'video' : 'img');
            const timer = setTimeout(() => finish('The file could not be loaded'), 15000);
            const finish = (error?: string) => {
                clearTimeout(timer);
                element.onload = element.onerror = null;
                if (element instanceof HTMLVideoElement) { element.onloadeddata = null; element.removeAttribute('src'); element.load(); }
                error ? reject(new Error(error)) : resolve();
            };
            element.onerror = () => finish('This file cannot be played. Use JPG, PNG, WebP or H.264 MP4.');
            if (element instanceof HTMLVideoElement) {
                element.preload = 'auto';
                element.onloadeddata = () => finish(!Number.isFinite(element.duration) || element.duration > 120 ? 'Videos must be two minutes or shorter' : undefined);
            } else element.onload = () => finish();
            element.src = url;
        });
    } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
}

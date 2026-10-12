export function editPriceDigits(value: string, started: boolean, key: string): { value: string; started: boolean } {
    if (key === 'C') return { value: '0', started: true };
    if (key === '⌫') return { value: value.slice(0, -1) || '0', started: true };
    if (!/^\d{1,2}$/.test(key)) return { value, started };
    if (key === '00') {
        if (!started) return { value: '0', started: true };
        return { value: value !== '0' && value.length <= 7 ? value + key : value, started };
    }
    if (!started || value === '0') return { value: key, started: true };
    return { value: value.length < 9 ? value + key : value, started };
}

function sanitizeProfile(value: string): string {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return cleaned || 'default';
}

export const posProfile = sanitizeProfile(import.meta.env.VITE_POS_PROFILE || 'default');
export const localDatabaseName = posProfile === 'default' ? 'pos.db' : `pos-${posProfile}.db`;

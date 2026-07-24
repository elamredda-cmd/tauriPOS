export const TILE_COLORS = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#22c55e",
    "#0ea5e9",
    "#6366f1",
    "#a855f7",
    "#ec4899",
] as const;

export function randomTileColor(): string {
    const index = Math.floor(Math.random() * TILE_COLORS.length);
    return TILE_COLORS[index] ?? TILE_COLORS[0];
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { TILE_COLORS, randomTileColor } from "./tileColors";

describe("randomTileColor", () => {
    afterEach(() => vi.restoreAllMocks());

    it("selects colours across the full palette", () => {
        vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999999);

        expect(randomTileColor()).toBe(TILE_COLORS[0]);
        expect(randomTileColor()).toBe(TILE_COLORS.at(-1));
    });
});

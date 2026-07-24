import { describe, expect, it } from "vitest";
import {
    DEFAULT_PRODUCT_CATEGORY_SETTING_KEY,
    getDefaultProductCategoryId,
} from "./categoryDefaults";

const categories = [
    { id: "first", isActive: true },
    { id: "preferred", isActive: true },
    { id: "inactive", isActive: false },
];

describe("getDefaultProductCategoryId", () => {
    it("uses the configured active category", () => {
        expect(getDefaultProductCategoryId(categories, [
            { key: DEFAULT_PRODUCT_CATEGORY_SETTING_KEY, value: "preferred" },
        ])).toBe("preferred");
    });

    it("falls back to the first active category when the setting is invalid", () => {
        expect(getDefaultProductCategoryId(categories, [
            { key: DEFAULT_PRODUCT_CATEGORY_SETTING_KEY, value: "inactive" },
        ])).toBe("first");
    });
});

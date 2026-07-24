import type { Category, Setting } from "$lib/stores/db";

export const DEFAULT_PRODUCT_CATEGORY_SETTING_KEY = "default_product_category_id";

export function getDefaultProductCategoryId(
    categories: Array<Pick<Category, "id" | "isActive">>,
    settings: Array<Pick<Setting, "key" | "value">>,
): string {
    const configuredId = settings.find(
        (setting) => setting.key === DEFAULT_PRODUCT_CATEGORY_SETTING_KEY,
    )?.value;
    const configuredCategory = categories.find(
        (category) => category.isActive && category.id === configuredId,
    );

    return configuredCategory?.id || categories.find((category) => category.isActive)?.id || "";
}

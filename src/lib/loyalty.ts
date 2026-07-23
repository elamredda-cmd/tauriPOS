import type { Customer, Setting } from "$lib/stores/db";
import { normalizeLoyaltyCode } from "$lib/customerLoyaltyCode";

export interface LoyaltyConfig {
    enabled: boolean;
    pointsPerPound: number;
    pointsToRedeem: number;
    redemptionValue: number;
}

export function getLoyaltyConfig(settings: Setting[]): LoyaltyConfig {
    const value = (key: string, fallback: string) =>
        settings.find((setting) => setting.key === key)?.value || fallback;
    return {
        enabled: value("loyalty_enabled", "true") !== "false",
        pointsPerPound: Math.max(0, Number(value("loyalty_points_per_pound", "1")) || 0),
        pointsToRedeem: Math.max(1, Number(value("loyalty_points_to_redeem", "100")) || 100),
        redemptionValue: Math.max(1, Number(value("loyalty_redemption_value", "100")) || 100),
    };
}

export function loyaltyCredit(points: number, config: LoyaltyConfig): number {
    return Math.floor(Math.max(0, points) * config.redemptionValue / config.pointsToRedeem);
}

export function pointsForSpend(pence: number, config: LoyaltyConfig): number {
    return Math.floor(Math.max(0, pence) / 100 * config.pointsPerPound);
}

export function pointsForCredit(pence: number, config: LoyaltyConfig): number {
    return Math.ceil(Math.max(0, pence) * config.pointsToRedeem / config.redemptionValue);
}

export function createLoyaltyCode(existing: Customer[]): string {
    const used = new Set(existing.map((customer) => normalizeLoyaltyCode(customer.loyaltyCode)).filter(Boolean));
    let code = "";
    do {
        code = `LB${Math.floor(10000000 + Math.random() * 90000000)}`;
    } while (used.has(code));
    return code;
}

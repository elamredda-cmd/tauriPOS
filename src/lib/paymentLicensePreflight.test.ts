import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Architectural regression check: licence enforcement must occur in the
// native entry point, before a new provider charge, not only in the UI.
function nativeCommand(file: string, name: string): string {
    const source = readFileSync(new URL(`../../src-tauri/src/${file}`, import.meta.url), 'utf8');
    const start = source.indexOf(`pub async fn ${name}(`);
    if (start < 0) throw new Error(`Missing command ${name}`);
    const next = source.indexOf('\n#[tauri::command]', start);
    return source.slice(start, next < 0 ? undefined : next);
}

describe('native card payment licence preflight', () => {
    it.each([
        ['dojo.rs', 'dojo_create_payment'],
        ['dojo.rs', 'dojo_retry_payment'],
        ['sumup.rs', 'sumup_create_checkout'],
    ])('checks the licence before %s/%s can contact a provider', (file, command) => {
        const body = nativeCommand(file, command);
        const guard = body.indexOf('crate::licensing::require_sale_access(&app).await?;');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(body.indexOf('require_api_config('));
        expect(guard).toBeLessThan(body.indexOf('.send()'));
    });

    it.each([
        ['dojo.rs', 'dojo_payment_intent_status'],
        ['dojo.rs', 'dojo_cancel_terminal_session'],
        ['dojo.rs', 'dojo_respond_signature'],
        ['sumup.rs', 'sumup_transaction_status'],
        ['sumup.rs', 'sumup_terminate_checkout'],
    ])('leaves %s/%s available after expiry to resolve existing payments', (file, command) => {
        expect(nativeCommand(file, command)).not.toContain('require_sale_access(');
    });
});

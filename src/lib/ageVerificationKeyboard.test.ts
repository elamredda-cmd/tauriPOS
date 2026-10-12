import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgeVerificationKeyboardGuard } from './ageVerificationKeyboard';
import { handleCheckoutSearchKeydown } from './checkoutScanner';

describe('age verification requires a separate approval gesture', () => {
    it.each(['Enter', ' '])('consumes the opening %s key release and all held repeats', key => {
        const guard = new AgeVerificationKeyboardGuard();
        expect(guard.keydown({ key, repeat: false })).toBe(false);
        guard.begin();
        expect(guard.keydown({ key, repeat: true })).toBe(true);
        expect(guard.keydown({ key, repeat: true })).toBe(true);
        expect(guard.keyup(key)).toBe(true);
        expect(guard.keydown({ key: 'Tab', repeat: false })).toBe(false);
        // Fresh keyboard approval still works once the cashier navigates to it.
        expect(guard.keydown({ key, repeat: false })).toBe(false);
        expect(guard.keyup(key)).toBe(false);
    });

    it('handles uncached lookup after key release without a stuck opening key', () => {
        const guard = new AgeVerificationKeyboardGuard();
        guard.keydown({ key: 'Enter', repeat: false });
        expect(guard.keyup('Enter')).toBe(false);
        guard.begin();
        expect(guard.keydown({ key: 'Tab', repeat: false })).toBe(false);
        expect(guard.keydown({ key: 'Enter', repeat: false })).toBe(false);
    });

    it('keeps cancelled and then cached rescans behind a fresh gate', () => {
        const guard = new AgeVerificationKeyboardGuard();
        let added = 0;
        let gateOpen = false;
        const scanRestricted = () => {
            const steps: string[] = [];
            const event = {
                key: 'Enter', repeat: false, isComposing: false,
                preventDefault: () => steps.push('prevent'),
                stopPropagation: () => steps.push('stop'),
            } as unknown as KeyboardEvent;
            guard.keydown(event);
            handleCheckoutSearchKeydown(event, () => {
                expect(steps).toEqual(['prevent', 'stop']);
                guard.begin();
                gateOpen = true;
            });
            expect(guard.keyup('Enter')).toBe(true);
        };
        scanRestricted();
        guard.end(); // Do Not Add
        gateOpen = false;
        scanRestricted(); // Now the same item is cached.
        expect(gateOpen).toBe(true);
        expect(added).toBe(0);
        guard.keydown({ key: 'Tab', repeat: false });
        const explicitApprovalBlocked = guard.keydown({ key: 'Enter', repeat: false });
        if (!explicitApprovalBlocked) added += 1;
        expect(added).toBe(1);
    });

    it('discards scanner bursts and their terminators even with approval focused', () => {
        const guard = new AgeVerificationKeyboardGuard();
        guard.begin();
        for (const key of ['4', '3', '4', '3', 'Enter']) {
            expect(guard.keydown({ key, repeat: false })).toBe(true);
            guard.keyup(key);
        }
        // Repeated terminators must not turn a discarded scan into approval.
        expect(guard.keydown({ key: 'Enter', repeat: false })).toBe(true);
        expect(guard.keyup('Enter')).toBe(true);
        guard.keydown({ key: 'Tab', repeat: false });
        expect(guard.keydown({ key: 'Enter', repeat: false })).toBe(false);
    });

    it('allows a deliberate pointer gesture after discarding scanner input', () => {
        const guard = new AgeVerificationKeyboardGuard();
        guard.begin();
        guard.keydown({ key: '4', repeat: false });
        guard.pointerdown();
        expect(guard.keydown({ key: ' ', repeat: false })).toBe(false);
    });

    it('does not interfere with scanning after a gate closes', () => {
        const guard = new AgeVerificationKeyboardGuard();
        guard.begin();
        guard.keydown({ key: '4', repeat: false });
        guard.end();
        expect(guard.keydown({ key: '4', repeat: false })).toBe(false);
        expect(guard.keydown({ key: 'Enter', repeat: false })).toBe(false);
        expect(guard.keyup('Enter')).toBe(false);
    });

    it('does not retain an opening key released while another application has focus', () => {
        const guard = new AgeVerificationKeyboardGuard();
        guard.keydown({ key: 'Enter', repeat: false });
        guard.begin();
        guard.releaseKeys();
        expect(guard.keydown({ key: 'Tab', repeat: false })).toBe(false);
        expect(guard.keydown({ key: 'Enter', repeat: false })).toBe(false);
    });

    it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }])(
        'preserves system shortcuts and composition: %o', modifiers => {
            const guard = new AgeVerificationKeyboardGuard();
            guard.begin();
            expect(guard.keydown({ key: 'w', repeat: false, ...modifiers })).toBe(false);
            expect(guard.keydown({ key: 'Enter', repeat: false })).toBe(false);
        },
    );
});

describe('checkout age-dialog integration', () => {
    const source = readFileSync(new URL('../routes/+page.svelte', import.meta.url), 'utf8');

    it('starts every restricted addition behind the guard, including scan, scale and quick-add', () => {
        expect(source).toMatch(/if \(requiresAgeVerification\(catalogProduct, \$settingsDB\)\) \{\s*ageVerificationKeyboard\.begin\(\);\s*pendingAgeRestrictedAdd =/);
        expect(source).toContain('handleCheckoutSearchKeydown(e, handleSearch)');
        expect(source).toContain('document.addEventListener("keyup", handleGlobalScannerKeyup, true)');
        expect(source).toContain('document.removeEventListener("keyup", handleGlobalScannerKeyup, true)');
    });

    it('focuses a non-approving heading, never either decision button', () => {
        const dialog = source.slice(source.indexOf('{#if pendingAgeRestrictedAdd}'));
        const ageDialog = dialog.slice(0, dialog.indexOf('{/if}'));
        expect(ageDialog).toMatch(/<h2\s+bind:this=\{ageRestrictedDialogTitle\}[\s\S]*?tabindex="-1"\s+data-modal-initial-focus/);
        expect(ageDialog.match(/data-modal-initial-focus/g)).toHaveLength(1);
        expect(source).toContain('ageRestrictedDialogTitle.focus({ preventScroll: true })');
        expect(source).not.toContain('ageRestrictedConfirmButton');
    });
});

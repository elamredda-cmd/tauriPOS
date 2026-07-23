<script lang="ts">
    import { onMount } from 'svelte';
    import QRCode from 'qrcode';
    import {
        ArrowLeft,
        Check,
        Clipboard,
        KeyRound,
        RefreshCw,
        ShieldCheck,
    } from '@lucide/svelte';
    import {
        activateSupportAccess,
        createSupportAccessRequest,
        type SupportAccessRequest,
        type SupportSessionGrant,
    } from '$lib/supportAccess';

    export let onClose: () => void = () => {};
    export let onActivate: (grant: SupportSessionGrant) => void | Promise<void> = () => {};

    let request: SupportAccessRequest | null = null;
    let requestQr = '';
    let supportCode = '';
    let busy = false;
    let activating = false;
    let error = '';
    let copied = false;

    onMount(() => {
        void generateRequest();
    });

    function formatTime(value: string) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'soon' : date.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        }).toUpperCase();
    }

    async function generateRequest() {
        if (busy || activating) return;
        busy = true;
        error = '';
        supportCode = '';
        copied = false;
        try {
            request = await createSupportAccessRequest();
            requestQr = await QRCode.toDataURL(request.code, {
                width: 320,
                margin: 1,
                errorCorrectionLevel: 'M',
                color: { dark: '#172033', light: '#ffffff' },
            });
        } catch (reason) {
            request = null;
            requestQr = '';
            error = String(reason).replace(/^Error:\s*/, '');
        } finally {
            busy = false;
        }
    }

    async function copyRequest() {
        if (!request) return;
        try {
            await navigator.clipboard.writeText(request.code);
            copied = true;
            window.setTimeout(() => (copied = false), 1800);
        } catch {
            error = 'Could not copy the request. Select it manually.';
        }
    }

    async function activate() {
        if (!supportCode.trim() || activating) return;
        activating = true;
        error = '';
        try {
            const grant = await activateSupportAccess(supportCode);
            supportCode = '';
            await onActivate(grant);
        } catch (reason) {
            error = String(reason).replace(/^Error:\s*/, '');
        } finally {
            activating = false;
        }
    }
</script>

<section class="support-access" aria-labelledby="support-access-title">
    <div class="support-heading">
        <button type="button" class="support-back" title="Back to staff sign in" aria-label="Back to staff sign in" on:click={onClose}>
            <ArrowLeft size={21} strokeWidth={2.4} />
        </button>
        <div>
            <h1 id="support-access-title">L&amp;Bj Support Access</h1>
            <p>Temporary access for this shop and this till.</p>
        </div>
        <span class="support-shield" aria-hidden="true"><ShieldCheck size={27} /></span>
    </div>

    {#if error}<div class="support-error" role="alert">{error}</div>{/if}

    {#if busy}
        <div class="support-loading"><span></span><strong>Creating secure request</strong></div>
    {:else if request}
        <div class="support-columns">
            <section class="support-request-section">
                <div class="support-section-title">
                    <span>1</span>
                    <div><strong>Send request to CRM</strong><small>Expires at {formatTime(request.expiresAt)}</small></div>
                    <button type="button" class="support-refresh" title="Create a new request" aria-label="Create a new support request" on:click={generateRequest}>
                        <RefreshCw size={18} />
                    </button>
                </div>
                <div class="support-request-content">
                    {#if requestQr}<img src={requestQr} alt="Support request QR code" />{/if}
                    <div class="support-request-code">
                        <span>{request.shopCode} · {request.tillName || 'This till'}</span>
                        <textarea readonly value={request.code} aria-label="Support request code" spellcheck="false"></textarea>
                        <button type="button" class="btn btn-secondary" on:click={copyRequest}>
                            {#if copied}<Check size={18} />Copied{:else}<Clipboard size={18} />Copy request{/if}
                        </button>
                    </div>
                </div>
            </section>

            <section class="support-code-section">
                <div class="support-section-title">
                    <span>2</span>
                    <div><strong>Enter signed code</strong><small>Issued from CRM Support Access</small></div>
                </div>
                <label for="support-access-code">Support code</label>
                <textarea
                    id="support-access-code"
                    bind:value={supportCode}
                    placeholder="LBJSUP1..."
                    spellcheck="false"
                    autocomplete="off"
                    autocapitalize="off"
                    data-touch-keyboard="off"
                    disabled={activating}
                ></textarea>
                <button type="button" class="btn btn-primary support-activate" disabled={!supportCode.trim() || activating} on:click={activate}>
                    <KeyRound size={19} />{activating ? 'Verifying...' : 'Start Support Session'}
                </button>
            </section>
        </div>
    {:else}
        <div class="support-loading failed">
            <strong>Request unavailable</strong>
            <button type="button" class="btn btn-primary" on:click={generateRequest}>Try again</button>
        </div>
    {/if}
</section>

<style>
    .support-access { min-width: 0; display: flex; flex-direction: column; gap: .85rem; }
    .support-heading { display: grid; grid-template-columns: 42px minmax(0, 1fr) 34px; align-items: center; gap: .7rem; }
    .support-heading h1 { margin: 0; color: var(--text-main); font-size: 1.35rem; }
    .support-heading p { margin: .15rem 0 0; color: var(--text-muted); font-size: .76rem; }
    .support-back, .support-refresh { display: grid; place-items: center; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .support-back { width: 42px; height: 42px; }
    .support-refresh { width: 34px; height: 34px; margin-left: auto; }
    .support-back:hover, .support-refresh:hover { color: var(--accent-primary); border-color: var(--accent-primary); }
    .support-shield { display: grid; place-items: center; color: var(--success); }
    .support-error { padding: .65rem .75rem; color: var(--danger); font-size: .75rem; font-weight: 750; border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border-flat)); border-radius: .4rem; background: color-mix(in srgb, var(--danger) 8%, var(--bg-panel)); }
    .support-columns { min-height: 350px; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(250px, .85fr); border: 1px solid var(--border-flat); border-radius: .5rem; overflow: hidden; }
    .support-request-section, .support-code-section { min-width: 0; padding: .85rem; display: flex; flex-direction: column; gap: .75rem; }
    .support-code-section { border-left: 1px solid var(--border-flat); background: var(--bg-panel); }
    .support-section-title { min-height: 38px; display: flex; align-items: center; gap: .6rem; }
    .support-section-title > span { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; color: white; font-size: .75rem; font-weight: 900; border-radius: .35rem; background: var(--accent-primary); }
    .support-section-title div { min-width: 0; display: flex; flex-direction: column; }
    .support-section-title strong { color: var(--text-main); font-size: .78rem; }
    .support-section-title small { margin-top: .1rem; color: var(--text-muted); font-size: .66rem; }
    .support-request-content { min-height: 0; display: grid; grid-template-columns: 122px minmax(0, 1fr); gap: .7rem; }
    .support-request-content img { width: 122px; height: 122px; object-fit: contain; border: 1px solid var(--border-flat); border-radius: .35rem; background: white; }
    .support-request-code { min-width: 0; display: flex; flex-direction: column; gap: .45rem; }
    .support-request-code > span { overflow: hidden; color: var(--text-muted); font-size: .68rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
    .support-access textarea { width: 100%; min-width: 0; padding: .55rem; color: var(--text-main); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .68rem; line-height: 1.35; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-card); resize: none; }
    .support-request-code textarea { height: 82px; }
    .support-code-section > label { color: var(--text-muted); font-size: .7rem; font-weight: 800; }
    .support-code-section > textarea { min-height: 165px; flex: 1; }
    .support-activate { width: 100%; min-height: 46px; }
    .support-loading { min-height: 320px; display: grid; place-content: center; justify-items: center; gap: .8rem; color: var(--text-muted); }
    .support-loading > span { width: 30px; height: 30px; border: 3px solid var(--border-flat); border-top-color: var(--accent-primary); border-radius: 50%; animation: support-spin .7s linear infinite; }
    .support-loading.failed { color: var(--danger); }
    @keyframes support-spin { to { transform: rotate(360deg); } }
    @media (max-width: 700px) {
        .support-columns { grid-template-columns: 1fr; }
        .support-code-section { border-top: 1px solid var(--border-flat); border-left: 0; }
    }
    @media (max-height: 700px) and (min-width: 701px) {
        .support-columns { min-height: 290px; }
        .support-request-content { grid-template-columns: 100px minmax(0, 1fr); }
        .support-request-content img { width: 100px; height: 100px; }
        .support-code-section > textarea { min-height: 115px; }
    }
</style>

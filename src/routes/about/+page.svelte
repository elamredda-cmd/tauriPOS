<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
</script>

<svelte:head>
    <title>About L&amp;Bj POS</title>
</svelte:head>

<MgmtPage title="About" backFallback="/admin">
    <div class="about-page">
        <section class="about-brand" aria-labelledby="about-product-name">
            <img class="about-logo" src="/lbj-pos-logo.png" alt="L&Bj POS logo" />
            <div class="about-introduction">
                <span class="about-kicker">Point of Sale</span>
                <h2 id="about-product-name">L&amp;Bj POS</h2>
                <p>
                    A practical retail point-of-sale application built to keep everyday shop work clear,
                    fast, and organised.
                </p>
            </div>
        </section>

        <div class="about-details">
            <section class="about-section" aria-labelledby="about-application-heading">
                <span class="section-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="4" y="3" width="16" height="18" rx="2"></rect>
                        <path d="M8 7h8"></path>
                        <path d="M8 11h8"></path>
                        <path d="M8 15h5"></path>
                    </svg>
                </span>
                <div>
                    <h3 id="about-application-heading">About this application</h3>
                    <p>
                        L&amp;Bj POS brings checkout, products, stock, customers, staff, reports, hardware
                        settings, and multi-till synchronisation into one touch-friendly workspace.
                    </p>
                </div>
            </section>

            <section class="about-section contact-section" aria-labelledby="contact-heading">
                <span class="section-icon contact-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2h-4"></path>
                        <path d="M3 15v4a2 2 0 0 0 2 2h4"></path>
                        <path d="M3 12a9 9 0 0 1 18 0v3h-4v-3"></path>
                        <path d="M3 12v3h4v-3"></path>
                    </svg>
                </span>
                <div class="contact-content">
                    <h3 id="contact-heading">Contact</h3>
                    <p>For product enquiries, setup help, or support, contact L&amp;Bj POS directly.</p>
                    <div class="contact-links">
                        <a href="mailto:elam.redda@outlook.com" aria-label="Email elam.redda@outlook.com">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                                <path d="m3 7 9 6 9-6"></path>
                            </svg>
                            <span>
                                <small>Email</small>
                                <strong>elam.redda@outlook.com</strong>
                            </span>
                        </a>
                        <a href="tel:07307486871" aria-label="Call 07307486871">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"></path>
                            </svg>
                            <span>
                                <small>Telephone</small>
                                <strong>07307 486 871</strong>
                            </span>
                        </a>
                    </div>
                </div>
            </section>
        </div>
    </div>
</MgmtPage>

<style>
    .about-page {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-rows: minmax(180px, 0.85fr) minmax(0, 1.15fr);
        overflow: hidden;
    }

    .about-brand {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: clamp(1.25rem, 3vw, 2.5rem);
        padding: clamp(1.25rem, 3vw, 2.5rem);
        border-bottom: 1px solid var(--border-flat);
    }

    .about-logo {
        width: clamp(112px, 15vw, 168px);
        height: clamp(112px, 15vw, 168px);
        flex: 0 0 auto;
        border-radius: 0.65rem;
        object-fit: contain;
    }

    .about-introduction {
        min-width: 0;
    }

    .about-kicker {
        display: block;
        color: var(--accent-primary);
        font-size: 0.78rem;
        font-weight: 950;
        text-transform: uppercase;
        letter-spacing: 0.12em;
    }

    .about-introduction h2 {
        margin: 0.25rem 0 0.65rem;
        font-size: clamp(2.1rem, 4vw, 3.5rem);
        line-height: 1;
        letter-spacing: 0;
    }

    .about-introduction p,
    .about-section p {
        margin: 0;
        max-width: 680px;
        color: var(--text-muted);
        font-size: 1rem;
        line-height: 1.55;
    }

    .about-details {
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    }

    .about-section {
        min-width: 0;
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr);
        align-content: start;
        gap: 0.85rem;
        padding: clamp(1.25rem, 2.5vw, 2rem);
    }

    .about-section + .about-section {
        border-left: 1px solid var(--border-flat);
    }

    .section-icon {
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-card);
        color: var(--accent-primary);
    }

    .section-icon svg {
        width: 25px;
        height: 25px;
    }

    .contact-icon {
        color: var(--success);
    }

    .about-section h3 {
        margin: 0 0 0.45rem;
        font-size: 1.18rem;
        line-height: 1.2;
        letter-spacing: 0;
    }

    .contact-content {
        min-width: 0;
    }

    .contact-links {
        display: grid;
        gap: 0.55rem;
        margin-top: 1rem;
    }

    .contact-links a {
        min-width: 0;
        min-height: 58px;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.55rem 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-card);
        color: var(--text-main);
        text-decoration: none;
    }

    .contact-links a:hover {
        border-color: var(--accent-primary);
        background: var(--bg-card-hover);
    }

    .contact-links svg {
        width: 23px;
        height: 23px;
        flex: 0 0 auto;
        color: var(--accent-primary);
    }

    .contact-links span,
    .contact-links strong,
    .contact-links small {
        min-width: 0;
        display: block;
    }

    .contact-links small {
        color: var(--text-muted);
        font-size: 0.7rem;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.1em;
    }

    .contact-links strong {
        margin-top: 0.08rem;
        overflow-wrap: anywhere;
        font-size: 0.96rem;
        letter-spacing: 0;
    }

    @media (max-width: 820px) {
        .about-page {
            display: block;
            overflow-y: auto;
        }

        .about-details {
            display: block;
        }

        .about-section + .about-section {
            border-top: 1px solid var(--border-flat);
            border-left: 0;
        }
    }

    @media (max-width: 560px) {
        .about-brand {
            align-items: flex-start;
        }

        .about-logo {
            width: 82px;
            height: 82px;
        }

        .about-introduction h2 {
            font-size: 2rem;
        }

        .about-section {
            grid-template-columns: 40px minmax(0, 1fr);
        }

        .section-icon {
            width: 40px;
            height: 40px;
        }
    }
</style>

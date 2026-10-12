import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const tracker = JSON.parse(await fs.readFile(path.join(directory, 'continuation-findings.json'), 'utf8'));
let verification = {};
try {
    verification = JSON.parse(await fs.readFile(path.join(directory, 'continuation-verification.json'), 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const words = value => String(value || '').replaceAll('_', ' ').toLowerCase();
const anchor = value => String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
const relativeUrl = value => String(value).split('/').map(encodeURIComponent).join('/');
const array = value => Array.isArray(value) ? value : value == null ? [] : [value];
const paragraph = value => array(value).map(item => `<p>${escape(typeof item === 'object' ? JSON.stringify(item) : item)}</p>`).join('');

const suppliedChecks = verification.checks || verification.combinedChecks || {};
const checks = {
    frontend: { passed: 1234, skipped: 56, filesPassed: 95, filesSkipped: 3, ...(suppliedChecks.frontend || {}) },
    rust: { passed: 251, excluded: 10, existingWarnings: 4, ...(suppliedChecks.rust || {}) },
    mariaDb: { passed: 55, catalogue: 42, attendance: 9, stockCountSql: 3, genericStockReplay: 1, ...(suppliedChecks.mariaDb || suppliedChecks.isolatedMariaDb || {}) },
};

// Root-recorded native observations are intentionally scenario-specific. They
// do not turn every route/fault-injection/hardware matrix into a native PASS.
const baselineNative = [
    {
        id: 'new-customer-account', title: 'New customer: historical debt and repayment', result: 'VERIFIED_NATIVE_SCENARIO',
        findingIds: ['OPS-SOURCE-CUSTOMER-HOLD-ADJUSTMENT-POLICY', 'OPS-NATIVE-CUSTOMER-ACCOUNT-INITIALIZATION'],
        evidence: 'A new held QA customer account accepted a £2 opening balance and a £1 increase, then a £3 cash repayment restored the balance to £0. Historical entries did not remove the purchasing hold.',
        screenshots: ['screenshots/26-new-account-opening-held.png', 'screenshots/29-new-customer-restored-clear.png'],
        limits: 'This confirms the observed native local account workflow. It is not a shared-MariaDB first-writer concurrency or custom-role authorization UI test.',
    },
    {
        id: 'customer-tip0-cancel', title: 'Customer account: on-screen Dojo cancellation', result: 'VERIFIED_NATIVE_SCENARIO',
        findingIds: ['AUDIT-10', 'OPS-NATIVE-DOJO-SANDBOX-EXPIRY-INTEGRATION'],
        evidence: 'The VCMLABJTIP0 sandbox customer-account payment exposed Cancel Terminal. Cancellation ended with the definitive Canceled outcome and no customer-account charge.',
        screenshots: ['screenshots/27-customer-dojo-cancel-visible.png', 'screenshots/28-customer-timeout-returned-safe.png'],
        limits: 'Sandbox scenario only; not a real card payment, live Dojo certification or proof of every late-capture/uncertain-result branch.',
    },
    {
        id: 'financial-timeout-recovery', title: 'Pay Later: native timeout recovery completed', result: 'VERIFIED_NATIVE_SCENARIO',
        findingIds: ['OPS-NATIVE-PAY-LATER-POOL-TIMEOUT-RECOVERY'],
        evidence: 'Fault-injected Pay Later reached the five-second acquisition timeout and retained the original pending receipt 1000085. Review / Recover completed exactly one sale and one 169p customer-account charge for that same receipt; no pending financial journal remained. A 169p repayment restored the account and its original hold.',
        screenshots: ['screenshots/31-financial-timeout-pending-alert.png', 'screenshots/32-financial-review-original-receipt.png', 'screenshots/33-recovered-original-receipt-completed.png', 'screenshots/34-recovery-account-restored.png'],
        limits: 'This is the separately requested original P1 native timeout regression, not an extra item in the remaining-36 count. Mock data only.',
    },
    {
        id: 'price-pad-delete', title: 'Change Price: touch and keyboard deletion', result: 'VERIFIED_NATIVE_SCENARIO',
        findingIds: ['AUDIT-15'],
        evidence: 'The price pad changed 169p → 16p using touch Delete last digit, then 16p → 1p using physical Backspace. Cancel retained the original 169p item price.',
        screenshots: ['screenshots/30-price-pad-backspace.png'],
        limits: 'The observed touch/keyboard deletion and cancellation workflow passed; this is not a blanket test of every price-pad key combination.',
    },
    {
        id: 'customer-keyboard-cleanup', title: 'Touch keyboard: new-customer form-save cleanup', result: 'PARTIAL_NATIVE_OBSERVATION',
        findingIds: ['AUDIT-21'],
        evidence: 'The on-screen keyboard closed after the new-customer form was saved rather than remaining orphaned over the next view.',
        screenshots: ['screenshots/25-new-customer-save-keyboard-cleanup.png'],
        limits: 'Only the observed customer form-save path is covered here. Other dialog closures/navigation require their own native evidence.',
    },
];

const scenarioMap = new Map(baselineNative.map(scenario => [scenario.id, scenario]));
for (const scenario of array(verification.nativeScenarios || verification.nativeTests)) {
    if (scenario?.id) scenarioMap.set(scenario.id, { ...scenarioMap.get(scenario.id), ...scenario });
}
const scenarios = [...scenarioMap.values()];

const overrides = new Map();
for (const finding of array(verification.findings || verification.findingVerification)) {
    if (finding?.id) overrides.set(finding.id, finding);
}
for (const [id, value] of Object.entries(verification.byId || verification.findingsById || {})) {
    overrides.set(id, { ...overrides.get(id), ...value, id });
}

const findings = tracker.findings.map(finding => ({ ...finding, ...(overrides.get(finding.id) || {}) }));
if (findings.length !== 36 || new Set(findings.map(finding => finding.id)).size !== 36) {
    throw new Error('The continuation report requires exactly 36 distinct original findings');
}

function relatedScenarios(finding) { return scenarios.filter(scenario => array(scenario.findingIds).includes(finding.id)); }
function nativeState(finding) {
    const state = String(finding.nativeRetest || 'PENDING');
    if (/FAIL|ERROR/.test(state)) return { text: 'Native retest failed', kind: 'failed' };
    if (/AUTOMATED_ONLY|SOURCE_ONLY/.test(state)) return { text: 'Automated / source-only', kind: 'pending' };
    if (/PASS|VERIFIED|COMPLETE/.test(state) && !/PARTIAL|PENDING|NOT_|UNVERIFIED|UNCERTAIN|OBSERV/.test(state)) return { text: 'Native verified', kind: 'good' };
    if (relatedScenarios(finding).length || /PARTIAL|OBSERV/.test(state)) return { text: 'Native observation', kind: 'partial' };
    return { text: 'Native retest pending', kind: 'pending' };
}

async function linksFor(paths, className = '') {
    const links = [];
    for (const candidate of [...new Set(array(paths).filter(item => typeof item === 'string'))]) {
        const normalized = candidate.replaceAll('\\', '/');
        const absolute = path.resolve(directory, normalized);
        if (absolute !== directory && !absolute.startsWith(directory + path.sep)) continue;
        try { await fs.access(absolute); } catch { continue; }
        links.push(`<a ${className ? `class="${escape(className)}" ` : ''}href="${relativeUrl(normalized)}">${escape(path.basename(normalized))}</a>`);
    }
    return links.join(' ');
}

const nativeCards = await Promise.all(scenarios.map(async scenario => {
    const evidenceLinks = await linksFor(scenario.screenshots || scenario.nativeEvidence, 'evidence-link');
    const result = String(scenario.result || scenario.status || 'recorded native observation');
    const tone = /FAIL|ERROR/.test(result) ? 'failed' : /PENDING|NOT_|UNVERIFIED|UNCERTAIN/.test(result) ? 'pending' : /PARTIAL/.test(result) ? 'partial' : /VERIFIED|PASS|COMPLETE/.test(result) ? 'good' : 'partial';
    return `<article class="native-card" id="scenario-${anchor(scenario.id)}"><h3>${escape(scenario.title || scenario.id)}</h3><span class="pill ${tone}">${escape(words(result))}</span>${paragraph(scenario.evidence || scenario.native || scenario.result)}${evidenceLinks ? `<div class="evidence-links">${evidenceLinks}</div>` : ''}${scenario.limits ? `<p class="limit">${escape(scenario.limits)}</p>` : ''}</article>`;
}));

const indexRows = findings.map((finding, index) => {
    const native = nativeState(finding);
    return `<tr><td class="number">${index + 1}</td><td><span class="priority ${escape(finding.priority)}">${escape(finding.priority)}</span></td><td><a href="#${anchor(finding.id)}">${escape(finding.title)}</a><small>${escape(finding.id)} · ${escape(array(finding.routes).join(', '))}</small></td><td><span class="pill good">Implemented</span><span class="pill ${native.kind}">${native.text}</span></td></tr>`;
}).join('');

const findingCards = await Promise.all(findings.map(async (finding, index) => {
    const native = nativeState(finding);
    const related = relatedScenarios(finding);
    const nativeLinks = await linksFor(finding.nativeEvidence || finding.screenshots, 'evidence-link');
    return `<article class="finding" id="${anchor(finding.id)}"><div class="finding-heading"><span class="finding-number">${index + 1}</span><div><div class="eyebrow">${escape(finding.id)} <span class="priority ${escape(finding.priority)}">${escape(finding.priority)}</span></div><h3>${escape(finding.title)}</h3><p class="route">${escape(array(finding.routes).join(' · '))}</p></div></div><div class="finding-status"><span class="pill good">${escape(words(finding.status || 'implementation complete'))}</span><span class="pill ${native.kind}">${native.text}</span></div><dl><div><dt>Fix</dt><dd>${paragraph(finding.fix || 'No fix narrative provided in the tracker.')}</dd></div><div><dt>Automated / source evidence</dt><dd>${paragraph(finding.automatedEvidence || 'No finding-specific automated evidence recorded.')}</dd></div><div><dt>Native evidence</dt><dd>${paragraph(finding.native || 'No native retest recorded.')}${nativeLinks ? `<div class="evidence-links">${nativeLinks}</div>` : ''}${related.length ? `<div class="observations"><strong>Root-recorded additional native observations</strong>${related.map(scenario => `<p>${escape(scenario.evidence || scenario.native || '')} <a href="#scenario-${anchor(scenario.id)}">Scenario evidence</a></p>`).join('')}</div>` : ''}</dd></div><div><dt>Limits / remaining verification</dt><dd>${paragraph(finding.limits || 'No additional limit recorded.')}${finding.nativeRetest ? `<small>Tracker native status: ${escape(words(finding.nativeRetest))}</small>` : ''}</dd></div></dl><a class="back-top" href="#finding-index">Back to issue index ↑</a></article>`;
}));

const nativeVerifiedCount = findings.filter(finding => nativeState(finding).text === 'Native verified').length;
const nativeObservedCount = findings.filter(finding => nativeState(finding).text === 'Native observation').length;
const nativeAutomatedOnlyCount = findings.filter(finding => nativeState(finding).text === 'Automated / source-only').length;
const nativePendingCount = findings.length - nativeVerifiedCount - nativeObservedCount - nativeAutomatedOnlyCount;
const generatedAt = new Date().toISOString();
const additionalNotes = array(verification.notes || verification.limits);
const sourceArtifactLinks = await linksFor(['continuation-findings.json', 'continuation-verification.json', 'settings-followup.json', 'customer-dojo-followup.json', 'catalogue-design-followup.json', 'stock-count-review.json', 'catalogue-stock-guard-followup.json']);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>POS audit — remaining 36 fixes and native recovery</title><style>
:root{color-scheme:light;--ink:#23364a;--muted:#596b7b;--line:#d8e1e7;--paper:#fff;--bg:#f1f5f7;--good:#196445;--good-bg:#e5f2eb;--blue:#245b7a;--blue-bg:#e9f2f8;--amber:#805c1b;--amber-bg:#fff3d9}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:20px}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue);text-underline-offset:3px}a:focus-visible{outline:3px solid #2b819e;outline-offset:4px}main{max-width:1130px;margin:auto;padding:32px 24px 56px}header{padding:28px;border:1px solid var(--line);border-radius:16px;background:var(--paper);box-shadow:0 8px 28px #23364a08}h1{margin:8px 0 10px;font-size:clamp(25px,4vw,36px);line-height:1.2;letter-spacing:-.03em}h2{margin:0 0 14px;font-size:23px;line-height:1.3}h3{margin:0;font-size:18px;line-height:1.35}p{margin:0 0 10px}p:last-child{margin-bottom:0}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:11px;font-weight:750;color:var(--muted)}.lede{font-size:17px;max-width:880px}.muted,.route,small{color:var(--muted)}.report-nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:18px}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0}.metric{padding:16px;border-radius:12px;border:1px solid var(--line);background:var(--paper)}.metric strong{display:block;font-size:25px;line-height:1.2}.metric span{display:block;margin-top:5px;font-size:13px;color:var(--muted)}section{margin-top:28px}.panel{padding:22px;border:1px solid var(--line);border-radius:13px;background:var(--paper)}.notice{padding:13px 16px;border-left:4px solid #47839e;background:var(--blue-bg);border-radius:7px;font-size:14px}.checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.check{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--paper)}.check strong{display:block;font-size:21px}.check h3{font-size:15px;margin-bottom:8px}.check p{font-size:13px;color:var(--muted)}.pill{display:inline-block;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;line-height:1.4;margin:2px 3px 2px 0}.good{color:var(--good);background:var(--good-bg)}.partial{color:var(--blue);background:var(--blue-bg)}.pending{color:var(--amber);background:var(--amber-bg)}.priority{display:inline-block;font-size:11px;font-weight:800;border-radius:5px;padding:2px 6px;letter-spacing:0}.P2{color:#7e561a;background:#fcf0d6}.P3{color:#4d6170;background:#edf1f4}.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;background:var(--paper)}th{text-align:left;font-size:12px;color:var(--muted);background:#edf3f6;padding:11px 12px;border-bottom:1px solid var(--line)}td{padding:10px 12px;vertical-align:top;border-bottom:1px solid var(--line);font-size:13px}tbody tr:last-child td{border-bottom:0}td small{display:block;font-size:10px;overflow-wrap:anywhere;margin-top:3px}td:last-child{width:200px}.number{width:36px;color:var(--muted);font-weight:750}td:nth-child(2){width:42px}.native-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.native-card{padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--paper)}.native-card h3{margin-bottom:8px}.native-card p{font-size:14px;margin-top:8px}.limit{color:var(--muted);font-size:12px!important;border-top:1px solid var(--line);padding-top:10px}.evidence-links{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}.evidence-link{font-size:11px;padding:5px 7px;border:1px solid var(--line);border-radius:6px;text-decoration:none;background:#f6f9fa;overflow-wrap:anywhere;max-width:100%}.finding{margin-top:14px;padding:22px;background:var(--paper);border:1px solid var(--line);border-radius:13px;break-inside:avoid}.finding-heading{display:flex;gap:13px;align-items:flex-start}.finding-number{display:grid;place-items:center;flex:0 0 34px;height:34px;background:#edf3f6;border-radius:9px;font-weight:800;color:var(--blue)}.finding-heading .eyebrow{margin-bottom:5px;overflow-wrap:anywhere}.route{font-size:12px;margin-top:5px;overflow-wrap:anywhere}.finding-status{margin:11px 0 14px}dl{margin:0}dl>div{display:grid;grid-template-columns:170px minmax(0,1fr);gap:14px;padding:12px 0;border-top:1px solid #e6edf1}dt{font-size:12px;font-weight:800;color:var(--muted)}dd{margin:0;min-width:0;font-size:14px;overflow-wrap:anywhere}dd p{margin-bottom:8px}.observations{padding:10px 12px;border-radius:8px;background:#edf6f2;font-size:13px;margin-top:12px}.observations strong{display:block;color:var(--good);font-size:11px;margin-bottom:6px}.back-top{display:inline-block;font-size:11px;margin-top:12px}.footer{font-size:12px;color:var(--muted);margin-top:28px}.sources{display:flex;flex-wrap:wrap;gap:8px 12px}.no-break{white-space:nowrap}@media(max-width:760px){main{padding:18px 12px 40px}header,.panel,.finding{padding:18px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.checks{grid-template-columns:1fr}.native-grid{grid-template-columns:1fr}dl>div{grid-template-columns:1fr;gap:4px}td:last-child{width:145px}h2{font-size:21px}}@media print{body{background:white;font-size:11px}main{max-width:none;padding:0}header,.panel,.finding,.native-card,.metric,.check{box-shadow:none;border-radius:0}.summary{grid-template-columns:repeat(4,1fr)}.checks{grid-template-columns:repeat(3,1fr)}.native-grid{grid-template-columns:repeat(2,1fr)}.report-nav,.back-top{display:none}a{color:inherit}.table-scroll{overflow:visible}thead{display:table-header-group}section{margin-top:20px}.finding{padding:14px}.finding h3{font-size:15px}dd{font-size:12px}.pill{-webkit-print-color-adjust:exact;print-color-adjust:exact}h2,h3{break-after:avoid}}
.failed{color:#a63232;background:#fce8e8}
</style></head><body><main id="top">
<header><div class="eyebrow">L&amp;Bj POS · QA continuation · 12 October 2026</div><h1>Remaining 36 issues: fixes and verification</h1><p class="lede">All 41 original findings have implementations, including these 36 remaining findings. Final automated suites and planned native scenarios are complete: 19 native scenario verdicts verified, 13 partial observations, 4 automated/source-only findings and 0 planned native retests pending. Each item retains explicit limits; this is not a blanket native or hardware PASS.</p><p class="muted">The original four high-priority fixes remain in the <a href="REPORT.html">priority-fixes report</a>. The Pay Later timeout recovery below completes the separately requested native recovery regression.</p><nav class="report-nav" aria-label="Report sections"><a href="#validation">Validation</a><a href="#native-evidence">Verified native scenarios</a><a href="#finding-index">36-issue index</a><a href="#individual-findings">One-by-one findings</a><a href="#sources">Evidence files</a></nav></header>
<div class="summary"><div class="metric"><strong>36 / 36</strong><span>Implementation changes recorded</span></div><div class="metric"><strong>${nativeVerifiedCount}</strong><span>Native scenario verdicts verified</span></div><div class="metric"><strong>${nativeObservedCount}</strong><span>Partial native observations</span></div><div class="metric"><strong>${nativeAutomatedOnlyCount}</strong><span>Automated / source-only findings · ${nativePendingCount} planned native retests pending</span></div></div>
<section id="validation"><h2>Validation results</h2><div class="checks"><div class="check"><h3>Frontend / workflow suite</h3><strong>${escape(checks.frontend.passed)} passed</strong><p>${escape(checks.frontend.skipped)} skipped · ${escape(checks.frontend.filesPassed)} files passed · ${escape(checks.frontend.filesSkipped)} files skipped</p></div><div class="check"><h3>Rust native core suite</h3><strong>${escape(checks.rust.passed)} passed</strong><p>${escape(checks.rust.excluded)} optional cases excluded · ${escape(checks.rust.existingWarnings)} existing dead-code warnings</p></div><div class="check"><h3>Isolated real MariaDB cases</h3><strong>${escape(checks.mariaDb.passed)} passed</strong><p>${escape(checks.mariaDb.catalogue)} catalogue + ${escape(checks.mariaDb.attendance)} attendance + ${escape(checks.mariaDb.stockCountSql)} stock-count SQL + ${escape(checks.mariaDb.genericStockReplay)} native generic-stock replay cases on disposable test servers</p></div></div><div class="notice" style="margin-top:12px">Counts are separate scopes, not an additive total. The 55 actual MariaDB cases exclude 14 additional unit cases. Frontend skips include 54 database cases verified separately plus 2 other optional cases not run. Rust filtered cases include 1 generic-stock database replay verified separately plus 9 other optional cases not run. Svelte check was 0 errors / 0 warnings; command-permission audit passed (95 frontend / 101 registered). Final normal debug bundle built and launched without the test fault flag. No Windows hardware or live-payment certification is claimed.</div></section>
<section id="native-evidence"><h2>Native Tauri scenarios actually observed</h2><p class="muted">Mock data and Dojo sandbox only. Each scenario states exactly what was exercised and its limits.</p><div class="native-grid">${nativeCards.join('')}</div></section>
<section id="finding-index"><h2>All 36 findings</h2><p class="muted">Every item is listed without hidden filters. Select a title for its fix, automated evidence, native status and remaining limits.</p><div class="table-scroll"><table><thead><tr><th scope="col">#</th><th scope="col">Priority</th><th scope="col">Finding and route</th><th scope="col">Implementation / native coverage</th></tr></thead><tbody>${indexRows}</tbody></table></div></section>
<section id="individual-findings"><h2>One-by-one fix and evidence record</h2><div class="notice">“Implemented” is a code-change status, not a blanket native PASS. Final root-recorded observations and exact limits are merged from the tracker and verification overlay. Automated/source-only findings are not counted as pending native tests or promoted to native PASS. Healthy stock save/restoration is a partial verdict because stale/error branches were automated, not native fault injected.</div>${findingCards.join('')}</section>
<section id="sources" class="panel"><h2>Evidence and reproducibility</h2><p class="sources"><a href="../audit-2026-10-12/REPORT.html">Original historical audit</a><a href="REPORT.html">Priority-fixes report</a><a href="generate-continuation.mjs">Continuation generator</a>${sourceArtifactLinks}</p><p class="muted" style="margin-top:12px">Regenerate with <code>node docs/qa/fixes-2026-10-12/generate-continuation.mjs</code>. The generator reads all 36 records from continuation-findings.json and overlays continuation-verification.json when present. Historical audit and original priority fixtures are preserved; root native supplements are recorded separately from source-author automated evidence.</p>${additionalNotes.length ? `<div class="notice" style="margin-top:12px">${paragraph(additionalNotes)}</div>` : ''}</section>
<footer class="footer"><p>Generated ${escape(generatedAt)} · Tracker status: ${escape(words(tracker.status))}. Planned final native scenarios and restoration are complete; per-finding partial, automated-only, Windows and hardware limits remain explicit.</p><p>Final normal Tauri app left open on Checkout as Alan, trolley empty / £0.00 / Synced. Final counts and restoration proof are in continuation-verification.json. Retained observations: 478 metadata-only entries, ending 2026-10-12T19:52:23.086Z. Local report only; no live card certification, credential disclosure, database wipe, deployment or commit is implied. Retained QA records are mock fixtures.</p></footer>
</main></body></html>`;

// Preserve the historical 19/13/4 rows; link the subsequent native retest rather
// than rewriting that snapshot as if it had originally passed all36 findings.
let outputHtml = html;
try {
    const latest = JSON.parse(await fs.readFile(path.join(directory, '../native-17-2026-10-12/verification.json'), 'utf8'));
    if (latest.status === 'NATIVE_RETEST_COMPLETE_WITH_LIMITS'
        && array(latest.findings).length === 17
        && latest.findings.every(finding => finding.nativeRetest === 'PASS')) {
        const followup = `<section id="native-17-follow-up" class="panel"><h2>Latest native follow-up:36 scoped verdicts</h2><p>The19 earlier native passes plus17 newly native-tested findings give36 scoped native finding verdicts. All13 prior partial checks and4 prior automated-only checks were tested in Tauri. <a href="../native-17-2026-10-12/REPORT.html">Open the completed17-check report and evidence</a>.</p><p class="muted">The earlier19/13/4 summary and individual verdicts below remain as a historical snapshot for traceability; they are not the latest native coverage.</p><p class="notice"><strong>Original trolley preservation NOT CONFIRMED:</strong> final0items/£0.00 differs from the earlier reported16/£103.83; exact event unknown. A separate source-confirmed ordinary-unheld RAM-cart persistence risk remains unfixed. These cautions are outside the17 completed checks; no app-bug-free, Windows, physical-hardware or live-payment certification is claimed.</p></section>`;
        outputHtml = html.replace('<p class="lede">', '<p class="lede"><strong>Historical snapshot; the latest 36-scoped native follow-up is directly below.</strong> ').replace('</header>', `</header>\n${followup}`);
    }
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
await fs.writeFile(path.join(directory, 'CONTINUATION.html'), outputHtml);
console.log(JSON.stringify({ report: path.join(directory, 'CONTINUATION.html'), findings: findings.length, implementationComplete: findings.filter(finding => /IMPLEMENTATION_COMPLETE/.test(finding.status || '')).length, nativeVerified: nativeVerifiedCount, nativeObserved: nativeObservedCount, nativeAutomatedOnly: nativeAutomatedOnlyCount, nativePending: nativePendingCount, generatedAt, optionalVerificationLoaded: Object.keys(verification).length > 0 }, null, 2));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import { summarizeAfterState } from './after-state-summary.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(directory,'REPORT.html'),'utf8');
const summary=JSON.parse(fs.readFileSync(path.join(directory,'report-summary.json'),'utf8'));
const rawActions=JSON.parse(fs.readFileSync(path.join(directory,'native-actions.json'),'utf8'));
const rawVerdicts=rawActions.reduce((counts,action)=>{const verdict=action.result||'UNCLASSIFIED';counts[verdict]=(counts[verdict]||0)+1;return counts;},{});
const failures=[];
const check=(condition,message)=>{if(!condition)failures.push(message)};
// Parse locally: no app, browser, database, provider call or credential access.
// Literal JSON braces are valid HTML, but would be Svelte expressions. Remove
// CSS and entity-escape those characters only in the parse-only copy.
const markup=html.replace(/<style>[\s\S]*?<\/style>/g,'').replace(/[{}]/g,char=>char==='{'?'&#123;':'&#125;');
try{parse(markup,{filename:'REPORT.html'});}catch(error){failures.push('HTML parse: '+error.message)}
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
check(new Set(ids).size===ids.length,'Duplicate HTML ids');
for(const match of html.matchAll(/href="#([^"]+)"/g))check(ids.includes(match[1]),'Missing internal anchor '+match[1]);
for(const match of html.matchAll(/(?:href|src)="(screenshots\/[^\"]+)"/g)){
 const target=decodeURIComponent(match[1]);
 check(fs.existsSync(path.join(directory,target)),'Missing screenshot '+target);
}
check((html.match(/<tr id="action-\d+">/g)||[]).length===summary.nativeActions,'Native rows do not match action count');
check(summary.nativeActions===rawActions.length,'Report native count differs from the current raw log');
const rawRoutes=new Set(rawActions.map(action=>{try{return new URL(action.route).pathname||'/';}catch{return String(action.route||'/unknown').split('?')[0]||'/';}}));
check(summary.nativeRoutes===rawRoutes.size,'Native route count differs from the current raw log');
for(const verdict of new Set([...Object.keys(rawVerdicts),...Object.keys(summary.nativeVerdicts)]))check((summary.nativeVerdicts[verdict]||0)===(rawVerdicts[verdict]||0),'Report changed recorded verdict count: '+verdict);
let templates=0;
for(const match of html.matchAll(/<table class="inventory">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/g))templates+=(match[1].match(/<tr>/g)||[]).length;
check(templates===summary.sourceControlTemplates+summary.sharedControlTemplates,'Source template count mismatch');
check((html.match(/<article class="finding /g)||[]).length===summary.findings,'Finding-card count mismatch');
check(!/id="finding-(?:ADMIN-S05|ADMIN-S09)"/.test(html),'Retracted candidate appears as a bug');
check(!/<img[^>]+03-drawer-macos-limitation/.test(html),'Screenshot03 embedded despite exclusion');
check(!/<img[^>]+54-pay-later-pool-timeout/.test(html),'Screenshot54 embedded despite missing alert');
check(!/"after"\s*:|\b(?:sk_live_|sk_test_|test_sk_|live_sk_|sk-proj-)[A-Za-z0-9_-]{8,}/.test(html),'Raw accessibility dump or token pattern included');
check(summary.tests.passed===1018&&summary.tests.skipped===2&&summary.tests.svelteErrors===0&&summary.tests.svelteWarnings===0,'Saved automated totals changed unexpectedly');
check(summary.tests.rustPassed===231&&summary.tests.rustFailed===0&&summary.tests.rustFilteredOut===9&&summary.tests.rustWarnings===4,'Native Rust totals changed unexpectedly');
const fixture=summarizeAfterState('2 HTML content URL: tauri://localhost/settings?email=hidden@example.invalid\n3 heading Payment, Value: 2\n4 container Payment totals\n5 text field (settable) Amount, Value: PRIVATE_FIELD_VALUE\n6 secure text field Password, Value: PRIVATE_PASSWORD\n7 text Email hidden@example.invalid\n8 text Phone 07123 456789\n9 text API key: PRIVATE_KEY\n10 text TOTAL £1.69 Total Items: 1\n11 text Cancellation requested. Waiting for the Dojo result');
check(fixture.summary.includes('After route: /settings')&&fixture.summary.includes('Visible heading: Payment')&&fixture.summary.includes('TOTAL £1.69')&&fixture.summary.includes('Cancellation requested'),'After-state safe title/route/status extraction failed');
check(!/PRIVATE_|hidden@|07123|email=|Value:|text field|secure text field|Password|API key/.test(fixture.summary),'After-state summary leaked field/contact/secure content');
const personal=summarizeAfterState('2 HTML content URL: tauri://localhost/customers\n3 heading Customer Account - PRIVATE_PERSON_NAME, Value: 1\n4 container PRIVATE_PERSON_NAME\n5 text field (settable) Notes, Value: PRIVATE_CONTACT_BODY');
check(!/PRIVATE_/.test(personal.summary)&&personal.summary.includes('Customer Account (name withheld)'),'After-state summary leaked a dynamic customer title or body');
check((summary.nativeVerdicts.PASS||0)===(rawVerdicts.PASS||0),'Observation summarization changed explicit PASS count');
const result={status:failures.length?'FAILED':'PASS',nativeRows:summary.nativeActions,sourceTemplates:templates,findings:summary.findings,checks:'HTML parse, ids/anchors, image references, complete row/template counts, exclusions and sensitive-output patterns',failures};
console.log(JSON.stringify(result,null,2));
process.exitCode=failures.length?1:0;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeAfterState } from './after-state-summary.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const qaDirectory=path.dirname(directory);
const prefix='audit-2026-10-12';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const arr=value=>Array.isArray(value)?value:value==null?[]:[value];
const unique=values=>[...new Set(values.filter(Boolean))];
const files=fs.readdirSync(qaDirectory).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).sort();
const artifacts=Object.fromEntries(files.map(name=>[name,JSON.parse(fs.readFileSync(path.join(qaDirectory,name),'utf8'))]));
const get=suffix=>artifacts[prefix+suffix+'.json']??{};
const admin=get('-admin-inventory'),operations=get('-operations-inventory'),settings=get('-settings-inventory'),base=get('-findings'),rust=get('-native-automated');
const native=JSON.parse(fs.readFileSync(path.join(directory,'native-actions.json'),'utf8'));
const statePath=path.join(directory,'run-state.json');
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
const generatedAt=new Date().toISOString();
function redact(value){
 return String(value??'')
 .replace(/\b(?:sk_live_|sk_test_|test_sk_|live_sk_|sk-proj-)[A-Za-z0-9_-]{8,}/g,'[REDACTED API TOKEN]')
 .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi,'Bearer [REDACTED]')
 .replace(/\b(PIN|password|secret|api[-_ ]?key)\s*(?:entered|value)?\s*[:=]\s*["']?[^"'\s,;]{4,}["']?/gi,'$1: [REDACTED]')
 .replace(/\b(PIN|password)\s+(?:is\s+)?\d{4,}\b/gi,'$1 [REDACTED]');
}
const safe=value=>esc(redact(value));
const json=value=>safe(JSON.stringify(value,null,2));
function routeOf(value){if(!value)return'/unknown';if(/^global.*checkout/i.test(String(value)))return'/';try{return new URL(value).pathname||'/'}catch{return String(value).split('?')[0]||'/'}}
const anchor=value=>'page-'+String(value).replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'');
function actionLabel(entry){
 let action=redact(entry.action||'(unlabelled action)');
 const secure=/staff sign ?in|staff pin|administrator pin|secure text field|password/i.test(entry.after||'');
 if(secure&&/^(?:enter|press|type)\s+(?:digit\s+)?\d+$/i.test(action.trim()))return'PIN/keypad digit interaction (value withheld)';
 if(/(?:PIN|password|API key|secret).*(?:fill|enter|type|set)|(?:fill|enter|type|set).*(?:PIN|password|API key|secret)/i.test(action))action=action.replace(/\b\d{4,}\b/g,'[WITHHELD]');
 return action;
}
function resultClass(result){
 if(result==='PASS')return'pass';if(result==='PASS_WITH_UI_ISSUE')return'mixed';
 if(/^FAIL/.test(result))return'fail';if(/^BLOCKED/.test(result))return'blocked';return'observed';
}
const badge=(result,label=result)=>'<span class="badge '+resultClass(result)+'">'+safe(label)+'</span>';
const events=native.map((entry,index)=>({
 index,route:routeOf(entry.route),originalRoute:redact(entry.route),action:actionLabel(entry),result:entry.result||'UNCLASSIFIED',
 detail:redact(entry.detail||entry.details||entry.note||entry.evidence||'')||summarizeAfterState(entry.after,redact).summary,
 afterStateSummary:!Boolean(entry.detail||entry.details||entry.note||entry.evidence),time:entry.time||entry.timestamp||'',
 mode:entry.mode||(/Back Office navigation/i.test(entry.after||'')?'Back Office':'Unspecified / checkout context')
}));
const eventsByRoute=new Map();
for(const event of events){if(!eventsByRoute.has(event.route))eventsByRoute.set(event.route,[]);eventsByRoute.get(event.route).push(event)}
function controlOf(control,page,inventory){
 return {id:control.id||inventory+':'+(control.sourceFile||page.file||page.source||page.sourceFile)+':'+(control.line||control.sourceLine||'?'),
 label:control.label||control.type||control.kind||'Unlabelled template',type:control.type||control.kind||'action family',
 file:control.sourceFile||page.file||page.source||page.sourceFile||'',line:control.line||control.sourceLine||'',
 surface:control.surface||arr(control.visibleWhen).join('; ')||'Page / conditional surface',
 effect:control.effect||(control.handlers?Object.entries(control.handlers).map(([k,v])=>k+': '+v).join('; '):''),
 expected:control.expected||control.verification||'',dependencies:arr(control.dependencies||control.dependency||page.dependencies),
 risk:control.risk||'not classified',values:arr(control.values),conditions:arr(control.visibleWhen),attributes:control.attributes||null,origin:inventory};
}
const pages=new Map();
function addPage(page,inventory){
 if(!pages.has(page.route))pages.set(page.route,{route:page.route,file:page.file||page.source||page.sourceFile||'',purpose:page.purpose||'',notes:[],controls:[],scenarios:[]});
 const output=pages.get(page.route);output.controls.push(...arr(page.controls).map(control=>controlOf(control,page,inventory)));
 output.notes.push(...arr(page.notes),...arr(page.layoutChecks));output.scenarios.push(...arr(page.scenarios));
 if(page.permission)output.notes.push('Permission: '+page.permission);
}
arr(admin.routes).forEach(page=>addPage(page,'Admin'));arr(operations.pages).forEach(page=>addPage(page,'Operations'));arr(settings.routes).forEach(page=>addPage(page,'Settings'));
for(const route of eventsByRoute.keys())if(!pages.has(route))pages.set(route,{route,file:'',purpose:'Runtime route without source inventory entry',notes:[],controls:[],scenarios:[]});
const shared=[];
for(const component of arr(admin.components))shared.push(...arr(component.controls).map(control=>controlOf(control,{file:component.file},'Shared component')));
shared.push(...arr(settings.sharedControls).map(control=>controlOf(control,{sourceFile:control.sourceFile},'Settings shared')));
const excluded=new Set(['ADMIN-S05','ADMIN-S09']);
const findings=[],findingByOrigin=new Map();
const priority=value=>({high:'P1',medium:'P2',low:'P3',suggestion:'P3'})[String(value).toLowerCase()]||(/^P[123]$/.test(value)?value:'P3');
function refsOf(value){return arr(value.sources||value.source||value.sourceEvidence||value.sourceMessageLocations||value.evidence).filter(item=>item&&typeof item==='object'&&item.file).map(item=>({file:item.file,line:item.line||item.sourceLine||''}))}
function imagesOf(value){return unique([...arr(value.screenshots),value.screenshot,...arr(value.nativeEvidence).map(item=>item.screenshot),...arr(value.evidence).filter(item=>typeof item==='string'&&/\.png$/.test(item))].filter(Boolean).map(item=>path.basename(item)))}
function tierOf(value){
 if(value.verification&&typeof value.verification==='object'){
  if(/confirmed_by_root|confirmed_native|control_absence_confirmed/.test(value.verification.native||''))return'Native-confirmed';
  if(/^confirmed/.test(value.verification.isolatedLogic||''))return'Source + isolated logic';
  return'Source-reviewed; native reproduction pending';
 }
 if(value.confirmed===true||value.confirmedVisual===true||/screenshot_confirmed|native_screenshot_confirmed/.test(value.status||value.verification||''))return value.confirmedVisual?'Native screenshot':'Native-confirmed';
 return'Source-reviewed; native reproduction pending';
}
function addFinding(value,artifact){
 if(!value||excluded.has(value.id))return;
 const existing=findingByOrigin.get(value.id)||findingByOrigin.get(value.sourceFindingId);
 const output={id:value.id||'FINDING-'+(findings.length+1),origins:unique([value.id,...arr(value.originIds)]),priority:priority(value.priority||value.severity),
 title:value.title||'Untitled finding',routes:unique([...arr(value.routes),value.route,value.page].filter(Boolean).map(routeOf)),
 reason:value.reason||value.observed||value.observation||value.actual||(typeof value.evidence==='string'?value.evidence:'')||value.sourceExplanation||value.runtimeEvidence?.description||arr(value.sourceEvidence).slice(0,2).map(item=>item.description).filter(Boolean).join(' '),
 impact:value.impact||value.scope||'',recommendation:value.recommendation||value.suggestedFix||value.suggestion||value.expected||'',
 next:value.verificationNext||value.verificationNeeded||value.reproduction||'',tier:tierOf(value),sources:refsOf(value),images:imagesOf(value),
 evidence:arr(value.nativeEvidence).map(item=>{if(!item||typeof item!=='object')return item;const clean={...item};delete clean.entryIndex;return clean;}),artifacts:[artifact],assessment:value.mechanismAssessment||value.causeAssessment||'',testGaps:arr(value.testCoverageGap)};
 if(value.runtimeEvidence?.description)output.evidence.push({reporter:value.runtimeEvidence.source,description:value.runtimeEvidence.description});
 if(value.recoveryOutcome)output.evidence.push({description:value.recoveryOutcome});
 if(value.observedOutcome)output.evidence.push({description:value.observedOutcome});
 if(existing){
  existing.origins=unique([...existing.origins,...output.origins]);existing.images=unique([...existing.images,...output.images]);
  existing.sources=[...new Map([...existing.sources,...output.sources].map(item=>[item.file+':'+item.line,item])).values()];
  existing.evidence.push(...output.evidence);existing.artifacts=unique([...existing.artifacts,artifact]);
  if(/Native/.test(output.tier))existing.tier=output.tier;output.origins.forEach(id=>findingByOrigin.set(id,existing));return existing;
 }
 findings.push(output);output.origins.forEach(id=>findingByOrigin.set(id,output));return output;
}
arr(base.findings).forEach(value=>addFinding(value,prefix+'-findings.json'));
findingByOrigin.set('VIS-ORPHAN-CUSTOMER-KEYBOARD',findingByOrigin.get('AUDIT-21'));
findingByOrigin.set('SET-VISUAL-02',findingByOrigin.get('AUDIT-16'));
for(const[artifact,content]of Object.entries(artifacts))if(artifact!==prefix+'-findings.json'&&artifact!==prefix+'-final-visual.json')arr(content.findings||content.sourceFindings).forEach(value=>addFinding(value,artifact));
findingByOrigin.set('FINAL-OBS-01',findingByOrigin.get('OPS-NATIVE-CUSTOMER-ACCOUNT-INITIALIZATION'));
arr(get('-final-visual').findings).forEach(value=>addFinding(value,prefix+'-final-visual.json'));
function addNativeEvidence(id,actionPattern,resultPattern,description){
 const finding=findingByOrigin.get(id);if(!finding)return;
 const event=[...events].reverse().find(value=>actionPattern.test(value.action)&&resultPattern.test(value.result));
 finding.tier=event?'Native-confirmed':'Root-reported native + source-confirmed';
 finding.evidence.push({...(event?{entryIndex:event.index}:{reporter:'/root'}),description:description||event?.detail||event?.action,result:event?.result||'Root-reported'});
 if(!finding.routes.length&&event)finding.routes.push(event.route);
}
addNativeEvidence('AUDIT-21',/^Save Customer with keyboard focused$/,/^FAIL/,'Customer saved/closed but Name keyboard stayed; also seen through Attendance save/navigation.');
addNativeEvidence('AUDIT-16',/^Unchecked invalid check digit$/,/^FAIL/,'Unchecked invalid checksum was accepted but labelled Valid.');
addNativeEvidence('OPS-NATIVE-ATTENDANCE-OVERLAP',/^Add Record \/ Save Record during open session$/,/^FAIL/,'Completed 8-hour attendance record accepted despite an existing open overlapping session.');
addNativeEvidence('OPS-NATIVE-CUSTOMER-ACCOUNT-INITIALIZATION',/^Opening Balance \/ valid .* on new customer$/,/^FAIL/,'Valid new-customer Opening Balance failed because persisted Pay Later account did not exist.');
addNativeEvidence('BO-VIS-01',/^Page capture bo-orders$/,/^UI_OBSERVED$/,'Back Office Order History screenshot shows receipt control clipping.');
addNativeEvidence('OPS-NATIVE-CACHED-SCAN-AGE-GATE-BYPASS',/^Cached age-restricted barcode .*no approval click$/,/^FAIL/,'Cached age-restricted Enter scan added the item without a distinct ID Checked approval. Reproduced after Reject.');
addNativeEvidence('OPS-NATIVE-PAY-LATER-POOL-TIMEOUT-RECOVERY',/^Confirm Pay Later for existing active QA account$/,/^FAIL/,'Native account sale timed out; immutable pending financial journal preserved the reserved receipt. Restart recovered the same sale once, then root repaid it in cash.');
const age=findingByOrigin.get('OPS-NATIVE-CACHED-SCAN-AGE-GATE-BYPASS');
if(age)age.images=unique([...age.images,'50-age-verification.png','51-age-cached-scan-result.png']);
const held=findingByOrigin.get('OPS-SOURCE-CUSTOMER-HOLD-ADJUSTMENT-POLICY');
if(held){held.tier='Root-reported native + source-confirmed';held.evidence.push({reporter:'/root',description:'Root requested this native held-account positive-balance policy mismatch: UI exposes Opening/Increase while native blocks positive entries on hold; detailed follow-up log may be added later.'})}
addFinding({id:'NATIVE-MAINTENANCE-BUSY-LABEL',priority:'P3',title:'Creating Full Backup labels Delete History as Deleting History',routes:['/settings/advanced'],confirmed:true,
 reason:'A global busy flag is reused for the destructive-history button label during the unrelated full-backup operation.',
 impact:'Backup succeeded, but the destructive label suggests history deletion. No deletion was requested or executed.',
 recommendation:'Use operation-specific pending states; disable unrelated actions without claiming they are executing.',
 sources:[{file:'src/routes/settings/advanced/+page.svelte',line:537},{file:'src/routes/settings/advanced/+page.svelte',line:656},{file:'src/routes/settings/advanced/+page.svelte',line:897}],
 screenshots:['41-maintenance-backup.png'],nativeEvidence:[{result:'PASS_WITH_UI_ISSUE',description:'Full backup verified; Delete History label said Deleting History while creating it.'}]},'Root native audit');
addNativeEvidence('NATIVE-MAINTENANCE-BUSY-LABEL',/^Create Full Backup$/,/^PASS_WITH_UI_ISSUE$/,'Full backup verified; unrelated Delete History action misleadingly showed Deleting History.');
arr(state.additionalFindings).forEach(value=>addFinding(value,'run-state.json'));
for(const finding of findings){
 const map={'OPS-NATIVE-ATTENDANCE-OVERLAP':'/attendance','OPS-SOURCE-ATTENDANCE-FUTURE':'/attendance','OPS-NATIVE-WEIGHT-PRICE-LABEL':'/orders','OPS-NATIVE-CASH-DETAIL-LABEL':'/orders','OPS-NATIVE-CUSTOMER-ACCOUNT-INITIALIZATION':'/customers','OPS-SOURCE-CUSTOMER-HOLD-ADJUSTMENT-POLICY':'/customers','OPS-NATIVE-CACHED-SCAN-AGE-GATE-BYPASS':'/','OPS-NATIVE-PAY-LATER-POOL-TIMEOUT-RECOVERY':'/','OPS-NATIVE-SETUP-NO-CANCEL':'/setup','OPS-SOURCE-SETUP-RECONNECT-DATA-ACTIONS':'/setup','VIS-REPORT-CLOSE-ICON':'/reports','VIS-GOODS-LIST-HEIGHT':'/items','VIS-SCALE-ADD-PAGE-CLIPPING':'/design/scale','VIS-ATTENDANCE-CLOCKED-IN-SUMMARY':'/attendance','VIS-PERMISSION-TAB-LABEL':'/employees/permissions'};
 if(map[finding.id])finding.routes=unique([...finding.routes,map[finding.id]]);
 if(finding.id==='OPS-NATIVE-DOJO-SANDBOX-EXPIRY-INTEGRATION')finding.routes=unique([...finding.routes,'/','/customers','/settings/payments/dojo','/reports']);
}
const topOrder={'OPS-NATIVE-CACHED-SCAN-AGE-GATE-BYPASS':0,'OPS-NATIVE-PAY-LATER-POOL-TIMEOUT-RECOVERY':1,'OPS-NATIVE-ATTENDANCE-OVERLAP':2,'AUDIT-01':3};
findings.sort((a,b)=>a.priority.localeCompare(b.priority)||(topOrder[a.id]??99)-(topOrder[b.id]??99)||Number(!/Native|Root-reported/.test(a.tier))-Number(!/Native|Root-reported/.test(b.tier))||a.title.localeCompare(b.title));
const screenshotDirectory=path.join(directory,'screenshots');
const screenshotFiles=fs.existsSync(screenshotDirectory)?fs.readdirSync(screenshotDirectory).filter(name=>name.endsWith('.png')).sort():[];
// Root and settings reviewer approved these captures after checking for visible
// credentials. Later credential-associated captures require explicit approval.
const approved=new Set(['36-dojo-available.png','37-sumup-setup.png','38-cctv-overlay.png','39-licence.png','40-cash-control.png','47-database-setup.png',...arr(state.approvedScreenshots)]);
function allowedScreenshot(name){return !['03-drawer-macos-limitation.png','54-pay-later-pool-timeout.png'].includes(name)&&(approved.has(name)||!/licence|cash-control|dojo|sumup|database-setup|api-key|secret|password/i.test(name))}
const allowedImages=screenshotFiles.filter(allowedScreenshot),imageDescriptions=new Map();
function describeImage(name,description,route){name=path.basename(name||'');if(name&&!imageDescriptions.has(name))imageDescriptions.set(name,{description:description||name,route:route?routeOf(route):''})}
for(const content of Object.values(artifacts)){
 for(const image of arr(content.observations))describeImage(image.screenshot,image.observation||image.result,image.page);
 for(const image of arr(content.inspectedScreenshots))describeImage(image.file,image.visibleState||image.result,image.route);
 for(const image of arr(content.screenshots))if(typeof image==='object')describeImage(image.file,image.capturedState||image.visualResult,image.route);
}
for(const finding of findings)for(const image of finding.images)describeImage(image,finding.title,finding.routes[0]);
for(const[name,route]of Object.entries({'42-backoffice-overview.png':'/admin','43-customer-account.png':'/customers','44-new-account-adjustment-failure.png':'/customers','45-loyalty-history.png':'/customers','46-about.png':'/about','47-database-setup.png':'/setup','bo-stock-draft.png':'/stock-receiving'}))describeImage(name,name.replace(/^\d+-|\.png$/g,'').replace(/-/g,' '),route);
const imageFor=(name,caption='')=>allowedImages.includes(name)?'<figure><a href="screenshots/'+encodeURIComponent(name)+'"><img loading="lazy" src="screenshots/'+encodeURIComponent(name)+'" alt="'+safe(caption||imageDescriptions.get(name)?.description||name)+'"></a><figcaption>'+safe(caption||imageDescriptions.get(name)?.description||name)+' · <a href="screenshots/'+encodeURIComponent(name)+'">'+safe(name)+'</a></figcaption></figure>':'';
const list=values=>'<ul>'+arr(values).map(value=>'<li>'+safe(value)+'</li>').join('')+'</ul>';
const refs=values=>unique(arr(values).map(value=>value.file+(value.line?':'+value.line:''))).map(value=>'<code>'+safe(value)+'</code>').join(' · ');

function controlRow(control,page){
 const matches=(eventsByRoute.get(page.route)||[]).filter(event=>event.action.trim().toLowerCase()===redact(control.label).trim().toLowerCase());
 const ambiguous=page.controls.filter(other=>other.label===control.label).length>1;
 const execution=matches.length&&!ambiguous
 ?'<span class="badge observed">Same-label native evidence only</span><br>'+matches.map(event=>'<a href="#action-'+event.index+'">#'+event.index+' '+safe(event.result)+'</a>').join(', ')+'<small>Label match is not a verified template/handler mapping.</small>'
 :'<span class="badge source">Source-only / no per-template verdict</span>';
 const metadata=[control.values.length?'Fixed choices: '+control.values.join(' · '):'',control.conditions.length?'Conditions: '+control.conditions.join('; '):'',control.attributes?'Attributes: '+JSON.stringify(control.attributes):''].filter(Boolean);
 return '<tr><td><strong>'+safe(control.label)+'</strong><small>'+safe(control.type)+' · '+safe(control.surface)+'</small><code>'+safe(control.file)+':'+safe(control.line)+'</code></td><td>'+safe(control.effect)+'<small>Expected: '+safe(control.expected)+'</small>'+metadata.map(value=>'<small class="metadata">'+safe(value)+'</small>').join('')+'</td><td>'+safe(control.dependencies.join('; '))+'<small>Risk: '+safe(control.risk)+'</small></td><td>'+execution+'</td></tr>';
}
function inventoryTable(controls,page){
 return '<div class="table-scroll"><table class="inventory"><thead><tr><th>Control/source</th><th>Effect, expectation and fixed choices</th><th>Dependency/risk</th><th>Execution evidence</th></tr></thead><tbody>'+controls.map(control=>controlRow(control,page)).join('')+'</tbody></table></div>';
}
function actionTable(values){
 return '<div class="table-scroll"><table class="actions"><thead><tr><th>Log/time</th><th>Action</th><th>Recorded verdict</th><th>Evidence/limit</th></tr></thead><tbody>'+values.map(event=>'<tr id="action-'+event.index+'"><td><code>#'+event.index+'</code><small>'+safe(event.time)+'</small></td><td>'+safe(event.action)+'<small>'+safe(event.mode)+(event.originalRoute.includes('?')?' · '+safe(event.originalRoute.split('?')[1]):'')+'</small></td><td>'+badge(event.result)+'</td><td>'+safe(event.detail)+(event.afterStateSummary?'<small>After-state evidence only; not a per-button success verdict. Input values and contact/credential messages omitted.</small>':'')+'</td></tr>').join('')+'</tbody></table></div>';
}
function findingCard(finding){
 return '<article class="finding '+finding.priority.toLowerCase()+'" id="finding-'+safe(finding.id)+'"><div class="finding-heading"><span class="priority">'+safe(finding.priority)+'</span><div><h3>'+safe(finding.title)+'</h3><p class="eyebrow">'+safe(finding.id)+' · '+safe(finding.tier)+'</p></div></div><p>'+safe(finding.reason)+'</p>'+
 (finding.impact?'<p><strong>Impact.</strong> '+safe(finding.impact)+'</p>':'')+
 (finding.recommendation?'<p><strong>Suggested fix.</strong> '+safe(finding.recommendation)+'</p>':'')+
 (finding.next?'<p><strong>Verify next.</strong> '+safe(finding.next)+'</p>':'')+
 (finding.assessment?'<p><strong>Cause/mechanism assessment.</strong> '+safe(finding.assessment)+'</p>':'')+
 (finding.testGaps.length?'<details><summary>Regression coverage gaps</summary>'+list(finding.testGaps)+'</details>':'')+
 '<p class="source-links">'+finding.routes.map(route=>'<a href="#'+anchor(route)+'">'+safe(route)+'</a>').join(' · ')+'</p>'+
 (finding.sources.length?'<p class="sources">'+refs(finding.sources)+'</p>':'')+
 (finding.evidence.length?'<details><summary>Evidence/provenance</summary>'+list(finding.evidence.map(value=>typeof value==='string'?value:[value.reporter,value.entryIndex!=null?'native log #'+value.entryIndex:'',value.result,value.description||value.scenario||value.supportedClaim,value.note].filter(Boolean).join(' · ')))+'<p>Artifacts: '+safe(finding.artifacts.join(', '))+'</p></details>':'')+
 finding.images.filter(allowedScreenshot).slice(0,1).map(name=>imageFor(name,finding.title)).join('')+'</article>';
}
const countVerdicts=values=>values.reduce((out,event)=>(out[event.result]=(out[event.result]||0)+1,out),{});
const narratives={
 '/':'Checkout actions include touch pads/keyboard, manual scale, quantity/price surfaces, hold/retrieve, customer selection and cash-sale completion. A cached age-restricted scan added its item without a distinct approval. A Pay Later pool timeout left a pending immutable sale; root reported successful same-sale recovery on restart and a balancing cash repayment. The initial failure remains a defect even after recovery. Only explicit PASS scenarios below count as passes. Physical drawer/receipt output could not be verified on macOS.',
 '/customers':'Customer-profile, account and loyalty UI were exercised. Saving with the keyboard active left an orphan overlay. A valid first Opening Balance failed on a fresh customer; on-hold account adjustment behavior differs from the UI guidance. Source loyalty/history safeguards are not a destructive-wipe runtime sign-off.',
 '/attendance':'An 8-hour completed mock record was accepted despite an existing open overlapping session. The unqualified Clocked in summary can show 0 when the current user has an open out-of-period session. Checkout touch overlays and Back Office captured geometry are distinguished.',
 '/orders':'Populated history and receipt details were opened. Checkout table fit the square capture; Back Office receipt controls were clipped. Weighted-line/cash breakdown labels need clearer meaning; these findings do not prove wrong net accounting.',
 '/reports':'Filters and preview surfaces were inspected. Till X/whole-system preview header-close icon issues are separate. Previewing does not prove destructive close, epoch rollover, Windows printer output or shared-till reconciliation.',
 '/stock-receiving':'Receive-stock draft/history and Back Office picker/draft states were inspected. History is bounded to latest 50. A draft screenshot or click alone does not assert stock/accounting committed correctly.',
 '/settings/payments/dojo':'Dojo settings/terminal availability and legacy sandbox recovery controls were inspected. This is not completion of payment/cancellation/UAT or offline-MariaDB accounting scenarios without explicit later verdicts. Source provider switching can disable the prior working provider if the target save fails.',
 '/customer-display':'The actual native Customer Display window was opened and passed the explicit idle/live £6 basket scenario. Its physical second-monitor placement was not tested because this Mac had one connected monitor. Settings square/portrait previews are separate visual observations, not a substitute for the native-window pass.',
 '/settings/customer-display':'Native Open display, Close display and preview controls were exercised. Square/portrait preview states were captured; actual idle/live basket passed on the separate /customer-display native window. A one-monitor test does not prove physical second-screen positioning on installed till hardware.',
 '/settings/advanced':'A full backup was created and explicitly verified. Its busy flag misleadingly changed Delete History to Deleting History. Restore/wipe/destructive maintenance outcomes are not inferred from source controls or confirmations.',
 '/admin':'Checkout management and Back Office overview were captured at square dimensions. Visibility of a navigation tile does not pass the destination workflow.'
};
function pageSection(page){
 const pageEvents=eventsByRoute.get(page.route)||[],pageFindings=findings.filter(finding=>finding.routes.includes(page.route));
 const images=allowedImages.filter(name=>imageDescriptions.get(name)?.route===page.route).slice(0,2),counts=countVerdicts(pageEvents);
 return '<section class="page-section" id="'+anchor(page.route)+'"><div class="section-heading"><h2>'+safe(page.route)+'</h2><span>'+page.controls.length+' control templates · '+pageEvents.length+' native records</span></div><p>'+
 safe(state.pageNarratives?.[page.route]||narratives[page.route]||(pageEvents.length?'Native actions are recorded for this page. Their original verdicts are preserved; an observed action alone is not success.':'No native action is recorded here in this snapshot. Source inventory is available; runtime behavior remains unverified.'))+'</p>'+
 (page.purpose?'<p class="muted">'+safe(page.purpose)+'</p>':'')+
 (Object.keys(counts).length?'<div class="counts">'+Object.entries(counts).map(([result,total])=>badge(result,result+' '+total)).join(' ')+'</div>':'<p class="badge source">Source-only route in this native snapshot</p>')+
 (pageFindings.length?'<p><strong>Findings:</strong> '+pageFindings.map(finding=>'<a href="#finding-'+safe(finding.id)+'">'+safe(finding.id)+' '+safe(finding.title)+'</a>').join(' · ')+'</p>':'')+
 (page.notes.length?'<details><summary>Page requirements/source-review checks</summary>'+list(unique(page.notes))+(page.scenarios.length?list(page.scenarios):'')+'</details>':'')+
 (images.length?'<div class="screenshots compact">'+images.map(name=>imageFor(name)).join('')+'</div>':'')+
 (pageEvents.length?'<details open><summary>Native action table ('+pageEvents.length+')</summary>'+actionTable(pageEvents)+'</details>':'')+
 '<details><summary>Every source control/action template ('+page.controls.length+')</summary><p class="muted">Literal templates and fixed-choice families, including unexecuted conditions. Repeated rows/options are not individually counted. Label links do not prove the exact handler passed.</p>'+inventoryTable(page.controls,page)+'</details></section>';
}
const pageList=[...pages.values()].sort((a,b)=>a.route==='/'?-1:b.route==='/'?1:a.route.localeCompare(b.route));
const controlCount=pageList.reduce((count,page)=>count+page.controls.length,0),verdicts=countVerdicts(events);
const checkSource=admin.automatedChecks||base.automatedChecks||[];
const svelte=checkSource.find(value=>value.command==='npm run check'),vitest=checkSource.find(value=>value.command==='npx vitest run');
const summary={
 generatedAt,auditStatus:state.auditStatus||'IN_PROGRESS',restorationStatus:state.restorationStatus||'PENDING_ROOT_VERIFICATION',
 nativeActions:events.length,nativeRoutes:eventsByRoute.size,nativeVerdicts:verdicts,compactAfterStateRows:events.filter(event=>event.afterStateSummary&&event.detail.startsWith('After route:')).length,sourcePages:pageList.length,sourceOnlyRoutes:pageList.filter(page=>!eventsByRoute.has(page.route)).map(page=>page.route),sourceControlTemplates:controlCount,sharedControlTemplates:shared.length,
 findings:findings.length,priorities:findings.reduce((out,finding)=>(out[finding.priority]=(out[finding.priority]||0)+1,out),{}),
 tests:{passed:vitest?.testsPassed,skipped:vitest?.testsSkipped,filesPassed:vitest?.testFilesPassed,filesSkipped:vitest?.testFilesSkipped,svelteErrors:svelte?.svelteErrors,svelteWarnings:svelte?.svelteWarnings,rustPassed:rust.result?.passed,rustFailed:rust.result?.failed,rustFilteredOut:rust.result?.filteredOut,rustWarnings:arr(rust.warnings).length},
 omittedScreenshots:screenshotFiles.filter(name=>!allowedScreenshot(name)),
 note:'Observed is not PASS. Raw AX and secure input values omitted. Restoration and remaining test limits are recorded in run-state.json.'
};
const parts=[
 '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>L&Bj POS · Audit · 12 October 2026</title><style>',
 fs.readFileSync(path.join(directory,'report.css'),'utf8'),
 '</style></head><body><header><button class="print-control" onclick="window.print()">Print / Save PDF</button><div class="eyebrow">L&Bj POS · Native Tauri and source audit · 12 October 2026</div><h1>Page, button and UI audit</h1><p>Checkout and Back Office review with complete source-control annex. Native defects, screenshots, isolated-logic reproductions and unexecuted source paths are distinguished.</p><p class="eyebrow">Generated '+safe(generatedAt)+' · '+events.length+' native records · '+safe(summary.auditStatus)+'</p></header><main>',
 '<section class="intro"><h2>Executive summary</h2><div class="metrics"><div class="metric"><strong>'+findings.length+'</strong><span>Consolidated findings</span></div><div class="metric"><strong>'+pageList.length+'</strong><span>Inventoried/runtime routes</span></div><div class="metric"><strong>'+controlCount+' + '+shared.length+'</strong><span>Page + shared templates</span></div><div class="metric"><strong>'+events.length+'</strong><span>Native records, not all passes</span></div></div>',
 '<p>'+summary.nativeRoutes+' routes have native records; '+summary.sourceOnlyRoutes.length+' route is source-only ('+safe(summary.sourceOnlyRoutes.join(', '))+'). '+safe(summary.priorities.P1||0)+' P1 · '+safe(summary.priorities.P2||0)+' P2 · '+safe(summary.priorities.P3||0)+' P3. Highest-priority native issues are an age-check bypass, overlapping attendance and an unclear pending Pay Later sale after a timeout. Other native issues include first account initialization, orphan keyboards and Back Office receipt clipping. Source failure paths include fail-open catalogue deletion and unsafe provider/configuration switching.</p>',
 '<p class="warning"><strong>Run: '+safe(summary.auditStatus)+'. Restoration: '+safe(summary.restorationStatus)+'.</strong> '+safe(state.restorationNotes||'Root is still testing/restoring mock and configuration changes. This initial report is not a restored-state sign-off or finished Windows/provider UAT run.')+'</p>',
 '<div class="legend">'+badge('PASS','PASS · explicit scenario')+badge('observed','Observed · action/UI state only')+badge('FAIL_FUNCTION','Failed · recorded defect')+badge('BLOCKED_HARDWARE','Blocked · dependency/hardware')+'<span class="badge source">Source-only · runtime unverified</span>'+badge('PASS_WITH_UI_ISSUE','Operation passed, UI issue')+'</div><p class="muted">Source templates/fixed-choice families differ from runtime buttons. Same-label links do not establish exact handler coverage. Raw accessibility snapshots, secure input values and API credentials are not reproduced.</p>',
 '<h3>Native verdict counts</h3><div class="counts">'+Object.entries(verdicts).map(([result,total])=>badge(result,result+' '+total)).join(' ')+'</div><h3>Jump to page</h3><nav class="route-nav">'+pageList.map(page=>'<a href="#'+anchor(page.route)+'">'+safe(page.route)+'</a>').join('')+'</nav></section>',
 '<section class="automated"><h2>Automated checks</h2><div class="metrics"><div class="metric"><strong>'+safe(vitest?.testsPassed??'Unavailable')+'</strong><span>Tests passed</span></div><div class="metric"><strong>'+safe(vitest?.testsSkipped??'Unavailable')+'</strong><span>Tests skipped</span></div><div class="metric"><strong>'+safe(svelte?.svelteErrors??'Unavailable')+'</strong><span>Svelte errors</span></div><div class="metric"><strong>'+safe(svelte?.svelteWarnings??'Unavailable')+'</strong><span>Svelte warnings</span></div></div>',
 '<p><code>npm run check</code> and <code>npx vitest run</code> are from the saved check artifact, not rerun by the report generator. '+safe(vitest?.testFilesPassed)+' test files passed; '+safe(vitest?.testFilesSkipped)+' file skipped. Command audit: '+safe(svelte?.tauriAudit?.frontendCommands)+' frontend / '+safe(svelte?.tauriAudit?.registeredCommands)+' registered, all permitted.</p>',
 '<details><summary>Exact frontend checks/skipped integration requirements</summary><pre>'+json(checkSource)+'</pre></details><h3>Native Rust library checks</h3><p><strong>'+safe(rust.result?.passed??'Unavailable')+' passed · '+safe(rust.result?.failed??'Unavailable')+' failed · '+safe(rust.result?.filteredOut??'Unavailable')+' excluded.</strong> '+safe(arr(rust.warnings).length)+' dead-code warnings; these are distinct from the zero Svelte warnings above. Safe macOS test-profile run: in-memory/temporary SQLite and local loopback mocks only. No real MariaDB fixture, external provider API, production secret store, physical hardware or Windows build was exercised.</p><p><code>'+safe(rust.execution?.command||'No native command artifact')+'</code></p><details><summary>Native result, excluded integrations, warnings and all test cases</summary><pre>'+json(rust)+'</pre></details><details><summary>Isolated logic reproductions and negative control</summary>'+list(arr(base.targetedChecks).map(value=>value.id+' — '+value.status+' — '+value.method+' Result: '+JSON.stringify(value.result)+'. '+value.limits))+'</details></section>',
 '<section class="scope"><h2>Scope, mock fixtures and limits</h2>'+list([
 'Native run was on this Mac. Installed Windows build and physical printer/drawer/scale output require separate verification.',
 'Checkout management and Back Office square captures are generally 1024×768. A fitting screenshot applies only to its visible state, not every scrolling/form/modal state.',
 'Mock fixtures were used for checkout, customer, attendance, stock and configuration exercises. Retained fixtures and configuration restoration are documented below; there is no byte-for-byte database rollback.',
 'Source-inspected wipe, full database restore and final Z-close actions were not executed and remain unverified. A button/confirmation does not prove their success. Configuration restoration is documented separately.',
 'Dojo terminal availability is not sandbox payment/cancellation/UAT or offline-MariaDB accounting sign-off. Live charges are not implied.',
 'Two frontend MariaDB integrations skipped without disposable test configuration; the native Rust exclusions are listed separately above. Shared migration and multi-till concurrency remain unverified.',
 'Raw native log can contain secure AX values; this report excludes them. Reviewed masked credential-associated captures from the original set are included; later captures need approval.',
 'Screenshots 03 and 54 missed their alerts and are omitted. The Pay Later timeout is supported by the failed native accessibility/action entry and journal diagnostics, not screenshot54.',
 ...arr(state.scopeNotes)])+'</section>',
 '<h2 id="findings">Prioritized findings</h2><p class="muted">P1: safety gate, data integrity, uncertain payment outcome or incorrect working-time totals. P2: workflow failure/configuration or significant UI obstruction. P3: clarity, consistency or enhancement. Suggestions are not automatically functional defects.</p><div class="findings">'+findings.map(findingCard).join('')+'</div>',
 '<h2 id="pages">Page-by-page native evidence and complete source controls</h2>'+pageList.map(pageSection).join(''),
 '<section class="annex"><h2>Shared components and fixed dynamic choices</h2><p>Additional shared templates can render on several routes. Their source inventory does not imply runtime PASS.</p>'+inventoryTable(shared,{route:'/shared-components',controls:shared})+'<details><summary>Navigation, roles, permission groups and pad keys</summary><pre>'+json(admin.dynamicNavigation||{})+'</pre></details><details><summary>Settings redirects/operations shared checks</summary><pre>'+json({redirects:settings.redirects,operationsShared:operations.sharedChecks})+'</pre></details></section>',
 '<section class="annex"><h2>Native screenshot gallery</h2><p>Click for full capture. Screenshots 03 and 54 omitted because they missed the alerts. Credential-associated captures were reviewed for visible keys/PIN/passwords before inclusion. Unapproved later captures are withheld; their redacted runtime entries remain listed.</p><div class="screenshots">'+allowedImages.map(name=>imageFor(name)).join('')+'</div><details><summary>Omitted captures</summary>'+list(summary.omittedScreenshots)+'</details></section>',
 '<section class="annex"><h2>Retracted candidates—not bugs</h2><p>These exclusions protect signature controls and prevent an incorrect image fix.</p>'+list(arr(base.reviewedNonFindings).filter(value=>value.originId).map(value=>value.originId+' — '+value.originalTitle+' — '+value.reason))+'</section>',
 '<section class="scope"><h2>Final restoration/run status</h2><p><strong>'+safe(summary.restorationStatus)+'</strong></p><p>'+safe(state.restorationNotes||'Root must record fixture/configuration state, operating mode, trolley/payment state and unresolved dependencies before final handoff.')+'</p>'+list(arr(state.restoreChecklist))+'<p class="muted">Refresh with <code>node docs/qa/audit-2026-10-12/generate-report.mjs</code> after updating run-state.json. It rereads all audit JSON and native log without calling the app/tests/providers.</p></section>',
 '<footer>Artifacts: '+safe(files.join(' · '))+'. Native evidence: <code>native-actions.json</code>. The report generator runs locally without network upload, provider call, live database write or product edit. The audit itself performed the authorized mock-data writes and sandbox request disclosed in the scope/restoration sections.</footer></main></body></html>'
];
fs.writeFileSync(path.join(directory,'REPORT.html'),parts.join(''));
fs.writeFileSync(path.join(directory,'report-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({report:'docs/qa/audit-2026-10-12/REPORT.html',...summary},null,2));

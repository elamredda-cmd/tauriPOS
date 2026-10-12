// Compact evidence only. Never serialize AX nodes, input values, contact bodies,
// credential messages, or interpret the presence of a screen as a workflow pass.
const forbidden=/[@•●]|\b(?:email|e-mail|phone|mobile|postcode|postal|address|mailto|tel|password|passcode|PIN|credential|API[-_ ]?key|secret|Bearer|token)\b/i;
const boilerplate=/^(?:Back Office navigation|Admin navigation|Management tools|Workspace|Operations|Notifications|Signed in staff|Cursor controls|Search(?:\b| )|Name$|Correction note$|Payment totals$)/i;
const staticSurface=/^(?:Scale|Payment|Quantity|Selling price|Change price|Staff attendance|Clear order|Sale complete|Something needs attention|Check price|Held trolleys|Select customer|New customer|Edit customer|Goods Menu Manager|Synced|Online|Offline|Available|Unavailable|Customer and loyalty|Display mode)$/i;
const landmarkSurface=/\b(?:dialog|modal|pad|keyboard|picker|view|summary|status|form|controls|selection|settings|layout|preview|history|activity|filters|results)\b/i;
const relevantStatus=/^(?:TOTAL(?: PRICE)?\s*£|Amount due\s*£|Cash(?: received| retained| tendered)?\s*£|Change(?: to give)?\s*£|Balance(?: owed)?\s*£|Currently owes\s*£|Paid\s*£|Total Items:|Synced\b|Online$|Offline$|Syncing\b|Connecting\b|Saving\b|Saved\b|Cash payment saved\b|Sale complete\b|Cancellation requested\b|Cancellation unconfirmed\b|Waiting for\b|Cancelling\b|Canceled\b|Cancelled\b|Approved\b|Declined\b|Available$|Unavailable$|No sync conflicts\b|No .{0,55}(?:selected|configured|pending|available|found)\b|Error\b|Could not\b|Cannot\b|Can't\b|Failed\b|Unable\b|Sale was not completed\b|Something needs attention\b|Action needed\b|Invalid\b|Please (?:enter|choose|select|provide|check|connect)\b)/i;
const errorWithin=/\b(?:failed:|Error:|not completed:|timed out|not available on|not found|not enabled|unsupported on)\b/i;
const shorten=(value,max)=>value.length>max?value.slice(0,max-1)+'…':value;
function clean(value,redact){
 return redact(value.replace(/,\s*(?:Value|Help|Description|Identifier|Position|Size|Title|URL):.*$/i,'').replace(/\s+/g,' ').trim());
}
export function summarizeAfterState(snapshot,redact=value=>String(value)){
 if(typeof snapshot!=='string'||!snapshot.trim())return{summary:'No after-state snapshot recorded; this action alone does not establish an outcome.',signals:0};
 const routeMatch=snapshot.match(/\bURL:\s*(?:tauri:\/\/|https?:\/\/|file:\/\/)[^\s]+/);
 let route='';
 if(routeMatch){try{route=new URL(routeMatch[0].replace(/^URL:\s*/,'' )).pathname||'/';}catch{}}
 const nodes=[];
 for(const line of snapshot.split('\n')){
  // text field/area and secure-text roles are expressly not text messages.
  const match=line.match(/^\s*\d+\s+(heading|container|dialog|alert|text(?!\s+(?:field|area)\b))\s+(.+)$/);
  if(!match)continue;
  let text=clean(match[2],redact);
  // These headings interpolate a selected person's name, rather than an input.
  // Retain the static surface title only, not the customer contact identity.
  text=text.replace(/^(Customer Account|Customer Profile|Customer Details|Edit Customer|Account Statement)\s*[-–—:]\s*.+$/i,'$1 (name withheld)');
  if(!text||forbidden.test(text))continue;
  nodes.push({role:match[1],text});
 }
 const unique=values=>[...new Set(values)];
 const headings=unique(nodes.filter(node=>node.role==='heading').map(node=>node.text)).slice(0,3).map(text=>shorten(text,70));
 const surfaces=unique(nodes.filter(node=>/^(?:container|dialog|alert)$/.test(node.role)&&!boilerplate.test(node.text)&&(staticSurface.test(node.text)||landmarkSurface.test(node.text))&&node.text.length<=80&&!headings.includes(node.text)).map(node=>node.text)).slice(0,headings.length?1:2);
 const statuses=unique(nodes.filter(node=>node.role==='text'&&(relevantStatus.test(node.text)||errorWithin.test(node.text))).map(node=>node.text)).slice(0,3).map(text=>shorten(text,180));
 const parts=[];
 if(route&&!forbidden.test(route))parts.push('After route: '+route);
 if(headings.length)parts.push('Visible heading'+(headings.length>1?'s':'')+': '+headings.join(' / '));
 if(surfaces.length)parts.push('Named surface: '+surfaces.join(' / '));
 if(statuses.length)parts.push('Visible status: '+statuses.join(' | '));
 return{summary:parts.length?shorten((parts.join('. ')+'.').replace(/\.+$/,'.'),620):'After-state captured, but no safe route/title/status summary was extracted; outcome unverified.',signals:parts.length};
}

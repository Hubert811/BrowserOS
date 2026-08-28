import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'

import type { FrameId } from '../connection'

// Finds elements that behave as interactive but carry no ARIA role (cursor:pointer divs, onclick
// handlers, tabindex, contenteditable) — the SPA pattern the accessibility tree misses. Tags each
// match with a temporary attribute so its backendNodeId can be recovered, then cleans up.
const CURSOR_SCAN_JS = `(function(){
  var interactiveTags=new Set(['a','button','input','select','textarea','details','summary']);
  var interactiveRoles=new Set(['button','link','textbox','checkbox','radio','combobox','listbox',
    'menuitem','menuitemcheckbox','menuitemradio','option','searchbox','slider','spinbutton','switch','tab','treeitem']);
  var out=[];
  var all=document.body?document.body.querySelectorAll('*'):[];
  for(var i=0;i<all.length;i++){
    var el=all[i];
    if(interactiveTags.has(el.tagName.toLowerCase()))continue;
    var role=el.getAttribute('role');
    if(role&&interactiveRoles.has(role.toLowerCase()))continue;
    var style=getComputedStyle(el);
    var hasCursor=style.cursor==='pointer';
    var hasOnClick=el.hasAttribute('onclick')||el.onclick!==null;
    var tabIdx=el.getAttribute('tabindex');
    var hasTabIndex=tabIdx!==null&&tabIdx!=='-1';
    var editable=el.isContentEditable;
    if(!hasCursor&&!hasOnClick&&!hasTabIndex&&!editable)continue;
    if(hasCursor&&!hasOnClick&&!hasTabIndex&&!editable){
      var p=el.parentElement;
      if(p&&getComputedStyle(p).cursor==='pointer')continue;
    }
    var rect=el.getBoundingClientRect();
    if(rect.width===0||rect.height===0)continue;
    el.setAttribute('data-__bcid',String(i));
    var reasons=[];
    if(hasCursor)reasons.push('cursor:pointer');
    if(hasOnClick)reasons.push('onclick');
    if(hasTabIndex)reasons.push('tabindex');
    if(editable)reasons.push('contenteditable');
    // Identifying label — priority: nearest ancestor whose text ADDS content
    // beyond the hit itself (label-column layouts keep the label in a sibling
    // of the hit, so that ancestor's text is "label + placeholder" and
    // disambiguates a grid of identical placeholders); own text is the
    // fallback; climbing stops at the first oversized (container) ancestor.
    // Long own text must TRUNCATE, not drop (bug #23): QuickBI enum fields
    // holding dozens of values reach 1200+ chars — dropped labels rendered
    // the hit as an anonymous generic, so the field vanished from snapshot
    // text search exactly when verification mattered most. Cap aligns with
    // the DOM generator's maxTextLength (120).
    var own=(el.textContent||'').trim();
    var label=own.length>0?(own.length<=120?own:own.slice(0,117)+'…'):'';
    var anc=el.parentElement;
    for(var k=0;k<3&&anc;k++){
      var at=(anc.textContent||'').trim();
      if(at.length>60)break;
      if(at&&at!==own){label=at;break}
      anc=anc.parentElement;
    }
    out.push({marker:String(i),reasons:reasons,label:label});
  }
  return out;
})()`

interface ScanHit {
  marker: string
  reasons: string[]
  label?: string
}

/** Rendered alongside the node: why it counts as interactive + an
 * identifying label when the AX tree gives the node no accessible name. */
export interface CursorHit {
  reasons: string[]
  label?: string
}

/**
 * backendNodeId → reasons for cursor-interactive elements in this frame. Best-effort.
 *
 * Frame targeting: Runtime.evaluate carries no frameId param, so on a session
 * that hosts multiple same-origin frames the scan would silently run in the
 * MAIN frame's world — child-frame cursor hits (QuickBI-style custom filter
 * widgets with no ARIA) never surfaced. When a frameId is given, run the scan
 * and the per-hit lookups inside an isolated world for that frame.
 */
export async function findCursorHits(
  session: ProtocolApi,
  frameId?: FrameId,
): Promise<Map<number, CursorHit>> {
  const hits = new Map<number, CursorHit>()

  let contextId: number | undefined
  if (frameId !== undefined) {
    try {
      const world = await session.Page.createIsolatedWorld({ frameId })
      contextId = world.executionContextId
    } catch {
      return hits
    }
  }

  let found: ScanHit[] | undefined
  try {
    const result = await session.Runtime.evaluate({
      expression: CURSOR_SCAN_JS,
      returnByValue: true,
      ...(contextId !== undefined && { contextId }),
    })
    found = result.result?.value as ScanHit[] | undefined
  } catch {
    return hits
  }
  if (!found?.length) return hits

  for (const hit of found) {
    try {
      const query = await session.Runtime.evaluate({
        expression: `document.querySelector('[data-__bcid="${hit.marker}"]')`,
        returnByValue: false,
        ...(contextId !== undefined && { contextId }),
      })
      const objectId = query.result?.objectId
      if (!objectId) continue
      const described = await session.DOM.describeNode({ objectId })
      const backendNodeId = described.node?.backendNodeId
      if (backendNodeId !== undefined)
        hits.set(backendNodeId, { reasons: hit.reasons, label: hit.label })
    } catch {
      // element vanished between scan and resolve
    }
  }

  await session.Runtime.evaluate({
    expression:
      "document.querySelectorAll('[data-__bcid]').forEach(function(e){e.removeAttribute('data-__bcid')})",
    returnByValue: true,
    ...(contextId !== undefined && { contextId }),
  }).catch(() => {})

  return hits
}

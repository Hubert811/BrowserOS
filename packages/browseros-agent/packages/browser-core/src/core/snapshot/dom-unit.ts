import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import type { RefEntry } from './refs'

/**
 * P3-5 AX+DOM probe — DOM units for snapshot refs.
 *
 * A "DOM unit" is the minimal locating identity of the element behind one
 * AX ref: tag + strongest id/testid + a shortest unique stable selector.
 * Merged inline after each `[ref=eN]` line, an agent reads semantics and
 * the implementation address in one pass while writing site adapters.
 *
 * The injected JS is a language-independent asset string: the Rust port (or
 * an upstream PR) can lift the body verbatim and drive it over the same
 * CDP channel.
 */

export interface DomUnit {
  tag: string
  id?: string
  testid?: string
  selector?: string
}

/** Page-side probe: tag/id/testid extraction + stable-selector synthesis. */
export const DOM_UNIT_JS = String.raw`
function __domUnitProbe(el) {
  if (!el || el.nodeType !== 1) return null;
  var tag = (el.tagName || '').toLowerCase();
  if (!tag) return null;
  var unit = { tag: tag };
  if (el.id) unit.id = el.id;
  var testid = __probeAttr(el, ['data-testid', 'data-test', 'data-cy', 'data-qa']);
  if (testid) unit.testid = testid;
  var sel = __stableSelector(el);
  if (sel) unit.selector = sel;
  return unit;
}
function __probeAttr(el, names) {
  for (var i = 0; i < names.length; i++) {
    var v = el.getAttribute(names[i]);
    if (v) return v;
  }
  return null;
}
function __qsa(sel) {
  try { return document.querySelectorAll(sel); } catch (e) { return null; }
}
function __unique(sel) {
  var found = __qsa(sel);
  return !!found && found.length === 1;
}
function __escIdent(v) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(v);
  return v.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
function __escAttr(v) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function __stableSelector(el) {
  var i, j, s;
  if (el.id) {
    s = '#' + __escIdent(el.id);
    if (__unique(s)) return s;
  }
  var attrNames = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
  for (i = 0; i < attrNames.length; i++) {
    var v = el.getAttribute(attrNames[i]);
    if (v) {
      s = '[' + attrNames[i] + '="' + __escAttr(v) + '"]';
      if (__unique(s)) return s;
    }
  }
  var tag = el.tagName.toLowerCase();
  var classes = Array.prototype.slice.call(el.classList || []).slice(0, 6);
  if (classes.length) {
    for (var size = 1; size <= Math.min(3, classes.length); size++) {
      var combos = __combos(classes, size);
      for (j = 0; j < combos.length; j++) {
        s = tag;
        for (i = 0; i < combos[j].length; i++) s += '.' + __escIdent(combos[j][i]);
        if (__unique(s)) return s;
      }
    }
  }
  var segs = [];
  var node = el;
  for (var depth = 0; depth < 4 && node && node.nodeType === 1; depth++) {
    segs.unshift(__segOf(node));
    s = segs.join(' > ');
    if (__unique(s)) return s;
    node = node.parentElement;
  }
  return null;
}
function __combos(items, size) {
  if (size > items.length) return [];
  if (size === 1) return items.map(function (x) { return [x]; });
  var out = [];
  for (var i = 0; i <= items.length - size; i++) {
    var tails = __combos(items.slice(i + 1), size - 1);
    for (var j = 0; j < tails.length; j++) out.push([items[i]].concat(tails[j]));
  }
  return out;
}
function __segOf(el) {
  var t = el.tagName.toLowerCase();
  if (!el.parentElement) return t;
  var n = 1;
  var sib = el;
  while ((sib = sib.previousElementSibling)) {
    if (sib.tagName === el.tagName) n++;
  }
  return t + ':nth-of-type(' + n + ')';
}
`

const MAX_DOM_UNIT_REFS = 400
const CHUNK_SIZE = 8

/**
 * Batch-extracts DOM units for ref entries through the page's CDP session
 * (DOM.resolveNode -> Runtime.callFunctionOn, per node, chunked). Failures
 * degrade to "no unit" per entry — enrichment must never break a snapshot.
 */
export async function collectDomUnits(
  session: ProtocolApi,
  entries: RefEntry[],
): Promise<Map<string, DomUnit>> {
  const units = new Map<string, DomUnit>()
  const capped = entries.slice(0, MAX_DOM_UNIT_REFS)
  for (let i = 0; i < capped.length; i += CHUNK_SIZE) {
    const chunk = capped.slice(i, i + CHUNK_SIZE)
    const settled = await Promise.all(
      chunk.map(async (entry) => {
        try {
          return {
            ref: entry.ref,
            unit: await domUnitFor(session, entry.backendNodeId),
          }
        } catch {
          return { ref: entry.ref, unit: undefined }
        }
      }),
    )
    for (const item of settled) {
      if (item.unit !== undefined) units.set(item.ref, item.unit)
    }
  }
  return units
}

async function domUnitFor(
  session: ProtocolApi,
  backendNodeId: number,
): Promise<DomUnit | undefined> {
  const resolved = await session.DOM.resolveNode({ backendNodeId })
  const objectId = resolved.object?.objectId
  if (!objectId) return undefined
  try {
    const call = await session.Runtime.callFunctionOn({
      functionDeclaration: `function () {\n${DOM_UNIT_JS}\nreturn __domUnitProbe(this);\n}`,
      objectId,
      returnByValue: true,
    })
    const value = call.result?.value
    return isDomUnit(value) ? value : undefined
  } finally {
    await session.Runtime.releaseObject({ objectId }).catch(() => {})
  }
}

function isDomUnit(value: unknown): value is DomUnit {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<DomUnit>
  return (
    typeof candidate.tag === 'string' &&
    candidate.tag.length > 0 &&
    (candidate.id === undefined || typeof candidate.id === 'string') &&
    (candidate.testid === undefined || typeof candidate.testid === 'string') &&
    (candidate.selector === undefined || typeof candidate.selector === 'string')
  )
}

function hasLocator(unit: DomUnit): boolean {
  return (
    unit.id !== undefined ||
    unit.testid !== undefined ||
    unit.selector !== undefined
  )
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Inline rendering: `input#q [sel="#q"]` — locator summary then stable selector. */
export function formatDomUnit(unit: DomUnit): string {
  const head =
    unit.id !== undefined
      ? `${unit.tag}#${truncate(unit.id, 32)}`
      : unit.testid !== undefined
        ? `${unit.tag}[data-testid=${truncate(unit.testid, 24)}]`
        : unit.tag
  return unit.selector !== undefined
    ? `${head} [sel=${JSON.stringify(unit.selector)}]`
    : head
}

/** Splices ` → <unit>` after each `[ref=eN]` that has a locating identity. */
export function mergeDomUnits(
  text: string,
  units: Map<string, DomUnit>,
): string {
  if (units.size === 0) return text
  return text.replace(/\[ref=(e\d+)\]/g, (match, ref: string) => {
    const unit = units.get(ref)
    if (unit === undefined || !hasLocator(unit)) return match
    return `${match} → ${formatDomUnit(unit)}`
  })
}

/** Deep-probe result for `inspect` — everything an adapter author needs on one element. */
export interface InspectDetail {
  tag: string
  id?: string
  classes: string[]
  attributes: Record<string, string>
  text: string
  ancestors: Array<{ tag: string; id?: string; classes: string[] }>
  candidateSelectors: Array<{ strategy: string; selector: string }>
  outerHtml?: string
}

/**
 * Page-side deep probe. Injected together with DOM_UNIT_JS so the candidate
 * strategies reuse the same stable-selector synthesis (`__stableSelector`,
 * `__escIdent`, `__unique`).
 */
export const INSPECT_JS = String.raw`
function __inspectProbe(el) {
  if (!el || el.nodeType !== 1) return null;
  var out = {
    tag: el.tagName.toLowerCase(),
    classes: [],
    attributes: {},
    text: '',
    ancestors: [],
    candidateSelectors: []
  };
  if (el.id) out.id = el.id;
  var cls = el.getAttribute('class');
  if (cls) out.classes = cls.split(/\s+/).filter(Boolean).slice(0, 20);
  for (var i = 0; i < el.attributes.length && i < 24; i++) {
    var a = el.attributes[i];
    if (a.name === 'class' || a.name === 'id' || a.name.indexOf('on') === 0) continue;
    out.attributes[a.name] = a.value.slice(0, 120);
  }
  out.text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  var p = el.parentElement;
  for (var d = 0; d < 6 && p && p.nodeType === 1; d++) {
    var anc = { tag: p.tagName.toLowerCase(), classes: [] };
    if (p.id) anc.id = p.id;
    var pc = p.getAttribute('class');
    if (pc) anc.classes = pc.split(/\s+/).filter(Boolean).slice(0, 6);
    out.ancestors.push(anc);
    p = p.parentElement;
  }
  out.candidateSelectors = __candidates(el);
  var html = el.outerHTML;
  if (html) out.outerHtml = html.slice(0, 600);
  return out;
}
function __candidates(el) {
  var out = [];
  var seen = {};
  function push(strategy, sel) {
    if (!sel || seen[sel]) return;
    if (__unique(sel)) { seen[sel] = 1; out.push({ strategy: strategy, selector: sel }); }
  }
  if (el.id) push('id', '#' + __escIdent(el.id));
  var names = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
  for (var i = 0; i < names.length; i++) {
    var v = el.getAttribute(names[i]);
    if (v) push(names[i], '[' + names[i] + '="' + __escAttr(v) + '"]');
  }
  var tag = el.tagName.toLowerCase();
  var classes = Array.prototype.slice.call(el.classList || []).slice(0, 6);
  if (classes.length) push('class', tag + '.' + classes.map(__escIdent).join('.'));
  var stable = __stableSelector(el);
  if (stable) push('structural', stable);
  return out;
}
`

export function isInspectDetail(value: unknown): value is InspectDetail {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<InspectDetail>
  return (
    typeof candidate.tag === 'string' &&
    candidate.tag.length > 0 &&
    Array.isArray(candidate.classes) &&
    typeof candidate.attributes === 'object' &&
    candidate.attributes !== null &&
    typeof candidate.text === 'string' &&
    Array.isArray(candidate.ancestors) &&
    Array.isArray(candidate.candidateSelectors)
  )
}

// ── P3-5 DOM fingerprints (act/diff feedback dimension) ─────────────────────

/** One node's identity for change detection: `key` is stable across renders,
 * `desc` is the human/agent-readable locator summary. */
export interface DomFingerprint {
  key: string
  desc: string
}

export interface DomChangeEntry {
  key: string
  desc: string
}

export interface DomChangeSummary {
  added: DomChangeEntry[]
  removed: DomChangeEntry[]
  scanned: number
}

const MAX_FINGERPRINTS = 800
const MAX_DOM_CHANGES = 20

/**
 * Page-side fingerprint sweep: one evaluate call over the whole document,
 * keeping only change-worthy nodes (id/testid, interactive tags, or
 * loading-ish classes). A bounded full sweep truncates from the tail — and
 * the tail is where freshly-appended nodes land — so selection both bounds
 * cost and protects the dynamic tail. Identity is id/testid when present
 * (survives DOM moves); otherwise a class + positional path key (re-renders
 * that shuffle positions read as remove+add — the known noise tradeoff).
 */
export const DOM_FINGERPRINT_JS = String.raw`
function __domFingerprints() {
  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var INTERACTIVE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, LABEL: 1, FORM: 1, IMG: 1 };
  var LOADING_RE = /(loading|spinner|progress|skeleton|busy|pending)/i;
  var out = [];
  var els = document.querySelectorAll('*');
  var total = 0;
  for (var i = 0; i < els.length && out.length < 800; i++) {
    var el = els[i];
    var up = el.tagName;
    if (!up || SKIP[up] || up.toLowerCase() === 'svg') continue;
    var tag = up.toLowerCase();
    if (tag === 'html' || tag === 'body') continue;
    var id = el.id;
    var tid = __probeAttr(el, ['data-testid', 'data-test', 'data-cy', 'data-qa']);
    var cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4);
    // Selective sweep: a bounded full-document walk truncates from the tail,
    // and the tail is exactly where freshly-appended nodes land — so the
    // sweep keeps only nodes with a change-worthy identity: named (id or
    // testid), interactive, or visually loading-ish. Pure structural divs
    // stay out; their churn is noise the AX diff already covers via roles.
    if (!id && !tid && !INTERACTIVE[up] && !(cls.length && LOADING_RE.test(cls.join(' ')))) continue;
    total++;
    var desc = tag;
    if (id) desc += '#' + id;
    else if (tid) desc += '[' + tid + ']';
    else if (cls.length) desc += '.' + cls.join('.');
    var key;
    if (id) key = tag + '#' + id;
    else if (tid) key = tag + '[' + tid + ']';
    else {
      var path = [];
      var node = el;
      for (var d = 0; d < 3 && node && node.nodeType === 1; d++) {
        var seg = node.tagName.toLowerCase();
        if (node.id) {
          path.unshift(seg + '#' + node.id);
          break;
        }
        path.unshift(seg + ':nth-of-type(' + __nthOfType(node) + ')');
        node = node.parentElement;
      }
      key = desc + '@' + path.join('>');
    }
    out.push({ key: key, desc: desc });
  }
  return { items: out, total: els.length };
}
function __nthOfType(el) {
  var n = 1;
  var sib = el;
  while ((sib = sib.previousElementSibling)) {
    if (sib.tagName === el.tagName) n++;
  }
  return n;
}
`

/** Sweeps the main-frame document for DOM fingerprints (one evaluate call). */
export async function collectDomFingerprints(
  session: ProtocolApi,
): Promise<DomFingerprint[] | undefined> {
  try {
    const result = await session.Runtime.evaluate({
      expression: `(function(){\n${DOM_UNIT_JS}\n${DOM_FINGERPRINT_JS}\nreturn __domFingerprints();\n})()`,
      returnByValue: true,
    })
    const value = result.result?.value
    if (value === null || typeof value !== 'object') return undefined
    const items = (value as { items?: unknown }).items
    if (!Array.isArray(items)) return undefined
    return items
      .filter(
        (item): item is DomFingerprint =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as DomFingerprint).key === 'string' &&
          typeof (item as DomFingerprint).desc === 'string',
      )
      .slice(0, MAX_FINGERPRINTS)
  } catch {
    return undefined
  }
}

/** Set-diffs two fingerprint sweeps; undefined when either side or no change. */
export function diffDomFingerprints(
  before: DomFingerprint[] | undefined,
  after: DomFingerprint[] | undefined,
): DomChangeSummary | undefined {
  if (before === undefined || after === undefined) return undefined
  const beforeKeys = new Set(before.map((f) => f.key))
  const afterKeys = new Set(after.map((f) => f.key))
  const added: DomChangeEntry[] = []
  const removed: DomChangeEntry[] = []
  for (const f of after) {
    if (!beforeKeys.has(f.key)) added.push({ key: f.key, desc: f.desc })
  }
  for (const f of before) {
    if (!afterKeys.has(f.key)) removed.push({ key: f.key, desc: f.desc })
  }
  if (added.length === 0 && removed.length === 0) return undefined
  return {
    added: added.slice(0, MAX_DOM_CHANGES),
    removed: removed.slice(0, MAX_DOM_CHANGES),
    scanned: after.length,
  }
}

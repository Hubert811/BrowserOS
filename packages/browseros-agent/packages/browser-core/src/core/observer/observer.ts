import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import type { FrameId } from '../connection'
import type { PageManager } from '../pages'
import { diffSnapshotObservations, type SnapshotDiff } from '../snapshot/diff'
import {
  collectDomFingerprints,
  collectDomUnits,
  DOM_UNIT_JS,
  type DomFingerprint,
  type DomUnit,
  diffDomFingerprints,
  INSPECT_JS,
  type InspectDetail,
  isInspectDetail,
  mergeDomUnits,
} from '../snapshot/dom-unit'
import { type DocumentId, type RefEntry, RefMap } from '../snapshot/refs'
import { renderSnapshot } from '../snapshot/render'
import { fetchAxTree } from './ax-tree'
import { findCursorHits } from './cursor-augment'
import type { FrameRegistry } from './frames'
import { type ResolvedElement, resolveRefEntry } from './resolve'

const MAX_FRAME_DEPTH = 5
const MAX_STABLE_CAPTURE_ATTEMPTS = 3

export interface SnapshotResult {
  text: string
  refs: RefMap
  url: string
}

interface MainFrameState {
  url: string
  documentId?: DocumentId
  frameDocuments: Map<FrameId | undefined, DocumentId>
}

interface RefScope {
  documentId: DocumentId
  url: string
}

interface CaptureResult extends SnapshotResult {
  scope?: RefScope
}

interface FrameTreeNode {
  frame: {
    id: FrameId
    loaderId?: string
    url?: string
    urlFragment?: string
  }
  childFrames?: FrameTreeNode[]
}

/** Per-page snapshot, ref, and diff state for one BrowserOS page id. */
export class Observer {
  private baseline?: { text: string; url: string }
  private refs = new RefMap()
  private refScope?: RefScope
  /** P3-5 — DOM fingerprints captured at the last snapshot/diff commit. */
  private domBaseline?: DomFingerprint[]

  constructor(
    private readonly pages: PageManager,
    private readonly frames: FrameRegistry,
    private readonly pageId: number,
  ) {}

  async snapshot(): Promise<SnapshotResult> {
    const result = await this.capture()
    this.commit(result)
    // Awaited: the next diff's DOM baseline must correspond to THIS snapshot.
    await this.commitDomBaseline()
    // P3-5 — DOM-unit enrichment is best-effort and lands only in the
    // returned text; the diff baseline keeps the pristine render so
    // diffSnapshotObservations never sees the injected ` → unit` suffixes.
    const text = await this.enrichWithDomUnits(result)
    return text === result.text ? result : { ...result, text }
  }

  async diff(): Promise<SnapshotDiff> {
    const before = this.baseline
    const beforeDom = this.domBaseline
    const result = await this.capture()
    const axDiff = diffSnapshotObservations(before, result)
    this.commit(result)
    const afterDom = await this.domFingerprintsNow()
    this.domBaseline = afterDom
    return { ...axDiff, dom: diffDomFingerprints(beforeDom, afterDom) }
  }

  get lastRefs(): RefMap {
    return this.refs
  }

  /** Resolve a ref from the last snapshot to a live element, routed to its frame's session. */
  async resolveRef(ref: string): Promise<ResolvedElement> {
    const entry = this.refs.get(ref)
    if (!entry) {
      throw new Error(`Unknown ref ${ref}; take a new snapshot.`)
    }
    await this.pages.getSession(this.pageId)
    const { session, axParams } = this.frames.resolveFrameTarget(
      this.pageId,
      entry.frameId,
    )
    return resolveRefEntry(session, entry, axParams)
  }

  /**
   * P3-5 — deep-probe one ref's backing element: full classes/attributes,
   * ancestor path, verified candidate selectors, and an outerHTML head.
   * Stale refs are re-resolved through the same two-tier logic as act.
   */
  async inspectRef(ref: string): Promise<InspectDetail> {
    const entry = this.refs.get(ref)
    if (!entry) {
      throw new Error(`Unknown ref ${ref}; take a new snapshot.`)
    }
    await this.pages.getSession(this.pageId)
    const { session, axParams } = this.frames.resolveFrameTarget(
      this.pageId,
      entry.frameId,
    )
    const { backendNodeId } = await resolveRefEntry(session, entry, axParams)
    const resolved = await session.DOM.resolveNode({ backendNodeId })
    const objectId = resolved.object?.objectId
    if (!objectId) {
      throw new Error(`Ref ${ref} no longer resolves to a live node.`)
    }
    try {
      const call = await session.Runtime.callFunctionOn({
        functionDeclaration: `function () {\n${DOM_UNIT_JS}\n${INSPECT_JS}\nreturn __inspectProbe(this);\n}`,
        objectId,
        returnByValue: true,
      })
      const value = call.result?.value
      if (!isInspectDetail(value)) {
        throw new Error(`Ref ${ref} inspect probe returned no detail.`)
      }
      return value
    } finally {
      await session.Runtime.releaseObject({ objectId }).catch(() => {})
    }
  }

  private async capture(): Promise<CaptureResult> {
    const pageSession = await this.pages.getSession(this.pageId)
    for (let attempt = 0; attempt < MAX_STABLE_CAPTURE_ATTEMPTS; attempt++) {
      const before = await this.readMainFrameState(pageSession.session)
      const refs = this.refsForCapture(before)
      const text = await this.captureFrame(
        undefined,
        refs,
        0,
        new Set(),
        pageSession.session,
        before.frameDocuments,
      )
      const after = await this.readMainFrameState(pageSession.session)
      if (!knownMainFrameChanged(before, after)) {
        return { text, refs, url: after.url, scope: refScopeFrom(after) }
      }
    }
    throw new Error('Page document changed during snapshot capture; retry.')
  }

  /** Render a frame, then splice each child iframe's rendered tree under its `- iframe` line. */
  private async captureFrame(
    frameId: FrameId | undefined,
    refs: RefMap,
    baseDepth: number,
    visited: Set<FrameId>,
    rootSession: ProtocolApi,
    frameDocuments: Map<FrameId | undefined, DocumentId>,
  ): Promise<string> {
    if (frameId !== undefined) {
      if (visited.has(frameId)) return ''
      visited.add(frameId)
    }

    const { session, axParams } = this.frames.resolveFrameTarget(
      this.pageId,
      frameId,
    )
    const nodes = await fetchAxTree(session, axParams)
    const cursorHits = await findCursorHits(session).catch(
      () => new Map<number, string[]>(),
    )
    const documentId = await this.stableDocumentIdForFrame(
      rootSession,
      frameId,
      frameDocuments,
    )
    const { text, iframes } = renderSnapshot(nodes, {
      refs,
      frameId,
      documentId,
      baseDepth,
      cursorHits,
    })
    if (iframes.length === 0 || baseDepth >= MAX_FRAME_DEPTH) return text

    const lines = text.split('\n')
    // Splice bottom-up so earlier line indices stay valid as we insert.
    for (const stitch of [...iframes].reverse()) {
      const childFrameId = await resolveChildFrameId(
        session,
        stitch.backendNodeId,
      )
      // B2 hardening: an iframe we cannot resolve or capture used to vanish
      // silently — the agent saw `- iframe` with nothing under it and could
      // not tell "empty frame" from "capture failed". Emit a notice line so
      // the gap is visible and actionable (frames + evaluate can still reach
      // the frame when the AX tree is not available).
      if (!childFrameId) {
        lines.splice(
          stitch.lineIndex + 1,
          0,
          `${'  '.repeat(stitch.depth + 1)}- (frame content unavailable — use frames + evaluate {frame} to probe it)`,
        )
        continue
      }
      const childText = await this.captureFrame(
        childFrameId,
        refs,
        stitch.depth + 1,
        visited,
        rootSession,
        frameDocuments,
      ).catch(() => '')
      if (childText) {
        lines.splice(stitch.lineIndex + 1, 0, childText)
      } else {
        lines.splice(
          stitch.lineIndex + 1,
          0,
          `${'  '.repeat(stitch.depth + 1)}- (frame content unavailable — use frames + evaluate {frame} to probe it)`,
        )
      }
    }
    return lines.join('\n')
  }

  private commit(result: CaptureResult): void {
    this.baseline = { text: result.text, url: result.url }
    this.refs = result.refs
    this.refScope = result.scope
  }

  /** Sweeps the main frame's DOM fingerprints (undefined on any failure). */
  private async domFingerprintsNow(): Promise<DomFingerprint[] | undefined> {
    try {
      const pageSession = await this.pages.getSession(this.pageId)
      return await collectDomFingerprints(pageSession.session)
    } catch {
      return undefined
    }
  }

  /** P3-5 — snapshot commits a DOM baseline so the next diff has a
   * pre-action reference sweep (fire-and-forget; undefined stays undefined). */
  private async commitDomBaseline(): Promise<void> {
    this.domBaseline = await this.domFingerprintsNow()
  }

  /**
   * P3-5 — resolve every captured ref to its backing element and splice a
   * DOM unit (tag/id/testid + stable selector) after each `[ref=eN]`.
   * Entries are grouped by frame so each probe runs in its own frame's
   * session. Any failure degrades to the pristine text.
   */
  private async enrichWithDomUnits(result: CaptureResult): Promise<string> {
    try {
      const entries = [...result.refs.byRef.values()]
      if (entries.length === 0) return result.text
      const byFrame = new Map<FrameId | undefined, RefEntry[]>()
      for (const entry of entries) {
        const group = byFrame.get(entry.frameId)
        if (group) group.push(entry)
        else byFrame.set(entry.frameId, [entry])
      }
      const units = new Map<string, DomUnit>()
      for (const [frameId, group] of byFrame) {
        const { session } = this.frames.resolveFrameTarget(this.pageId, frameId)
        for (const [ref, unit] of await collectDomUnits(session, group)) {
          units.set(ref, unit)
        }
      }
      return mergeDomUnits(result.text, units)
    } catch {
      return result.text
    }
  }

  private refsForCapture(state: MainFrameState): RefMap {
    if (shouldResetRefs(this.refScope, state)) return new RefMap()
    return this.refs.forkForSnapshot()
  }

  private async readMainFrameState(
    session: ProtocolApi,
  ): Promise<MainFrameState> {
    try {
      const result = await session.Page.getFrameTree()
      const tree = result.frameTree as FrameTreeNode
      return {
        url: frameUrl(tree.frame),
        documentId: frameDocumentId(tree.frame),
        frameDocuments: collectFrameDocuments(tree),
      }
    } catch {
      return {
        url: await this.readRegistryUrl(),
        frameDocuments: new Map(),
      }
    }
  }

  /** Reads the tab registry URL after frame-tree lookup has already failed. */
  private async readRegistryUrl(): Promise<string> {
    try {
      return (await this.pages.refresh(this.pageId))?.url ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async stableDocumentIdForFrame(
    rootSession: ProtocolApi,
    frameId: FrameId | undefined,
    frameDocuments: Map<FrameId | undefined, DocumentId>,
  ): Promise<DocumentId | undefined> {
    const beforeDocumentId = frameDocuments.get(frameId)
    if (frameId === undefined || beforeDocumentId === undefined) {
      return beforeDocumentId
    }

    const latest = await this.readFrameDocuments(rootSession).catch(
      () => undefined,
    )
    const afterDocumentId = latest?.get(frameId)
    return afterDocumentId === beforeDocumentId ? beforeDocumentId : undefined
  }

  private async readFrameDocuments(
    session: ProtocolApi,
  ): Promise<Map<FrameId | undefined, DocumentId>> {
    const result = await session.Page.getFrameTree()
    return collectFrameDocuments(result.frameTree as FrameTreeNode)
  }
}

function knownUrlsDiffer(beforeUrl: string, afterUrl: string): boolean {
  return (
    beforeUrl !== 'unknown' && afterUrl !== 'unknown' && beforeUrl !== afterUrl
  )
}

function knownMainFrameChanged(
  before: MainFrameState,
  after: MainFrameState,
): boolean {
  if (knownUrlsDiffer(before.url, after.url)) return true
  return (
    before.documentId !== undefined &&
    after.documentId !== undefined &&
    before.documentId !== after.documentId
  )
}

function shouldResetRefs(
  current: RefScope | undefined,
  next: MainFrameState,
): boolean {
  if (current === undefined || next.documentId === undefined) return true
  if (current.documentId !== next.documentId) return true
  return knownUrlsDiffer(current.url, next.url)
}

function refScopeFrom(state: MainFrameState): RefScope | undefined {
  if (state.documentId === undefined) return undefined
  return { documentId: state.documentId, url: state.url }
}

function collectFrameDocuments(
  tree: FrameTreeNode,
): Map<FrameId | undefined, DocumentId> {
  const documents = new Map<FrameId | undefined, DocumentId>()

  function visit(node: FrameTreeNode, isRoot: boolean): void {
    const documentId = frameDocumentId(node.frame)
    if (documentId !== undefined) {
      documents.set(isRoot ? undefined : node.frame.id, documentId)
      documents.set(node.frame.id, documentId)
    }
    for (const child of node.childFrames ?? []) visit(child, false)
  }

  visit(tree, true)
  return documents
}

function frameDocumentId(
  frame: FrameTreeNode['frame'],
): DocumentId | undefined {
  if (frame.loaderId === undefined) return undefined
  return `${frame.id}:${frame.loaderId}`
}

function frameUrl(frame: FrameTreeNode['frame']): string {
  return frame.url ? `${frame.url}${frame.urlFragment ?? ''}` : 'unknown'
}

/** Resolve an iframe element to the frameId of its embedded document. */
async function resolveChildFrameId(
  session: ProtocolApi,
  backendNodeId: number,
): Promise<FrameId | undefined> {
  try {
    const described = await session.DOM.describeNode({
      backendNodeId,
      depth: 1,
    })
    const node = described.node as {
      contentDocument?: { frameId?: string }
      frameId?: string
    }
    return node.contentDocument?.frameId ?? node.frameId
  } catch {
    return undefined
  }
}

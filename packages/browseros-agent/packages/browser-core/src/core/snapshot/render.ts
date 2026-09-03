import type { CursorHit } from '../observer/cursor-augment'
import type { AXNode } from './ax-types'
import type { DocumentId, FrameId, RefMap } from './refs'
import { INTERACTIVE_ROLES, ROOT_ROLES, SKIP_ROLES, VALUE_ROLES } from './roles'

const IFRAME_ROLES: ReadonlySet<string> = new Set(['Iframe', 'iframe'])
const TEXT_LEAF_ROLES: ReadonlySet<string> = new Set([
  'StaticText',
  'InlineTextBox',
  'text',
])
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set(['generic', 'group'])
const MAX_SYNTHESIZED_NAME_LENGTH = 300

export interface IframeStitch {
  /** The iframe element, used to resolve its child frameId for stitching. */
  backendNodeId: number
  /** Index of the `- iframe` line within this render's output, for splicing child content. */
  lineIndex: number
  /** Absolute indent depth of the iframe line. */
  depth: number
}

export interface RenderResult {
  text: string
  iframes: IframeStitch[]
}

export interface RenderOptions {
  /** Shared across all frames of a page so refs form one global namespace. */
  refs: RefMap
  frameId?: FrameId
  documentId?: DocumentId
  /** backendNodeId → reasons, from the DOM cursor-augmentation pass. */
  cursorHits?: Map<number, CursorHit>
  /** Extra indent levels to prepend (used when splicing a child frame under its iframe line). */
  baseDepth?: number
}

/** Renders a CDP accessibility tree into the canonical agent-facing snapshot. */
export function renderSnapshot(
  nodes: AXNode[],
  opts: RenderOptions,
): RenderResult {
  const byId = new Map<string, AXNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  const base = opts.baseDepth ?? 0
  const lines: string[] = []
  const iframes: IframeStitch[] = []

  const isCursorHitNode = (node: AXNode): boolean =>
    node.backendDOMNodeId !== undefined &&
    (opts.cursorHits?.has(node.backendDOMNodeId) ?? false)

  /** Concatenated text when the subtree holds only text leaves inside unnamed
   * containers; undefined when any rendered element (named node, control,
   * cursor hit) appears — those must stay visible with their own refs. */
  const textOnlyContents = (node: AXNode): string | undefined => {
    const role = node.ignored ? undefined : strVal(node.role)
    if (role !== undefined && TEXT_LEAF_ROLES.has(role)) {
      return strVal(node.name)
    }
    if (role === 'LineBreak') return ''
    const transparent =
      role === undefined || (TRANSPARENT_ROLES.has(role) && !strVal(node.name))
    if (!transparent || isCursorHitNode(node)) return undefined
    const parts: string[] = []
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (!child) continue
      const text = textOnlyContents(child)
      if (text === undefined) return undefined
      if (text) parts.push(text)
    }
    return parts.join(' ')
  }

  /** Direct text-leaf children, for containers that mix text with controls. */
  const directTexts = (node: AXNode): string[] => {
    const texts: string[] = []
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (!child) continue
      const role = child.ignored ? undefined : strVal(child.role)
      if (role !== undefined && TEXT_LEAF_ROLES.has(role)) {
        const text = strVal(child.name)
        if (text) texts.push(text)
      }
    }
    return texts
  }

  const visit = (nodeId: string, depth: number): void => {
    const node = byId.get(nodeId)
    if (!node) return

    const role = node.ignored ? undefined : strVal(node.role)
    let name = strVal(node.name)
    const isCursorHit = isCursorHitNode(node)

    // Name-from-contents: text inside unnamed containers is otherwise
    // invisible — text leaves are skipped (SKIP_ROLES) and Chromium gives
    // plain <p>/<span>/<div> blocks no accessible name.
    let synthesized = false
    if (!name && !isCursorHit) {
      const deep = textOnlyContents(node)
      if (deep) {
        name = truncateName(deep)
        synthesized = true
      } else if (
        role !== undefined &&
        !SKIP_ROLES.has(role) &&
        !ROOT_ROLES.has(role)
      ) {
        const direct = directTexts(node)
        if (direct.length > 0) name = truncateName(direct.join(' '))
      }
    }

    if (isDropped(role, name, isCursorHit)) {
      for (const childId of node.childIds ?? []) visit(childId, depth)
      return
    }

    if (role && IFRAME_ROLES.has(role)) {
      let line = `${'  '.repeat(base + depth)}- iframe`
      if (name) line += ` ${JSON.stringify(name)}`
      lines.push(line)
      if (node.backendDOMNodeId !== undefined) {
        iframes.push({
          backendNodeId: node.backendDOMNodeId,
          lineIndex: lines.length - 1,
          depth: base + depth,
        })
      }
      return
    }

    lines.push(formatLine(node, role as string, name, base + depth, opts))
    if (synthesized) return
    for (const childId of node.childIds ?? []) visit(childId, depth + 1)
  }

  for (const rootId of entryNodeIds(nodes)) visit(rootId, 0)

  return { text: lines.join('\n'), iframes }
}

/** Where to begin the walk: document roots if present, else the first node. */
function entryNodeIds(nodes: AXNode[]): string[] {
  const roots = nodes
    .filter((n) => ROOT_ROLES.has(strVal(n.role)))
    .map((n) => n.nodeId)
  if (roots.length > 0) return roots
  return nodes[0] ? [nodes[0].nodeId] : []
}

function isDropped(
  role: string | undefined,
  name: string,
  isCursorHit: boolean,
): boolean {
  if (!role) return true
  if (SKIP_ROLES.has(role) || ROOT_ROLES.has(role)) return true
  // Unnamed generic containers carry no meaning unless they're cursor-interactive.
  if ((role === 'generic' || role === 'group') && !name && !isCursorHit) {
    return true
  }
  return false
}

function formatLine(
  node: AXNode,
  role: string,
  name: string,
  depth: number,
  opts: RenderOptions,
): string {
  const backendNodeId = node.backendDOMNodeId
  const cursorHit =
    backendNodeId !== undefined
      ? opts.cursorHits?.get(backendNodeId)
      : undefined
  // A cursor hit with no accessible name gets its harvested label as the
  // display name — without it, custom-widget grids (QuickBI-style filter
  // fields) render as a wall of identical anonymous generics.
  const displayName =
    name ||
    (cursorHit?.label !== undefined && cursorHit.label !== ''
      ? cursorHit.label
      : '')

  let line = `${'  '.repeat(depth)}- ${role}`
  if (displayName) line += ` ${JSON.stringify(displayName)}`

  for (const state of formatStates(node)) line += ` [${state}]`
  const actionable =
    backendNodeId !== undefined &&
    (INTERACTIVE_ROLES.has(role) || cursorHit !== undefined)

  if (actionable) {
    const ref = opts.refs.mint({
      backendNodeId: backendNodeId as number,
      role,
      name,
      documentId: opts.documentId,
      frameId: opts.frameId,
    })
    line += ` [ref=${ref}]`
  }
  if (cursorHit !== undefined) line += ' [cursor=pointer]'

  if (VALUE_ROLES.has(role)) {
    const value = strVal(node.value)
    if (value) line += `: ${JSON.stringify(value)}`
  }

  return line
}

function formatStates(node: AXNode): string[] {
  const states: string[] = []
  for (const prop of node.properties ?? []) {
    const v = prop.value.value
    switch (prop.name) {
      case 'checked':
        if (v === true) states.push('checked')
        else if (v === 'mixed') states.push('indeterminate')
        break
      case 'disabled':
        if (v === true) states.push('disabled')
        break
      case 'expanded':
        if (v === true) states.push('expanded')
        else if (v === false) states.push('collapsed')
        break
      case 'required':
        if (v === true) states.push('required')
        break
      case 'selected':
        if (v === true) states.push('selected')
        break
      case 'level':
        states.push(`level=${v}`)
        break
      default:
        break
    }
  }
  return states
}

function strVal(value: AXNode['role']): string {
  return typeof value?.value === 'string' ? value.value : ''
}

function truncateName(text: string): string {
  if (text.length <= MAX_SYNTHESIZED_NAME_LENGTH) return text
  return `${text.slice(0, MAX_SYNTHESIZED_NAME_LENGTH)}…`
}

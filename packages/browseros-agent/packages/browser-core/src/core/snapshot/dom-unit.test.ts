import { describe, expect, test } from 'bun:test'
import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import {
  collectDomUnits,
  DOM_UNIT_JS,
  type DomUnit,
  formatDomUnit,
  mergeDomUnits,
} from './dom-unit'
import type { RefEntry } from './refs'

/** Stubs the minimal CDP surface collectDomUnits drives. */
function stubSession(opts: {
  units: Map<number, DomUnit | undefined>
  failNodes?: Set<number>
  calls?: string[]
}): ProtocolApi {
  return {
    DOM: {
      resolveNode: async ({ backendNodeId }: { backendNodeId: number }) => {
        if (opts.failNodes?.has(backendNodeId)) {
          throw new Error('No node with given id')
        }
        return { object: { objectId: `obj-${backendNodeId}` } }
      },
    },
    Runtime: {
      callFunctionOn: async (params: { objectId: string }) => {
        opts.calls?.push(params.objectId)
        const backendNodeId = Number(params.objectId.replace('obj-', ''))
        const unit = opts.units.get(backendNodeId)
        return { result: { value: unit ?? null } }
      },
      releaseObject: async () => {},
    },
  } as unknown as ProtocolApi
}

function entry(ref: string, backendNodeId: number): RefEntry {
  return {
    ref,
    backendNodeId,
    role: 'button',
    name: 'x',
    nth: 0,
    frameId: undefined,
  }
}

describe('DOM_UNIT_JS asset', () => {
  test('is syntactically valid JavaScript', () => {
    // The asset is injected verbatim; a syntax error would break every
    // snapshot. Parsing it here (without executing) catches regressions.
    new Bun.Transpiler({ loader: 'js' }).transformSync(DOM_UNIT_JS)
  })

  // Compiles the checked-in asset string to run it against a stub element.
  // The input is a static constant authored in this repo — not user data.
  const compileProbe = () =>
    new Function(`${DOM_UNIT_JS}\nreturn __domUnitProbe;`)() as (
      el: unknown,
    ) => DomUnit | null

  test('identifies an element with an id', () => {
    const probe = compileProbe()
    const el = {
      nodeType: 1,
      tagName: 'INPUT',
      id: 'q',
      getAttribute: () => null,
      classList: [],
    }
    // No `document` in this environment, so selector synthesis degrades
    // to undefined via the probe's own try/catch — the unit still lands.
    expect(probe(el)).toMatchObject({ tag: 'input', id: 'q' })
  })

  test('returns null for non-element input', () => {
    const probe = compileProbe()
    expect(probe(null)).toBeNull()
    expect(probe({ nodeType: 3 })).toBeNull()
  })
})

describe('collectDomUnits', () => {
  test('maps refs to units and skips failed or null probes', async () => {
    const session = stubSession({
      units: new Map([
        [1, { tag: 'input', id: 'q', selector: '#q' }],
        [3, undefined],
      ]),
      failNodes: new Set([4]),
    })
    const units = await collectDomUnits(session, [
      entry('e1', 1),
      entry('e2', 2),
      entry('e3', 3),
      entry('e4', 4),
    ])

    // e1 resolves; e2's probe returns null (missing from map); e3 returns an
    // explicit null; e4's resolveNode throws — all degrade to "no unit".
    expect(units.size).toBe(1)
    expect(units.get('e1')).toMatchObject({
      tag: 'input',
      id: 'q',
      selector: '#q',
    })
  })

  test('caps the number of probed refs', async () => {
    const calls: string[] = []
    const session = stubSession({ units: new Map(), calls })
    const entries = Array.from({ length: 500 }, (_, i) => entry(`e${i}`, i + 1))
    await collectDomUnits(session, entries)
    expect(calls.length).toBeLessThanOrEqual(400)
  })
})

describe('formatDomUnit', () => {
  test('renders id head with selector', () => {
    expect(formatDomUnit({ tag: 'input', id: 'q', selector: '#q' })).toBe(
      'input#q [sel="#q"]',
    )
  })

  test('renders testid head', () => {
    expect(
      formatDomUnit({
        tag: 'button',
        testid: 'submit-btn',
        selector: '[data-testid="submit-btn"]',
      }),
    ).toBe(
      'button[data-testid=submit-btn] [sel="[data-testid=\\"submit-btn\\"]"]',
    )
  })

  test('renders bare tag when no id/testid but a selector exists', () => {
    expect(
      formatDomUnit({ tag: 'div', selector: 'div.foo > div:nth-of-type(2)' }),
    ).toBe('div [sel="div.foo > div:nth-of-type(2)"]')
  })

  test('truncates long identifiers', () => {
    const long = 'x'.repeat(48)
    expect(formatDomUnit({ tag: 'input', id: long })).toBe(
      `input#${'x'.repeat(32)}…`,
    )
  })
})

describe('mergeDomUnits', () => {
  test('splices units after the trailing ref, keeping unrelated lines intact', () => {
    // Rendered lines carry the ref at the end (render.ts appends
    // ` [ref=eN]`), so enrichment lands as a trailing ` → unit` segment.
    const text = [
      '- textbox "Search":',
      '  textbox Search [ref=e1]',
      '  button Go [ref=e2]',
    ].join('\n')
    const merged = mergeDomUnits(
      text,
      new Map([
        ['e1', { tag: 'input', id: 'q', selector: '#q' }],
        ['e2', { tag: 'button', selector: 'button.go' }],
      ]),
    )
    expect(merged).toContain('textbox Search [ref=e1] → input#q [sel="#q"]')
    expect(merged).toContain('button Go [ref=e2] → button [sel="button.go"]')
    expect(merged).toContain('- textbox "Search":')
  })

  test('leaves refs without a locating identity untouched', () => {
    const text = '  [ref=e1] generic Static'
    expect(mergeDomUnits(text, new Map([['e1', { tag: 'div' }]]))).toBe(text)
  })

  test('returns the text unchanged for an empty unit map', () => {
    const text = '  [ref=e1] button Go'
    expect(mergeDomUnits(text, new Map())).toBe(text)
  })
})

// ── P3-5 DOM fingerprints ──────────────────────────────────────────────────

import {
  collectDomFingerprints,
  type DomFingerprint,
  diffDomFingerprints,
} from './dom-unit'

describe('diffDomFingerprints', () => {
  const f = (key: string, desc = key): DomFingerprint => ({ key, desc })

  test('reports added and removed keys with counts', () => {
    const before = [f('a'), f('b'), f('c')]
    const after = [f('b'), f('c'), f('d#new'), f('e')]
    const summary = diffDomFingerprints(before, after)
    expect(summary).toBeDefined()
    expect(summary?.added.map((x) => x.desc)).toEqual(['d#new', 'e'])
    expect(summary?.removed.map((x) => x.desc)).toEqual(['a'])
    expect(summary?.scanned).toBe(4)
  })

  test('returns undefined when nothing changed', () => {
    const set = [f('a'), f('b')]
    expect(diffDomFingerprints(set, [f('b'), f('a')])).toBeUndefined()
  })

  test('returns undefined when either sweep is missing (first diff)', () => {
    expect(diffDomFingerprints(undefined, [f('a')])).toBeUndefined()
    expect(diffDomFingerprints([f('a')], undefined)).toBeUndefined()
  })

  test('caps change lists at 20 entries', () => {
    const before: DomFingerprint[] = []
    const after: DomFingerprint[] = Array.from({ length: 40 }, (_, i) =>
      f(`n${i}`),
    )
    const summary = diffDomFingerprints(before, after)
    expect(summary?.added.length).toBe(20)
  })
})

describe('collectDomFingerprints', () => {
  test('extracts items from the evaluate payload and drops malformed rows', async () => {
    const session = {
      Runtime: {
        evaluate: async () => ({
          result: {
            value: {
              items: [
                { key: 'div#x', desc: 'div#x' },
                { key: 42, desc: 'bad' },
                null,
                { key: 'span.t', desc: 'span.t' },
              ],
              total: 3,
            },
          },
        }),
      },
    } as unknown as import('@browseros/cdp-protocol/protocol-api').ProtocolApi
    const prints = await collectDomFingerprints(session)
    expect(prints).toHaveLength(2)
    expect(prints?.[0]).toEqual({ key: 'div#x', desc: 'div#x' })
  })

  test('degrades to undefined when the evaluate call throws', async () => {
    const session = {
      Runtime: {
        evaluate: async () => {
          throw new Error('detached')
        },
      },
    } as unknown as import('@browseros/cdp-protocol/protocol-api').ProtocolApi
    expect(await collectDomFingerprints(session)).toBeUndefined()
  })

  test('DOM_FINGERPRINT_JS compiles (syntax guard for the injected asset)', () => {
    const { DOM_FINGERPRINT_JS } = require('./dom-unit')
    new Bun.Transpiler({ loader: 'js' }).transformSync(DOM_FINGERPRINT_JS)
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../src/stream-fade.js', import.meta.url), 'utf8')
function setup() {
  let now = 1000
  const api = runInNewContext(source + '\n({ SF_DURATION, sfAppend, sfDrive, sfDrop, sfBlocked, sfClock, sfSyncSurfaces, sfSurfaceBlocked, sfPaintDecorations, sfResolveRows, sfActive, sfPendingRows, sfScopes, sfRowAnimations })', {
    performance: { now: () => now }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  })
  function node(rank, scope, descendants = []) {
    return { rank, scope, isConnected: true,
      closest: () => scope,
      contains: other => descendants.includes(other),
      compareDocumentPosition: other => rank < other.rank ? 4 : 2,
    }
  }
  function state(rank, scope, text = 'abcdefgh') {
    const root = node(rank, scope)
    const value = { root, scope, clock: api.sfClock(scope), text, nodes: [{ node: root, start: 0, end: text.length }],
      blockStarts: [], spans: [], kind: 'body', running: true, cursor: 0, arrived: 0, rate: 0, arrivalRate: 0,
      gapMs: 0, arrivals: [], lastArrival: 0, lastTick: 0, lastUnitBorn: 0 }
    api.sfAppend(value, 0, text.length)
    return value
  }
  function tick(ms = 16) {
    now += ms
    for (const value of api.sfActive) {
      api.sfDrive(value, now)
      for (const span of value.spans) span.value = Math.min(1, Math.max(0, (now - span.born) / api.SF_DURATION))
    }
  }
  return { api, node, state, tick }
}

test('body waits for actual reasoning paint completion, independently per conversation', t => {
  const c = setup()
  const scope = {}
  const reasoning = c.state(1, scope)
  const body = c.state(3, scope)
  const unrelated = c.state(5, {})
  c.tick()
  assert.ok(Number.isFinite(reasoning.spans[0].born))
  assert.equal(body.spans[0].born, Infinity)
  assert.ok(Number.isFinite(unrelated.spans[0].born))
  reasoning.running = false
  let started = false
  for (let i = 0; i < 200; i++) {
    const brightBeforeTick = reasoning.spans.every(span => span.value === 1)
    c.tick()
    if (Number.isFinite(body.spans[0].born)) {
      assert.ok(brightBeforeTick || reasoning.spans.every(span => span.value === 1))
      started = true
      break
    }
  }
  assert.ok(started)
  const transition = body.spans[0].born - Math.max(...reasoning.spans.map(span => span.born + c.api.SF_DURATION))
  assert.ok(transition >= 0 && transition <= 16)
  t.diagnostic(`reasoning paint completion to body release: ${transition} ms`)
  assert.equal(reasoning.clock, body.clock)
  assert.notEqual(body.clock, unrelated.clock)
})

test('removal releases ordering and waiting does not bank clock credit', () => {
  const c = setup()
  const scope = {}
  const before = c.state(1, scope, 'x'.repeat(1000))
  const after = c.state(2, scope, 'x'.repeat(100))
  for (let i = 0; i < 20; i++) c.tick()
  assert.equal(after.cursor, 0)
  c.api.sfDrop(before)
  c.tick(10000)
  assert.ok(after.cursor > 0 && after.cursor < 10, 'long wait cannot produce a release storm')
})

test('a row waits only for preceding text and never its own or later output', () => {
  const c = setup()
  const scope = {}
  const before = c.state(1, scope)
  const own = c.state(3, scope)
  const later = c.state(5, scope)
  const row = c.node(2, scope, [own.root])
  row.querySelector = () => null
  row.animate = () => ({ cancel() {} })
  const seat = { contains: () => true }
  const group = { seat, pending: new Map() }
  const entry = { row, scope, group, signature: 'tool:0', hold: { cancel() {} }, barriers: null }
  group.pending.set(entry.signature, entry)
  c.api.sfPendingRows.add(entry)
  c.api.sfScopes.set(scope, new Map([['seat', { sources: new Map([['before', before], ['own', own], ['later', later]]) }]]))
  c.api.sfResolveRows()
  assert.ok(c.api.sfPendingRows.has(entry))
  for (const span of before.spans) span.value = 1
  c.api.sfResolveRows()
  assert.equal(c.api.sfPendingRows.size, 0)
  assert.equal(c.api.sfRowAnimations.size, 1)
  assert.ok(c.api.sfBlocked(own, 0), 'expanded text follows header animation')
  assert.ok(c.api.sfBlocked(later, 0))
  c.api.sfRowAnimations.clear()
  assert.equal(c.api.sfBlocked(own, 0), false)
  assert.ok(c.api.sfBlocked(later, 0), 'later body still waits for own expanded text')
})

test('large live backfills remain queued with bounded span allocation and finite drain', t => {
  const c = setup()
  const value = c.state(1, {}, 'x'.repeat(20000))
  assert.equal(value.cursor, 0)
  assert.ok(value.spans.length <= 600)
  value.running = false
  let elapsed = 0
  while (value.spans.some(span => span.value < 1) && elapsed < 6000) { c.tick(); elapsed += 16 }
  t.diagnostic(`20000-character live backfill fully bright in ${elapsed} ms; ${value.spans.length} ranges`)
  assert.ok(elapsed < 3500)
})


test('queued summaries use fully transparent paint until release', () => {
  const levels = Array.from({ length: 16 }, (_, index) => ({ index }))
  const highlight = runInNewContext(source + '\nsfHighlights = levels; sfLevelHighlight', { levels })
  assert.equal(highlight(true, 0), levels[0])
  assert.equal(highlight(true, 1), levels[8])
  assert.equal(highlight(true, 15), levels[15])
})


function surface(c, scope, text = '') {
  const body = c.state(3, scope, text)
  body.surfacePending = true
  body.root.textContent = text || 'const codeOnly = true'
  body.root.animate = () => ({ pause() {}, cancel() { this.canceled = true } })
  c.api.sfScopes.set(scope, new Map([['body', { sources: new Map([['body:0', body]]) }]]))
  return body
}

test('whole new body surface conceals code-only output until external paint completes', () => {
  const c = setup()
  const scope = {}
  const reasoning = c.state(1, scope)
  const body = surface(c, scope)
  assert.equal(c.api.sfActive.has(body), false, 'code-only source has no ranged prose')
  c.api.sfSyncSurfaces()
  const hold = body.surfaceHold
  assert.ok(hold)
  body.running = false
  c.api.sfSyncSurfaces()
  assert.equal(body.surfaceHold, hold, 'completion does not flash a held code block')
  for (const span of reasoning.spans) span.value = 1
  c.api.sfSyncSurfaces()
  assert.equal(hold.canceled, true)
  assert.equal(body.surfaceHold, null)
  assert.equal(body.surfacePending, false)
})

test('whole body hold migrates across root replacement and cancels on source drop', () => {
  const c = setup()
  const scope = {}
  c.state(1, scope)
  const body = surface(c, scope, 'prose and code')
  c.api.sfSyncSurfaces()
  const old = body.surfaceHold
  body.root = { ...body.root }
  c.api.sfSyncSurfaces()
  assert.equal(old.canceled, true)
  const replacement = body.surfaceHold
  assert.ok(replacement && replacement !== old)
  c.api.sfDrop(body)
  assert.equal(replacement.canceled, true)
  assert.equal(body.surfaceHold, null)
})

test('whole surface gate never hides an ancestor prerequisite or another conversation', () => {
  const c = setup()
  const scope = {}
  const reasoning = c.state(1, scope)
  const body = surface(c, scope)
  // Even a pathological DOM-order double cannot make an owned prerequisite
  // block its ancestor. In real DOM it also compares as contained-by.
  body.root.contains = node => node === reasoning.root
  c.api.sfSyncSurfaces()
  assert.equal(body.surfaceHold, null)
  const other = surface(c, {})
  c.api.sfSyncSurfaces()
  assert.equal(other.surfaceHold, null)
})


test('same-source decorations follow preceding paint and first own character without timers', () => {
  const c = setup(), scope = {}, body = c.state(1, scope)
  const code = c.node(3, scope)
  code.animate = () => ({ effect: { setKeyframes() {} }, pause() {}, cancel() { this.canceled = true } })
  const entry = { element: code, inline: true, offset: 4, pending: true }
  body.decorations = [entry]
  body.nodes = [{ node: body.root, start: 0, end: 4 }, { node: code, start: 4, end: 8 }]
  c.api.sfPaintDecorations(body)
  const hold = entry.hold
  assert.ok(hold, 'background must be hidden behind same-source prose')
  for (const span of body.spans) if (span.end <= 4) span.value = 1
  body.spans[2].level = 0
  c.api.sfPaintDecorations(body)
  assert.equal(entry.hold, hold, 'first own glyph still transparent')
  body.spans[2].level = 1
  c.api.sfPaintDecorations(body)
  assert.equal(hold.currentTime, 1 / 15, 'surface fades in the very same paint update')
  body.spans[2].level = 15
  c.api.sfPaintDecorations(body)
  assert.equal(hold.canceled, true)
  assert.equal(entry.pending, false)
  body.spans[2].level = 0
  c.api.sfPaintDecorations(body)
  assert.equal(entry.hold, null, 'settled owner never replays')
})

test('same-source excluded code block releases immediately after prose and drops cleanly', () => {
  const c = setup(), scope = {}, body = c.state(1, scope)
  const block = c.node(3, scope)
  block.animate = () => ({ pause() {}, cancel() { this.canceled = true } })
  body.decorations = [{ element: block, inline: false, pending: true }]
  c.api.sfPaintDecorations(body)
  const hold = body.decorations[0].hold
  assert.ok(hold)
  for (const span of body.spans) span.value = 1
  c.api.sfPaintDecorations(body)
  assert.equal(hold.canceled, true)
  body.decorations = [{ element: block, inline: false, pending: true }]
  body.spans[0].value = 0
  c.api.sfPaintDecorations(body)
  const cleanup = body.decorations[0].hold
  c.api.sfDrop(body)
  assert.equal(cleanup.canceled, true)
  assert.equal(body.decorations.length, 0)
})

test('unfinished citation recognition scopes the URL and respects Markdown delimiters', () => {
  const detect = runInNewContext(source + '\nsfUnfinishedDestination')
  for (const text of ['前文 [AP](https://apnews.com/a', '[AP](https://apnews.com/a_(b)', '[AP](https://apnews.com/a_(b']) {
    const result = detect(text)
    assert.equal(result.start, text.indexOf('https:'))
    assert.equal(result.end, text.length)
  }
  for (const text of ['https://apnews.com/a', '[AP](https://apnews.com/a)', '[AP](https://apnews.com/a_(b))', '![AP](https://apnews.com/a', String.raw`\[AP](https://apnews.com/a`, '[AP](https://apnews.com/a next', '[AP](https://apnews.com/a) [other]', '`[AP](https://apnews.com/a']) {
    assert.equal(detect(text), null, text)
  }
  assert.equal(detect('[AP](https://apnews.com/a', 5), null, 'a block boundary cannot inherit an opening label')
})

test('link icon follows its label clock without attenuating the anchor text', () => {
  const c = setup(), scope = {}, body = c.state(1, scope)
  const anchor = c.node(3, scope), icon = c.node(4, scope), label = c.node(5, scope)
  anchor.contains = node => node === icon || node === label
  let keyframes
  icon.animate = () => ({ effect: { setKeyframes(value) { keyframes = value } }, pause() {}, cancel() { this.canceled = true } })
  anchor.animate = () => { throw Error('The anchor text must not receive another opacity effect') }
  body.nodes = [{ node: body.root, start: 0, end: 4 }, { node: label, start: 4, end: 8 }]
  const entry = { element: icon, owner: anchor, offset: 4, inline: true, pending: true }
  body.decorations = [entry]
  c.api.sfPaintDecorations(body)
  assert.ok(entry.hold)
  for (const span of body.spans) if (span.end <= 4) span.value = 1
  body.spans[2].level = 5
  c.api.sfPaintDecorations(body)
  assert.equal(entry.hold.currentTime, 5 / 15)
  assert.equal(keyframes[0].opacity, 0)
  const hold = entry.hold
  body.spans[2].level = 15
  c.api.sfPaintDecorations(body)
  assert.equal(hold.canceled, true)
})

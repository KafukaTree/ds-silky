import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../src/stream-fade.js', import.meta.url), 'utf8')

// Evaluate the actual controller with a deterministic clock. No DOM, paint,
// transport, or generated bundle is involved in these scheduler regressions.
function controller() {
  let now = 1000
  const api = runInNewContext(source + '\n({ sfAppend, sfUpdate, sfDrive })', {
    performance: { now: () => now },
  })
  const state = {
    text: '', nodes: [], blockStarts: [], spans: [], kind: 'body', running: true,
    cursor: 0, arrived: 0, rate: 0, arrivalRate: 0, gapMs: 0,
    arrivals: [], lastArrival: 0, lastTick: 0, lastUnitBorn: 0,
  }
  return {
    state,
    append(text, blocks = []) {
      const start = state.text.length
      state.text += text
      state.blockStarts = blocks
      api.sfAppend(state, start, state.text.length)
    },
    update(text) {
      api.sfUpdate(state, { kind: state.kind, running: state.running }, {
        text, nodes: [], blockStarts: [], replaced: 0,
      }, true)
    },
    tick(ms = 16) {
      now += ms
      api.sfDrive(state, now)
      return now
    },
  }
}

test('a tail insertion releases its changed middle before the retained queued suffix', () => {
  const c = controller()
  c.append('abcdef')
  c.update('abcXYdef')
  // Put the frontier just before the inserted text, at a slow but valid rate.
  Object.assign(c.state, { cursor: 3, rate: 0.002, arrivalRate: 0.002, gapMs: 140 })
  c.tick()
  const middle = c.state.spans.find(span => span.start === 3)
  assert.ok(Number.isFinite(middle.born), 'changed middle should release at its frontier')
  assert.ok(c.state.spans.filter(span => span.start >= 5).every(span => span.born === Infinity),
    'retained suffix must wait behind the changed middle')
  for (let i = 0; i < 1000 && c.state.spans.some(span => span.born === Infinity); i++) c.tick()
  assert.ok(c.state.spans.every(span => Number.isFinite(span.born)), 'all queued text must drain')
  const ordered = [...c.state.spans].sort((a, b) => a.start - b.start)
  assert.ok(ordered.every((span, i) => i === 0 || span.born >= ordered[i - 1].born))
})

test('a rewritten middle drains even when a retained suffix has already started fading', () => {
  const c = controller()
  c.append('abcdef')
  Object.assign(c.state, { rate: 1, arrivalRate: 1 })
  c.tick()
  const originalBirth = c.state.spans.at(-1).born
  c.update('abcWXYZdef')
  Object.assign(c.state, { rate: 0.002, arrivalRate: 0.002 })
  c.tick()
  const middle = c.state.spans.filter(span => span.start >= 3 && span.end <= 7)
  assert.ok(Number.isFinite(middle[0].born))
  assert.equal(middle[1].born, Infinity)
  for (let i = 0; i < 1000 && middle.some(span => span.born === Infinity); i++) c.tick()
  assert.ok(middle.every(span => Number.isFinite(span.born)), 'finite suffix must not hide queued middle')
  assert.ok(c.state.spans.filter(span => span.start >= 7).every(span => span.born === originalBirth),
    'retained suffix keeps its fade progress')
})

test('newlines and rendered blocks still wait for the previous line fade', () => {
  for (const [text, blocks, boundary] of [['ab\ncd', [], 3], ['abcd', [2], 2]]) {
    const c = controller()
    c.append(text, blocks)
    Object.assign(c.state, { rate: 1, arrivalRate: 1 })
    const firstTick = c.tick()
    const nextLine = c.state.spans.find(span => span.start === boundary)
    assert.equal(nextLine.born, Infinity)
    assert.equal(c.state.cursor, boundary)
    c.tick(119)
    assert.equal(nextLine.born, Infinity)
    c.tick(1)
    assert.equal(nextLine.born, firstTick + 120)
  }
})

test('reduced motion, hidden documents, dragging, and the kill switch still disable fading', () => {
  let reducedMotion = false
  let disabled = false
  const environment = {
    rsDrag: null,
    document: { hidden: false },
    window: {
      CSS: { highlights: new Map(), supports: () => true },
      Highlight: class {},
      matchMedia: () => ({ matches: reducedMotion }),
      localStorage: { getItem: () => disabled ? '0' : null },
    },
  }
  const allowed = runInNewContext(source + '\nsfAllowed', environment)
  assert.equal(allowed(), true)
  reducedMotion = true
  assert.equal(allowed(), false)
  reducedMotion = false
  environment.document.hidden = true
  assert.equal(allowed(), false)
  environment.document.hidden = false
  environment.rsDrag = {}
  assert.equal(allowed(), false)
  environment.rsDrag = null
  disabled = true
  assert.equal(allowed(), false)
  disabled = false
  assert.equal(allowed(), true)
})

test('settling bypasses the line wait and large replacements free queued text', () => {
  const c = controller()
  c.append('ab\ncd')
  Object.assign(c.state, { rate: 1, arrivalRate: 1, running: false })
  c.tick()
  assert.ok(c.state.spans.every(span => Number.isFinite(span.born)))
  const replacement = controller()
  replacement.append('queued')
  replacement.append('x'.repeat(513))
  assert.equal(replacement.state.cursor, replacement.state.text.length)
  assert.equal(replacement.state.spans.length, 0)
})

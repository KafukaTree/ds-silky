import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../src/stream-fade.js', import.meta.url), 'utf8')

function harness() {
  const api = runInNewContext(source + '\n({ sfSyncMarkers, sfPaintMarkers, sfDrop, sfReset, seed(state) { sfScopes.set({}, new Map([["seat", { sources: new Map([["body", state]]) }]])) } })', {
    window: { getComputedStyle: element => ({ color: element.attributes.has('data-daf-stream-marker') ? 'rgba(90, 95, 100, 0)' : 'rgb(90, 95, 100)' }) },
  })
  let items = []
  const state = {
    root: { querySelectorAll: () => items }, nodes: [], text: '',
    kind: 'body', running: true, spans: [], cursor: 0, arrived: 0,
  }
  function item(text = '', parent = null) {
    const properties = new Map()
    const attributes = new Map()
    const element = {
      textContent: text, isConnected: true,
      parentElement: { closest: selector => selector === 'li' ? parent : null },
      closest: selector => selector === 'li' ? element : null,
      style: {
        setProperty: (key, value) => properties.set(key, value),
        removeProperty: key => properties.delete(key),
      },
      hasAttribute: key => attributes.has(key),
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
      properties, attributes,
    }
    items.push(element)
    return element
  }
  function snapshot(entries) {
    let offset = 0
    state.nodes = entries.map(([element, text]) => {
      element.textContent = text
      const entry = { node: { data: text, parentElement: element }, start: offset, end: offset + text.length }
      offset = entry.end
      return entry
    })
  }
  function span(start, end, level = 0) {
    const entry = { start, end, level, ranges: [], summary: false }
    state.spans.push(entry)
    return entry
  }
  function sync(baseline = false) { api.sfSyncMarkers(state, baseline); api.sfPaintMarkers(state) }
  return { api, state, item, snapshot, span, sync, replace: next => { items = next } }
}

const owned = element => element.attributes.has('data-daf-stream-marker')
const alpha = element => element.properties.get('--daf-marker-alpha')

test('markers follow first meaningful text, with independent nested markers', () => {
  const h = harness()
  const parent = h.item()
  const child = h.item('', parent)
  h.snapshot([[parent, '  parent'], [child, 'child']])
  h.span(0, 2, 15)
  const first = h.span(2, 8, 0)
  const nested = h.span(8, 13, 0)
  h.sync()
  assert.equal(alpha(parent), '0%')
  assert.equal(alpha(child), '0%')
  first.level = 7
  h.api.sfPaintMarkers(h.state)
  assert.equal(alpha(parent), '46.67%')
  assert.equal(alpha(child), '0%')
  h.state.spans = [nested]
  h.api.sfPaintMarkers(h.state)
  assert.equal(owned(parent), false)
  assert.equal(owned(child), true)
  assert.equal(parent.properties.size, 0)
})

test('hydrated markers stay visible; new empty items wait across replacement and text arrival', () => {
  const h = harness()
  const history = h.item()
  h.sync(true)
  assert.equal(owned(history), false)
  const empty = h.item('   ')
  h.sync()
  assert.equal(owned(history), false)
  assert.equal(owned(empty), true)
  const replacement = h.item('   ')
  h.replace([history, replacement])
  h.sync()
  assert.equal(owned(empty), false)
  assert.equal(owned(replacement), true)
  h.snapshot([[replacement, '  arriving']])
  h.span(0, 2, 15)
  const first = h.span(2, 10, 4)
  h.sync()
  assert.equal(alpha(replacement), '26.67%')
  first.level = 10
  h.api.sfPaintMarkers(h.state)
  assert.equal(alpha(replacement), '66.67%')
  h.state.spans = []
  h.api.sfPaintMarkers(h.state)
  assert.equal(owned(replacement), false)
})

test('replaced nodes retain marker progress while settled prefixes are unowned', () => {
  const h = harness()
  const settled = h.item()
  const pending = h.item()
  h.snapshot([[settled, 'old'], [pending, 'new']])
  h.span(3, 6, 6)
  h.sync()
  const nextSettled = h.item()
  const nextPending = h.item()
  h.replace([nextSettled, nextPending])
  h.snapshot([[nextSettled, 'old'], [nextPending, 'new']])
  h.sync()
  assert.equal(owned(settled), false)
  assert.equal(owned(pending), false)
  assert.equal(owned(nextSettled), false)
  assert.equal(alpha(nextPending), '40.00%')
  assert.equal(nextPending.properties.get('--daf-marker-ink'), 'rgb(90, 95, 100)')
})

test('cloned ownership cannot become transparent base ink or survive on settled replacements', () => {
  for (const settled of [false, true]) {
    const h = harness()
    const original = h.item()
    h.snapshot([[original, 'text']])
    h.span(0, 4, 0)
    h.sync()
    const clone = h.item()
    for (const [key, value] of original.attributes) clone.attributes.set(key, value)
    for (const [key, value] of original.properties) clone.properties.set(key, value)
    h.replace([clone])
    h.snapshot([[clone, 'text']])
    if (settled) h.state.spans = []
    else h.state.spans[0].level = 7
    h.sync()
    assert.equal(owned(original), false)
    if (settled) {
      assert.equal(owned(clone), false)
      assert.equal(clone.properties.size, 0)
    } else {
      assert.equal(clone.properties.get('--daf-marker-ink'), 'rgb(90, 95, 100)')
      assert.equal(alpha(clone), '46.67%')
    }
  }
})

test('final commit, dropped sources, and reset release empty marker owners without active spans', () => {
  for (const mode of ['final', 'drop', 'reset']) {
    const h = harness()
    h.sync(true)
    const empty = h.item()
    h.sync()
    assert.equal(owned(empty), true)
    if (mode === 'final') {
      h.state.running = false
      h.sync()
    } else if (mode === 'drop') h.api.sfDrop(h.state)
    else {
      h.api.seed(h.state)
      h.api.sfReset()
    }
    assert.equal(owned(empty), false, mode)
    assert.equal(empty.properties.size, 0, mode)
  }
})

test('new empty items wait even before visible empty history or in a newly arriving source', () => {
  const h = harness()
  const history = h.item()
  h.sync(true)
  const arriving = h.item()
  h.replace([arriving, history])
  h.sync()
  assert.equal(owned(arriving), true)
  assert.equal(owned(history), false)
  const fresh = harness()
  const empty = fresh.item()
  fresh.sync()
  assert.equal(owned(empty), true)
})

test('body scans do not clear markers owned by a nested reasoning source', () => {
  const h = harness()
  const reasoning = h.item('reasoning')
  reasoning.closest = selector => selector === '[data-variant="think"]' ? {} : null
  reasoning.setAttribute('data-daf-stream-marker', '')
  reasoning.style.setProperty('--daf-marker-ink', 'rgb(90, 95, 100)')
  reasoning.style.setProperty('--daf-marker-alpha', '40%')
  h.sync()
  assert.equal(owned(reasoning), true)
  assert.equal(alpha(reasoning), '40%')
})

test('items containing excluded text are not treated as empty arriving items', () => {
  const h = harness()
  h.sync(true)
  const excluded = h.item('code block outside the text reveal')
  h.sync()
  assert.equal(owned(excluded), false)
})

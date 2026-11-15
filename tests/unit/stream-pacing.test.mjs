import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../src/stream-fade.js', import.meta.url), 'utf8')

// Evaluate the actual controller with a deterministic clock. No DOM, paint,
// transport, or generated bundle is involved in these scheduler regressions.
function controller() {
  let now = 1000
  const api = runInNewContext(source + '\n({ sfAppend, sfUpdate, sfDrive, SF_DURATION })', {
    performance: { now: () => now },
  })
  const state = {
    text: '', nodes: [], blockStarts: [], spans: [], kind: 'body', running: true,
    cursor: 0, arrived: 0, rate: 0, arrivalRate: 0, gapMs: 0,
    arrivals: [], lastArrival: 0, lastTick: 0, lastUnitBorn: 0,
  }
  return {
    state, duration: api.SF_DURATION,
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

// Minimal DOM doubles exercise snapshot -> update -> bind, including the DOM
// replaceData rule that a whole Text.data assignment collapses live endpoints.
function painter() {
  let now = 1000
  let nodes = []
  const ranges = new Set()
  const highlights = Array.from({ length: 16 }, () => new Set())
  const parent = {
    closest: () => null, tagName: 'P', className: '',
    style: { getPropertyValue: () => 'black' },
  }
  const api = runInNewContext(source + '\nsfHighlights = highlights; ({ sfSnapshot, sfUpdate, sfBind, sfDrive })', {
    highlights,
    performance: { now: () => now },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    window: { getComputedStyle: () => ({ color: 'black' }) },
    document: {
      createTreeWalker() {
        let index = 0
        return { nextNode: () => nodes[index++] ?? null }
      },
      createRange() {
        const range = {
          setStart(node, offset) { this.startContainer = node; this.startOffset = offset },
          setEnd(node, offset) { this.endContainer = node; this.endOffset = offset },
          get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset },
        }
        ranges.add(range)
        return range
      },
    },
  })
  const state = {
    text: '', nodes: [], blockStarts: [], spans: [], kind: 'body', running: true,
    cursor: 0, arrived: 0, rate: 0, arrivalRate: 0, gapMs: 0,
    arrivals: [], lastArrival: 0, lastTick: 0, lastUnitBorn: 0,
  }
  function replaceData(offset, count, text) {
    const node = nodes[0]
    count = Math.min(count, node.data.length - offset)
    for (const range of ranges) {
      for (const edge of ['start', 'end']) {
        if (range[edge + 'Container'] !== node) continue
        const at = range[edge + 'Offset']
        if (at > offset + count) range[edge + 'Offset'] += text.length - count
        else if (at > offset) range[edge + 'Offset'] = offset
      }
    }
    node.data = node.data.slice(0, offset) + text + node.data.slice(offset + count)
  }
  function bind() {
    api.sfUpdate(state, { kind: 'body', running: true }, api.sfSnapshot(state, state.nodes), true)
    api.sfBind(state)
  }
  function commit(text, replace = false) {
    if (replace || nodes.length === 0) {
      for (const node of nodes) node.isConnected = false
      nodes = [{ data: text, parentElement: parent, isConnected: true }]
    } else {
      // Text.data uses replaceData(0, oldLength, text), resetting all offsets.
      replaceData(0, nodes[0].data.length, text)
    }
    bind()
  }
  return {
    state, commit, replaceData, bind,
    tick(ms) { now += ms; api.sfDrive(state, now); api.sfBind(state) },
    levelAt(offset) {
      for (let level = 0; level < highlights.length; level++) {
        for (const range of highlights[level]) {
          if (range.startContainer === nodes[0] && range.startOffset <= offset && range.endOffset > offset) return level
        }
      }
      return 15 // no highlight means the normal, fully bright text colour
    },
  }
}

test('Text.data appends keep queued and fading text covered before a node replacement', () => {
  const c = painter()
  c.commit('abcdefghij')
  Object.assign(c.state, { rate: 0.01, arrivalRate: 0.01 })
  c.tick(16)
  c.tick(60)
  const before = Array.from({ length: 10 }, (_, i) => c.levelAt(i))
  assert.ok(before[0] > 0 && before[0] < 15)
  assert.equal(before[8], 0)
  c.commit('abcdefghijkl')
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => c.levelAt(i)), before,
    'same-node append must neither expose queued text nor reset a fading prefix')
  c.commit('abcdefghijkl', true)
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => c.levelAt(i)), before)
})

test('assigning identical Text.data rebuilds collapsed ranges without resetting opacity', () => {
  const c = painter()
  c.commit('abcdef')
  c.tick(16)
  c.tick(60)
  const before = Array.from({ length: 6 }, (_, i) => c.levelAt(i))
  c.commit('abcdef')
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => c.levelAt(i)), before)
})

test('partial same-value replaceData repairs noncollapsed ranges at the current opacity', () => {
  const c = painter()
  c.commit('abcdef')
  Object.assign(c.state, { rate: 0.01, arrivalRate: 0.01 })
  c.tick(16)
  c.tick(60)
  const before = Array.from({ length: 6 }, (_, i) => c.levelAt(i))
  c.replaceData(0, 3, 'abc')
  const shifted = c.state.spans[1].ranges[0]
  assert.equal(shifted.collapsed, false)
  assert.equal(shifted.startOffset, 0)
  assert.equal(shifted.endOffset, 4)
  c.bind()
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => c.levelAt(i)), before)
  assert.equal(c.state.spans[1].ranges[0].startOffset, 2)
})

test('sequential partial writes preserve retained opacity and range coverage', () => {
  const c = painter()
  c.commit('abcdef')
  c.tick(16)
  c.tick(60)
  const before = Array.from({ length: 6 }, (_, i) => c.levelAt(i))
  c.replaceData(1, 2, '')
  c.replaceData(1, 0, 'bc')
  c.bind()
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => c.levelAt(i)), before)
})

test('a same-node tail edit preserves the retained prefix and suffix opacity', () => {
  const c = painter()
  c.commit('abcdef')
  Object.assign(c.state, { rate: 1, arrivalRate: 1 })
  c.tick(16)
  c.tick(60)
  const before = Array.from({ length: 6 }, (_, i) => c.levelAt(i))
  c.commit('abcXYdef')
  assert.deepEqual([0, 1, 2, 5, 6, 7].map(i => c.levelAt(i)), before)
  assert.equal(c.levelAt(3), 0)
})

test('settled text stays fully bright across append and DOM replacement', () => {
  const c = painter()
  c.commit('abcdef')
  Object.assign(c.state, { rate: 1, arrivalRate: 1 })
  c.tick(16)
  c.tick(120)
  c.tick(16)
  assert.equal(c.state.spans.length, 0)
  c.commit('abcdefgh')
  assert.ok([0, 1, 2, 3, 4, 5].every(i => c.levelAt(i) === 15))
  assert.equal(c.levelAt(6), 0)
  c.commit('abcdefgh', true)
  assert.ok([0, 1, 2, 3, 4, 5].every(i => c.levelAt(i) === 15))
  assert.equal(c.levelAt(6), 0)
})

test('final link conversion plus appended tail never replays retained prose', () => {
  const c = painter()
  const prefix = '结构图已完成：'
  const label = 'π0.7 模型结构：多模态上下文 → 50 步动作块'
  const prose = '图里梳理了五条上下文通路。主干负责语义理解。方便对着代码算显存'
  c.commit(prefix + label + prose)
  Object.assign(c.state, { rate: 4, arrivalRate: 4 })
  for (let i = 0; i < 80; i++) c.tick(16)
  c.commit(prefix + prose + '。', true)
  assert.ok(Array.from({ length: prefix.length + prose.length }, (_, i) => c.levelAt(i)).every(v => v === 15),
    'completed text must stay fully visible when a file link leaves the glyph snapshot')
  assert.equal(c.levelAt(prefix.length + prose.length), 0, 'only the final new punctuation is queued')
})

test('interior retained text keeps partial and queued progress across Markdown edits', () => {
  const c = painter()
  c.commit('说明：**粗体文字还有等待的后文')
  Object.assign(c.state, { rate: 0.01, arrivalRate: 0.01 })
  for (let i = 0; i < 200 && !(c.levelAt(5) > 0 && c.levelAt(5) < 15); i++) c.tick(16)
  assert.ok(c.levelAt(5) > 0 && c.levelAt(5) < 15)
  assert.equal(c.levelAt(15), 0)
  const before = Array.from({ length: 11 }, (_, i) => c.levelAt(i + 5))
  c.commit('说明：粗体文字还有等待的后文。', true)
  assert.deepEqual(Array.from({ length: 11 }, (_, i) => c.levelAt(i + 3)), before)
  assert.equal(c.levelAt(c.state.text.length - 1), 0)
})

test('large final appends do not consume the retained-text alignment budget', () => {
  const c = painter(), prose = '已经显示的正文。'.repeat(200)
  c.commit('开头：[文件标签]' + prose)
  Object.assign(c.state, { rate: 4, arrivalRate: 4 })
  for (let i = 0; i < 300; i++) c.tick(16)
  c.commit('开头：' + prose + '新的尾部'.repeat(500), true)
  assert.ok(Array.from({ length: 3 + prose.length }, (_, i) => c.levelAt(i)).every(v => v === 15))
  assert.equal(c.levelAt(3 + prose.length), 0)
})

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
    c.tick(c.duration - 1)
    assert.equal(nextLine.born, Infinity)
    c.tick(1)
    assert.equal(nextLine.born, firstTick + c.duration)
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

test('settling preserves line order and a legitimate large append drains without flashing', () => {
  const c = controller()
  c.append('ab\ncd')
  Object.assign(c.state, { rate: 1, arrivalRate: 1, running: false })
  c.tick()
  assert.equal(c.state.spans.at(-1).born, Infinity)
  for (let i = 0; i < 100; i++) c.tick()
  assert.ok(c.state.spans.every(span => Number.isFinite(span.born)))
  const replacement = controller()
  replacement.append('queued')
  replacement.append('x'.repeat(513))
  assert.equal(replacement.state.cursor, 0)
  assert.ok(replacement.state.spans.length > 0)
  replacement.state.running = false
  for (let i = 0; i < 250; i++) replacement.tick()
  assert.ok(replacement.state.spans.every(span => Number.isFinite(span.born)))
})

function simulate(curve, end, interval = 80) {
  const c = controller()
  let fractional = 0
  let buffered = 0
  let delivered = 0
  const arrivals = []
  const lag = []
  let maxRateStep = 0
  let lastRate = 0
  let drainedAt = end
  for (let t = 16; t <= end + 5000; t += 16) {
    if (t <= end) {
      fractional += curve(t) * 0.016
      const chars = Math.floor(fractional)
      fractional -= chars
      buffered += chars
    }
    if ((t % interval === 0 || t > end) && buffered) {
      c.append('x'.repeat(buffered))
      for (let i = 0; i < buffered; i++) arrivals.push(1000 + t - 16)
      buffered = 0
    }
    if (t > end) c.state.running = false
    const now = c.tick()
    for (const span of c.state.spans) {
      if (span.born !== Infinity && !span.counted) {
        span.counted = true
        for (let i = span.start; i < span.end; i++) {
          lag.push(span.born + c.duration - arrivals[i])
          delivered++
        }
      }
    }
    if (lastRate > 0) maxRateStep = Math.max(maxRateStep, Math.abs(c.state.rate - lastRate) * 1000)
    lastRate = c.state.rate
    if (t > end && delivered === arrivals.length) { drainedAt = t + c.duration; break }
  }
  lag.sort((a, b) => a - b)
  return { visibleP95: lag[Math.floor(lag.length * 0.95)] - c.duration + 16, visibleMax: lag.at(-1) - c.duration + 16, p95: lag[Math.floor(lag.length * 0.95)], max: lag.at(-1), maxRateStep, drain: drainedAt - end, delivered, total: arrivals.length }
}

test('rendered-character speed steps keep bounded lag and smooth frame rates', t => {
  const result = simulate(ms => ms < 2400 ? 20 : ms < 4800 ? 120 : 30, 7200)
  t.diagnostic(JSON.stringify(result))
  assert.equal(result.delivered, result.total)
  assert.ok(result.visibleP95 <= 100)
  assert.ok(result.p95 <= 160)
  assert.ok(result.max < 240)
  assert.ok(result.maxRateStep < 30, 'no single-frame catch-up speed jump')
  assert.ok(result.drain < 240)
})

test('bursty feed and pause/resume retain finite smooth drainage', t => {
  const result = simulate(ms => ms > 2400 && ms < 4000 ? 0 : 70, 7200, 400)
  t.diagnostic(JSON.stringify(result))
  assert.equal(result.delivered, result.total)
  assert.ok(result.visibleP95 < 250)
  assert.ok(result.p95 < 320)
  assert.ok(result.max < 350)
  assert.ok(result.maxRateStep < 35)
  assert.ok(result.drain < 350)
})

// #region stream-fade
/* Paint only live assistant output. Logical offsets survive React text-node
   replacement; ranges are rebuilt after each commit without editing host DOM. */
const SF_SCOPE = '[data-conversation-region="chat"], [data-slot="conversation.chat.flow"]'
const SF_LIVE = '[data-streaming="true"], [data-variant="think"][data-state="running"]'
const SF_SEAT = '[data-chat-flow-key]'
// Inline code is ordinary phrasing here: its text fades with the sentence.
// Only block code is skipped — a whole listing should not be ranged per line.
const SF_SKIP = 'pre, script, style, svg, button, input, textarea, select, [data-terminal], [data-tool], [data-question-reply], [hidden], [aria-hidden="true"], @host(fragment.visuallyHidden.contains), [data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]'
const SF_KILL = 'daf.streamFade'
const SF_DURATION = 120
const SF_SUMMARY_MS = 100
const SF_MAX_STEP = 64
const SF_MAX_APPEND = 512
const SF_MAX_FIRST = 96

/* Adaptive reveal controller.
   The transport is bursty (measured: 25 ms between chunks in fast phases,
   a 600 ms phrase every ~700 ms in slow ones, and isolated 0.4–1.5 s
   stalls). Painting each batch on arrival reproduces that burstiness; a
   fixed delay only trades it for lag. This controller keeps a small
   character buffer and releases it at a rate that follows the arrival rate:
   - `state.gapMs` is the EWMA inter-arrival time, so the target buffer
     horizon adapts: a few tens of ms when chunks are 25 ms apart, up to
     one batch when they are 700 ms apart.
   - `state.rate` is a low-passed display rate (chars/ms). A proportional
     term on the normalized backlog error speeds it up after a burst and
     slows it before a stall; a hard floor always drains the backlog so the
     loop can never spin with hidden text.
   - Units of SF_UNIT chars are released from a character frontier, so the
     reveal stays strictly in reading order.
   Everything is O(units in flight) and runs on the existing animation
   frame; no timers, no per-character work, no style writes. */
const SF_UNIT = 2
const SF_RATE_MIN = 0.002          // 2 chars/s hard floor
const SF_RATE_MAX = 2              // 2000 chars/s ceiling
const SF_RATE_GAIN = 0.4           // P gain on normalized buffer error
const SF_RATE_CATCHUP = 1.6        // at most 1.6x the upstream rate
const SF_RATE_TAU = 90             // ms low-pass on the display rate
const SF_ARRIVAL_MS = 4000          // window for the upstream rate estimate
const SF_HORIZON_MIN = 60          // ms of text buffered at minimum
const SF_HORIZON_MAX = 700         // one slow batch at most
const SF_HORIZON_FILL = 0.5        // half a gap of buffer; the rest is drain margin
const SF_BACKLOG_MAX = 600         // chars of buffer
const SF_BACKLOG_JUMP = 3000       // background wake: reveal instead of typing
const SF_DRAIN_MS = 1200
const SF_BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd'           // slowest allowed drain of a full backlog
const SF_LEVELS = 16
let sfObserver = null
let sfRaf = 0
let sfPending = false
let sfLevelsReady = false
let sfHighlights = []
let sfRuleTexts = []
let sfMedia = null
let sfSelectFrame = 0
let sfLocation = ''
let sfScopes = new Map()
let sfDirty = new Set()
let sfActive = new Set()
let sfRows = new Map()
let sfRowAnimations = new Map()
let sfRowSeen = 0
let sfSeen = 0
let sfRemapped = 0
let sfGap = 0
let sfSpread = 0
let sfLastChunk = 0
let sfSelectionVersion = 0
let sfSelected = null
let sfColorCache = new Map()
let sfFactsCache = new WeakMap()
/* Elements carrying a --daf-ink inline property, reaped once the fade has
   settled: the property is only read by the ::highlight() rules, so a
   transcript that keeps hundreds of them after a turn is pure dead style. */
let sfInkEls = new Set()
let sfInkTimer = 0

function sfFacts(element) {
  let facts = sfFactsCache.get(element)
  if (facts === undefined) {
    facts = {
      skip: element.closest(SF_SKIP) !== null,
      think: element.closest('[data-variant="think"]') !== null,
      header: element.closest('[data-disclosure-header]') !== null,
    }
    sfFactsCache.set(element, facts)
  }
  return facts
}

function sfReadSelection() {
  const selection = window.getSelection()
  sfSelected = selection === null || selection.isCollapsed || selection.rangeCount === 0 ? null : selection
}
let sfEnabled = false

function sfSupported() {
  return window.CSS !== undefined && window.CSS.highlights !== undefined &&
    typeof window.Highlight === 'function' &&
    window.CSS.supports('color', 'color-mix(in srgb, black 50%, transparent)')
}

function sfAllowed() {
  if (!sfSupported() || document.hidden || rsDrag !== null) return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  try {
    return window.localStorage.getItem(SF_KILL) !== '0'
  } catch (error) {
    // Storage can be unavailable in embedded clients; motion still works.
    return true
  }
}

function sfScopeOf(element) {
  return element.closest(SF_SCOPE)
}

/* A message only owns streamed text while a body or reasoning row is live. */
function sfHasLive(seat) {
  return seat.querySelector('[data-streaming="true"]') !== null ||
    seat.querySelector('[data-variant="think"][data-state="running"]') !== null
}

function sfSources(seat) {
  const sources = []
  const roots = [...seat.querySelectorAll('[data-streaming="true"]')]
  let body = 0
  for (const root of roots) {
    if (root.closest(SF_SEAT) !== seat) continue
    if (root.closest('[data-variant="think"]') !== null) continue
    const ancestor = root.parentElement.closest('[data-streaming="true"]')
    if (ancestor !== null && seat.contains(ancestor)) continue
    sources.push({ key: 'body:' + body++, root, kind: 'body', running: true })
  }
  let index = 0
  for (const think of seat.querySelectorAll('[data-variant="think"][data-state="running"]')) {
    if (think.closest(SF_SEAT) !== seat) continue
    if (think.hasAttribute('data-expanded') && think.getAttribute('data-expanded') !== 'false') {
      sources.push({ key: 'think:' + index + ':body', root: think, kind: 'reasoning', running: true })
    } else {
      const summary = think.querySelector('[data-streaming="true"]')
      if (summary !== null) sources.push({ key: 'think:' + index + ':summary', root: summary, kind: 'summary', running: true })
    }
    index += 1
  }
  return sources
}

/* Node entries are reused across commits: a long message has thousands of
   text nodes and this runs on every streamed chunk. */
function sfSnapshot(source, previous) {
  const nodes = []
  const parts = []
  const blockStarts = []
  const blockCache = new Map()
  let lastBlock = null
  let length = 0
  let replaced = 0
  let replacedFrom
  const walker = document.createTreeWalker(source.root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      const facts = sfFacts(parent)
      if (facts.skip) return NodeFilter.FILTER_REJECT
      if (source.kind === 'body' && facts.think) return NodeFilter.FILTER_REJECT
      if (source.kind === 'reasoning' && facts.header) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let node
  while ((node = walker.nextNode()) !== null) {
    const data = node.data
    if (data.length === 0) continue
    // Rendered blocks are sibling elements with no newline text node
    // between them, so the paragraph break is the text node's block, not a
    // character in the stream. Inline wrappers (code, strong) resolve to
    // the same block and stay on the running line.
    const parentElement = node.parentElement
    let block = blockCache.get(parentElement)
    if (block === undefined) {
      block = parentElement.closest(SF_BLOCK) || parentElement
      blockCache.set(parentElement, block)
    }
    if (lastBlock !== null && block !== lastBlock) blockStarts.push(length)
    lastBlock = block
    const reused = previous === undefined ? undefined : previous[nodes.length]
    if (reused === undefined) {
      nodes.push({ node, start: length, end: length + data.length })
    } else {
      if (reused.node !== node) {
        replaced += 1
        if (replacedFrom === undefined) replacedFrom = length
      }
      reused.node = node
      reused.start = length
      reused.end = length + data.length
      nodes.push(reused)
    }
    parts.push(data)
    length += data.length
  }
  return { text: parts.join(''), nodes, blockStarts, replaced, replacedFrom }
}

function sfReadSeat(seat, baseline = false) {
  if (!seat.isConnected || seat.closest(SF_SKIP) !== null) return
  const scope = sfScopeOf(seat)
  if (scope === null) return
  sfProcessRows(seat, scope, baseline)
  const key = seat.getAttribute('data-chat-flow-key')
  let groups = sfScopes.get(scope)
  let group = groups === undefined ? undefined : groups.get(key)
  if (group === undefined) {
    // Settled history carries no streamed text; tracking it would only add
    // a full snapshot per seat on install and on every conversation switch.
    if (!sfHasLive(seat)) return
    if (groups === undefined) {
      groups = new Map()
      sfScopes.set(scope, groups)
    }
    group = { seat, sources: new Map() }
    groups.set(key, group)
  }
  group.seat = seat
  const sources = sfSources(seat)
  const found = new Set()
  for (const source of sources) {
    found.add(source.key)
    let state = group.sources.get(source.key)
    const snapshot = sfSnapshot(source, state === undefined ? undefined : state.nodes)
    if (state === undefined) {
      state = {
        ...source, ...snapshot, spans: [], paints: [],
        // Existing text is already on screen: start the frontier at its end
        // so hydrating a live message never replays what the reader has seen.
        cursor: snapshot.text.length, arrived: snapshot.text.length,
        rate: 0, arrivalRate: 0, gapMs: 0, arrivals: [], lastArrival: 0, lastTick: 0, lastUnitBorn: 0,
      }
      group.sources.set(source.key, state)
    } else {
      sfUpdate(state, source, snapshot, !baseline)
    }
    sfBind(state)
  }
  for (const [sourceKey, state] of group.sources) {
    if (found.has(sourceKey)) continue
    // A final Markdown commit may remove data-streaming but keep the root.
    // Preserve the last fade only, never animate newly revealed history.
    if (state.root.isConnected && seat.contains(state.root) && state.spans.length > 0 &&
        !(state.kind === 'summary' && state.root.closest('[data-expanded]') !== null)) {
      sfUpdate(state, { root: state.root, kind: state.kind, running: false }, sfSnapshot(state, state.nodes), false)
      sfBind(state)
    } else {
      sfDrop(state)
      group.sources.delete(sourceKey)
    }
  }
  if (group.sources.size === 0) groups.delete(key)
}

// Explicit disclosure gestures own height motion; streaming commits never do.
const SF_DISCLOSURE_MS = 200
let sfDisclosures = new Map()
let sfDisclosureBypass = new WeakSet()
let sfClosedHeights = new WeakMap()

function sfDisclosureTarget(event) {
  if (!(event.target instanceof Element) || event.defaultPrevented ||
      event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.type === 'keydown' && (event.repeat || (event.key !== 'Enter' && event.key !== ' '))) return null
  if (event.type === 'click' && event.button !== 0) return null
  const trigger = event.target.closest('[aria-expanded]')
  // Native buttons produce their own click for Enter/Space. Intercepting
  // keydown and replaying a synthetic key cannot reproduce that default.
  if (event.type === 'keydown' && trigger?.matches('button')) return null
  const control = event.target.closest('button, [role="button"], a, input, textarea, select')
  if (control !== null && control !== trigger) return null
  const header = trigger === null ? null : trigger.closest('[data-disclosure-header]')
  if (header === null || sfScopeOf(header) === null || header.closest(SF_SEAT) === null) return null
  if (event.target.closest('a, input, textarea, select') !== null) return null
  const disclosure = header.parentElement
  const box = header.closest('[data-variant][data-state]') || disclosure
  return { trigger, header, disclosure, box }
}

function sfDisclosureCancel(entry) {
  sfDisclosures.delete(entry.box)
  for (const animation of entry.animations) animation.cancel()
}

function sfDisclosureCommit(entry) {
  sfDisclosureBypass.add(entry.trigger)
  if (entry.eventType === 'keydown') {
    entry.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: entry.key, bubbles: true, cancelable: true }))
  } else {
    entry.trigger.click()
  }
  sfDisclosureBypass.delete(entry.trigger)
}

function sfDisclosureAnimate(entry, to) {
  const animation = entry.box.animate([
    { height: entry.from + 'px', overflow: 'clip', boxSizing: 'border-box', minHeight: 0 },
    { height: to + 'px', overflow: 'clip', boxSizing: 'border-box', minHeight: 0 },
  ], { duration: SF_DISCLOSURE_MS, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'both' })
  entry.animations.push(animation)
  for (const child of entry.disclosure.children) {
    if (child === entry.header) continue
    entry.animations.push(child.animate(entry.closing ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: .45 }, { opacity: 1 }], {
      duration: entry.closing ? 160 : 180, easing: 'ease-out', fill: 'both',
    }))
  }
  animation.onfinish = () => {
    if (sfDisclosures.get(entry.box) !== entry) return
    if (entry.closing && entry.trigger.isConnected && entry.trigger.getAttribute('aria-expanded') === 'true') {
      sfDisclosureCommit(entry)
    }
    sfDisclosureCancel(entry)
  }
}

function sfDisclosureOpen(entry) {
  if (sfDisclosures.get(entry.box) !== entry || entry.closing) return
  if (!entry.box.isConnected || entry.trigger.getAttribute('aria-expanded') !== 'true') return
  const to = entry.box.getBoundingClientRect().height
  if (to <= entry.from + 1) return
  sfDisclosureAnimate(entry, to)
  entry.started = true
}

function sfOnDisclosure(event) {
  if (!sfEnabled || !sfAllowed()) return
  const target = sfDisclosureTarget(event)
  if (target === null || sfDisclosureBypass.has(target.trigger) || typeof target.box.animate !== 'function') return
  const from = target.box.getBoundingClientRect().height
  const previous = sfDisclosures.get(target.box)
  if (previous !== undefined) {
    sfDisclosureCancel(previous)
    // A second gesture while closing cancels the close, leaving the host open.
    if (previous.closing) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const entry = { ...target, from, closing: false, animations: [], started: false, retries: 0 }
      sfDisclosures.set(target.box, entry)
      // A same-frame reversal may have no height delta. Settle also drops
      // that idle owner instead of retaining the card until another mutation.
      sfDisclosureSettle(entry)
      return
    }
  }
  const closing = target.trigger.getAttribute('aria-expanded') === 'true'
  const entry = { ...target, from, closing, animations: [], started: false, retries: 0, eventType: event.type, key: event.key }
  sfDisclosures.set(target.box, entry)
  if (closing) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const style = window.getComputedStyle(target.box)
    const estimated = target.header.getBoundingClientRect().bottom - target.box.getBoundingClientRect().top +
      (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0)
    const to = sfClosedHeights.get(target.box) ?? estimated
    sfDisclosureAnimate(entry, Math.max(0, to))
  } else {
    sfClosedHeights.set(target.box, from)
    entry.retries = 0
    // React commits either inside the handler or in its queued flush.
    queueMicrotask(() => queueMicrotask(() => sfDisclosureSettle(entry)))
  }
}

/* A deferred commit must not cost the open animation: retry on the frame
   boundary, which still runs before the expanded content is painted. */
function sfDisclosureSettle(entry) {
  if (sfDisclosures.get(entry.box) !== entry || entry.started || entry.closing) return
  if (!entry.box.isConnected) {
    sfDisclosureCancel(entry)
    return
  }
  if (entry.trigger.getAttribute('aria-expanded') !== 'true') {
    if (entry.retries < 3) {
      entry.retries += 1
      window.requestAnimationFrame(() => sfDisclosureSettle(entry))
    } else {
      sfDisclosures.delete(entry.box)
    }
    return
  }
  sfDisclosureOpen(entry)
  if (!entry.started) sfDisclosures.delete(entry.box)
}

function sfDisclosureFlush() {
  for (const entry of sfDisclosures.values()) {
    if (!entry.closing && !entry.started) sfDisclosureSettle(entry)
  }
}

function sfDisclosureStop() {
  for (const entry of sfDisclosures.values()) {
    // Finish the user's pending close before removing our animation owner.
    if (entry.closing && entry.trigger.isConnected && entry.trigger.getAttribute('aria-expanded') === 'true') {
      sfDisclosureCommit(entry)
    }
    sfDisclosureCancel(entry)
  }
  sfClosedHeights = new WeakMap()
}

function sfProcessRows(seat, scope, baseline) {
  let groups = sfRows.get(scope)
  if (groups === undefined) {
    groups = new Map()
    sfRows.set(scope, groups)
  }
  const key = seat.getAttribute('data-chat-flow-key')
  let group = groups.get(key)
  if (group === undefined) {
    group = { seat, seen: new Set() }
    groups.set(key, group)
  }
  group.seat = seat
  let index = 0
  for (const row of seat.querySelectorAll('[data-variant][data-state]')) {
    if (row.closest(SF_SEAT) !== seat) continue
    const parentRow = row.parentElement.closest('[data-variant][data-state]')
    if (parentRow !== null && seat.contains(parentRow)) continue
    const signature = row.getAttribute('data-variant') + ':' + (row.getAttribute('data-tool') || '') + ':' + index++
    if (group.seen.has(signature)) continue
    group.seen.add(signature)
    if (baseline) continue
    const target = row.querySelector('[data-disclosure-header]') || row
    if (typeof target.animate !== 'function') continue
    // Claude inserts a process row at a fixed height with a short rise, never
    // a height animation: opacity plus 4px, so a burst of rows does not slide.
    const animation = target.animate([
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 180, easing: 'cubic-bezier(.2, 0, 0, 1)' })
    sfRowSeen += 1
    sfRowAnimations.set(target, animation)
    animation.onfinish = animation.oncancel = () => {
      if (sfRowAnimations.get(target) === animation) sfRowAnimations.delete(target)
    }
  }
}

/* Estimate both the arrival rate and the expected gap for one source. The
   EWMA is deliberately slow: a single burst must not make the controller
   believe the whole turn runs at that rate. */
function sfAppend(state, start, end) {
  const now = performance.now()
  const length = Math.max(0, end - start)
  if (sfLastChunk !== 0) {
    const gap = now - sfLastChunk
    if (gap > 16 && gap < 1500) sfGap = sfGap === 0 ? gap : sfGap * 0.7 + gap * 0.3
  }
  sfLastChunk = now
  sfSpread = 0
  if (state.lastArrival !== 0) {
    const dt = Math.min(2000, Math.max(8, now - state.lastArrival))
    state.gapMs = state.gapMs === 0 ? dt : state.gapMs * 0.7 + dt * 0.3
  } else {
    // First batch: no interval yet. A large phrase is the slow transport's
    // signature (whole phrases every ~700 ms); a small one behaves like the
    // fast transport. Assuming 30 ms for everything made a 70-char opening
    // batch look like a 2,300 chars/s burst and drain instantly.
    state.gapMs = length > 16 ? 700 : 140
    state.arrivalRate = Math.max(0.01, length / state.gapMs)
  }
  state.lastArrival = now
  if (state.arrivalRate === 0) state.arrivalRate = Math.max(0.01, length / 140)
  state.arrivals.push({ t: now, n: length })
  while (state.arrivals.length > 1 && now - state.arrivals[0].t > SF_ARRIVAL_MS) state.arrivals.shift()
  if (state.arrivals.length >= 2) {
    let windowChars = 0
    for (const arrival of state.arrivals) windowChars += arrival.n
    const windowSpan = Math.max(200, now - state.arrivals[0].t)
    // Average over a window, not per-chunk: a burst after a stall must not
    // teach the controller that the whole turn runs at burst speed.
    const windowed = windowChars / windowSpan
    state.arrivalRate = state.arrivalRate === 0 ? windowed : state.arrivalRate * 0.5 + windowed * 0.5
  }
  if (length === 0) return
  // Keep UTF-16 surrogate pairs together at a changed suffix boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(state.text[start]) && /[\uD800-\uDBFF]/.test(state.text[start - 1])) start -= 1
  if (end - start > SF_MAX_APPEND) {
    // A wholesale replacement is not a streamed phrase; show it at once.
    // The frontier also skips older queued units. Remove their highlights
    // or they remain invisible forever once backlog reaches zero.
    state.spans = state.spans.filter(span => {
      if (span.born !== Infinity || span.start >= end) return true
      sfFreeSpan(span)
      return false
    })
    state.cursor = Math.max(state.cursor, end)
    state.arrived = Math.max(state.arrived, end)
    return
  }
  state.arrived = Math.max(state.arrived, end)
  // Queue fixed-size units behind the frontier; sfDrive releases them in
  // reading order. A unit never crosses a line ending, and the first unit
  // after one is marked so one release group cannot span two lines: the
  // previous line is fully bright before the next line starts.
  const from = Math.max(start, state.cursor)
  const text = state.text
  const blocks = state.blockStarts === undefined ? [] : state.blockStarts
  let blockIndex = 0
  while (blockIndex < blocks.length && blocks[blockIndex] < from) blockIndex += 1
  let boundary = from > 0 && (text.charCodeAt(from - 1) === 10 || blocks[blockIndex] === from)
  if (blockIndex < blocks.length && blocks[blockIndex] === from) blockIndex += 1
  for (let at = from; at < end;) {
    let unitEnd = Math.min(end, at + SF_UNIT)
    // A newline or a new rendered block belongs to this unit; the next
    // unit starts fresh, so the release can stop between them.
    const newline = text.indexOf('\n', at)
    if (newline !== -1 && newline + 1 < unitEnd) unitEnd = newline + 1
    while (blockIndex < blocks.length && blocks[blockIndex] <= at) blockIndex += 1
    let crossedBlock = false
    if (blockIndex < blocks.length && blocks[blockIndex] <= unitEnd) {
      unitEnd = blocks[blockIndex]
      crossedBlock = true
    }
    if (unitEnd <= at) unitEnd = at + 1
    const unitText = text.slice(at, unitEnd)
    state.spans.push({
      start: at, end: unitEnd, born: Infinity,
      paraStart: boundary, ranges: [], level: -1, summary: state.kind === 'summary', value: 0,
    })
    boundary = crossedBlock || unitText.includes('\n')
    at = unitEnd
  }
  sfSeen += 1
  sfActive.add(state)
}

/* The adaptive reveal controller: advance the character frontier toward the
   arrival estimate, then release every unit the frontier has passed. */
function sfHorizon(state) {
  const gap = state.gapMs === 0 ? 140 : state.gapMs
  // The collapsed reasoning summary is one live line that is replaced as a
  // unit; buffering it for a slow batch's gap would leave it always behind.
  const ceiling = state.kind === 'summary' ? 240 : SF_HORIZON_MAX
  return Math.min(ceiling, Math.max(SF_HORIZON_MIN, gap))
}

function sfDrive(state, now) {
  const dt = state.lastTick === 0 ? 16 : Math.min(120, Math.max(4, now - state.lastTick))
  state.lastTick = now
  let backlog = state.arrived - state.cursor
  if (backlog <= 0) {
    state.cursor = state.arrived
    if (state.spans.length === 0 && state.arrivalRate > 0) state.rate = state.arrivalRate
    return
  }
  const rateArrival = state.arrivalRate > 0 ? state.arrivalRate : 0.03
  if (state.rate === 0) state.rate = rateArrival
  if (backlog > SF_BACKLOG_JUMP) {
    // A background wake can leave thousands of seconds of typing queued;
    // reveal everything except one buffer instead of replaying it.
    const target = Math.min(SF_BACKLOG_MAX, Math.round(rateArrival * sfHorizon(state)))
    const keepFrom = Math.max(0, state.arrived - target)
    const kept = []
    for (const span of state.spans) {
      if (span.born === Infinity && span.start < keepFrom) {
        sfFreeSpan(span)
        continue
      }
      kept.push(span)
    }
    state.spans = kept
    state.cursor = Math.max(state.cursor, keepFrom)
    backlog = state.arrived - state.cursor
  }
  const targetChars = Math.min(SF_BACKLOG_MAX,
    Math.max(SF_UNIT, rateArrival * sfHorizon(state) * SF_HORIZON_FILL))
  // Catch up above the target, never slow below the arrival rate: a finite
  // batch must still finish inside its own gap, and running dry is fine.
  const error = Math.max(0, backlog - targetChars)
  let desired = rateArrival * (1 + SF_RATE_GAIN * error / targetChars)
  // Catch-up is bounded too: a stall burst is spread forward, not dumped.
  desired = Math.min(desired, rateArrival * SF_RATE_CATCHUP)
  // Bridge the end of a slow gap: when the transport hands over a phrase
  // every few hundred ms, spend the last chars over the expected remainder
  // instead of consuming them early and staring at an empty buffer.
  if (state.gapMs > 200 && state.kind !== 'summary') {
    desired = Math.min(desired, Math.max(SF_RATE_MIN, backlog / (state.gapMs * 0.7)))
  }
  // Bounded drain: the loop always terminates even after a stall.
  desired = Math.max(desired, backlog / SF_DRAIN_MS)
  // A settled turn reveals the buffer promptly instead of typing it out.
  if (!state.running) desired = Math.max(desired, backlog / 80)
  desired = Math.min(SF_RATE_MAX, Math.max(SF_RATE_MIN, desired))
  const alpha = 1 - Math.exp(-dt / SF_RATE_TAU)
  state.rate += (desired - state.rate) * alpha
  if (state.rate < SF_RATE_MIN) state.rate = SF_RATE_MIN
  state.cursor = Math.min(state.arrived, state.cursor + state.rate * dt)
  // Continuous release, with one ordering rule: a new line waits until the
  // previous line's last unit has finished fading. The frontier stops at
  // the boundary for at most one fade, so no earlier line is still dim
  // when the next line starts; the rate controller makes the time up on
  // the following line.
  const settling = !state.running
  let first = state.spans.length
  while (first > 0 && state.spans[first - 1].born === Infinity) first -= 1
  for (let index = first; index < state.spans.length; index += 1) {
    const span = state.spans[index]
    if (span.start >= state.cursor) break
    // The check sits on the boundary span itself, so a cursor jump that
    // crosses a whole line in one tick still cannot reveal the next line
    // before the previous one has finished fading.
    if (!settling && span.paraStart === true && state.lastUnitBorn !== 0 &&
        now < state.lastUnitBorn + SF_DURATION) {
      state.cursor = span.start
      break
    }
    span.born = now
    state.lastUnitBorn = now
  }
}

function sfUpdate(state, source, snapshot, animate) {
  const oldText = state.text
  const newText = snapshot.text
  let prefix = 0
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1
  let suffix = 0
  if (oldText !== newText) {
    while (suffix < oldText.length - prefix && suffix < newText.length - prefix &&
           oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix += 1
    const retained = []
    for (const span of state.spans) {
      // Text before the edit point keeps its ranges and its progress.
      if (span.end <= prefix) {
        retained.push(span)
        continue
      }
      sfFreeSpan(span)
      if (span.start < prefix) {
        retained.push({ start: span.start, end: prefix, born: span.born, ranges: [], level: -1, summary: span.summary, value: span.value, paraStart: span.paraStart })
      }
      const start = Math.max(span.start, oldText.length - suffix)
      if (start < span.end) {
        const shift = newText.length - oldText.length
        retained.push({ start: start + shift, end: span.end + shift, born: span.born, ranges: [], level: -1, summary: span.summary, value: span.value, paraStart: span.paraStart })
      }
    }
    state.spans = retained
    // Anything the edit rewrote at or before the frontier must be revealed
    // again from the edit point: the text there is no longer the text that
    // was revealed. A purely appended tail leaves the frontier alone.
    if (state.cursor > prefix) state.cursor = Math.min(prefix, newText.length)
    state.arrived = newText.length
  }
  const replacedFrom = snapshot.replacedFrom
  if (replacedFrom !== undefined) {
    sfRemapped += 1
    state.dirtyFrom = state.dirtyFrom === undefined ? replacedFrom : Math.min(state.dirtyFrom, replacedFrom)
  }
  Object.assign(state, source, snapshot)
  if (animate && newText !== oldText) {
    const append = prefix === oldText.length
    const tailRewrite = prefix > 0 && oldText.length - prefix <= 32 && newText.length > oldText.length
    const summaryChange = state.kind === 'summary' && newText.length <= SF_MAX_FIRST
    if (append || tailRewrite || summaryChange) sfAppend(state, prefix, newText.length - suffix)
  }
  if (state.spans.length > 0) sfActive.add(state)
}

/* Remember how far a batch got: the host replaces these nodes constantly and
   a repaint that restarted at 0 made the tail dim and re-brighten. */
function sfFreeSpan(span) {
  if (span.level >= 0) {
    const from = sfLevelHighlight(span.summary, span.level)
    for (const range of span.ranges) from.delete(range)
  }
  span.ranges.length = 0
}

function sfRelease(state) {
  for (const span of state.spans) sfFreeSpan(span)
}

function sfDurationOf(state) {
  return state.kind === 'summary' ? SF_SUMMARY_MS : SF_DURATION
}

function sfDrop(state) {
  sfRelease(state)
  state.spans = []
  state.cursor = 0
  state.arrived = 0
  // Release detached text nodes immediately; the group may outlive them.
  state.nodes = []
  state.text = ''
  sfActive.delete(state)
}

/* One rule set per opacity level, in the plugin's static stylesheet; the ink
   is the highlighted element's own colour carried by --daf-ink. Nothing is
   added to, or rewritten in, a stylesheet while a stream runs. */
function sfLevelHighlight(summary, level) {
  /* The summary fade walks the top half of the same ladder: its 55-100%
     range starts at step 8, so both painters share one rule set. */
  return sfHighlights[summary ? SF_LEVELS / 2 + (level >> 1) : level]
}

/* The 16 ::highlight() rules cost ~2.7 ms each in every whole-document
   recalculation, and a menu open re-checks the document several times.
   Idle UI paints no fades, so the rules live only while text is live. */
function sfSetRules(on) {
  const tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
  if (tag === null || tag.sheet === null) return
  const sheet = tag.sheet
  let present = 0
  for (let index = 0; index < sheet.cssRules.length; index++) {
    if ((sheet.cssRules[index].cssText || '').indexOf('::highlight(') !== -1) present++
  }
  if (!on) {
    if (present === 0) return
    sfRuleTexts = []
    for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
      const rule = sheet.cssRules[index]
      if ((rule.cssText || '').indexOf('::highlight(') !== -1) {
        sfRuleTexts.unshift(rule.cssText)
        sheet.deleteRule(index)
      }
    }
    return
  }
  if (present > 0 || sfRuleTexts.length === 0) return
  for (const text of sfRuleTexts) {
    try { sheet.insertRule(text, sheet.cssRules.length) } catch (error) {}
  }
}

function sfPrepareLevels() {
  if (sfLevelsReady || !sfSupported()) return
  sfLevelsReady = true
  for (let level = 0; level < SF_LEVELS; level += 1) {
    const normal = new window.Highlight()
    // Leave search/selection highlights above the animation wherever possible.
    normal.priority = -1
    window.CSS.highlights.set('daf-fade-' + level, normal)
    sfHighlights.push(normal)
  }
}

function sfDisposeLevels() {
  if (!sfLevelsReady) return
  sfLevelsReady = false
  for (let level = 0; level < SF_LEVELS; level += 1) {
    window.CSS.highlights.delete('daf-fade-' + level)
  }
  sfHighlights = []
}

/* ::highlight() paints over a selection wherever priority is unsupported, which
   turns selected text grey. Never fade text the reader has selected.

   The check is cached: window.getSelection() resolves against layout, so
   calling it per chunk forced a full style and layout flush. */
function sfSelection() {
  return sfSelected
}

/* Re-paint existing ranges only: selecting must never re-walk the transcript. */
function sfOnSelection() {
  sfReadSelection()
  if (!sfEnabled || sfActive.size === 0 || sfSelectFrame !== 0) return
  sfSelectFrame = window.requestAnimationFrame(() => {
    sfSelectFrame = 0
    sfSelectionVersion += 1
    for (const state of sfActive) if (state.root.isConnected) sfBind(state)
  })
}

/* One Range per text segment, built once; afterwards only its level moves. A
   long answer keeps ~25 batches in flight, and re-ranging them per chunk cost
   a whole frame, so the level switch is a delete/add on two fixed Highlights. */
function sfBind(state) {
  const now = performance.now()
  const duration = sfDurationOf(state)
  let kept = 0
  for (const span of state.spans) {
    if (sfSpanDone(span, now)) {
      sfFreeSpan(span)
      continue
    }
    state.spans[kept] = span
    kept += 1
  }
  state.spans.length = kept
  if (state.spans.length === 0) {
    sfActive.delete(state)
    return
  }
  if (state.dirtyFrom !== undefined || state.selectionVersion !== sfSelectionVersion) {
    const from = state.dirtyFrom
    state.dirtyFrom = undefined
    state.selectionVersion = sfSelectionVersion
    for (const span of state.spans) {
      if (from === undefined || span.end > from) sfFreeSpan(span)
    }
  }
  const selection = sfSelection()
  for (const span of state.spans) {
    if (span.ranges.length === 0) sfPaintSpan(state, span, selection, now, duration)
    else sfAdvanceSpan(span, Math.min(1, Math.max(0, (now - span.born) / duration)))
  }
  sfActive.add(state)
}

function sfLevelOf(target) {
  return Math.round(target * (SF_LEVELS - 1))
}

function sfPaintSpan(state, span, selection, now, duration) {
  const nodes = state.nodes
  // Only nodes overlapping this batch are ranged: binary search the start.
  let low = 0
  let high = nodes.length - 1
  let index = nodes.length
  while (low <= high) {
    const mid = (low + high) >> 1
    if (nodes[mid].end > span.start) {
      index = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }
  const target = Math.min(1, Math.max(0, (now - span.born) / duration))
  const level = sfLevelOf(target)
  const highlight = sfLevelHighlight(span.summary, level)
  for (; index < nodes.length; index += 1) {
    const entry = nodes[index]
    if (entry.start >= span.end) break
    const start = Math.max(span.start, entry.start)
    const end = Math.min(span.end, entry.end)
    if (start >= end || !entry.node.isConnected) continue
    if (selection !== null && selection.containsNode(entry.node, true)) continue
    const parent = entry.node.parentElement
    if (parent !== null) {
      const color = sfColorOf(parent)
      if (parent.style.getPropertyValue('--daf-ink') !== color) {
        parent.style.setProperty('--daf-ink', color)
        sfInkEls.add(parent)
      }
    }
    const range = document.createRange()
    range.setStart(entry.node, start - entry.start)
    range.setEnd(entry.node, end - entry.start)
    span.ranges.push(range)
    highlight.add(range)
  }
  span.level = level
  if (target > span.value) span.value = target
}

/* Straight from the measured recipe: opacity 0 -> 1, linear. A repaint resumes
   from where the batch was instead of starting over. The only per-frame work
   is a level switch, which touches paint, never style. */
function sfAdvanceSpan(span, target) {
  const level = sfLevelOf(target)
  if (span.level !== level) {
    const from = sfLevelHighlight(span.summary, span.level)
    const to = sfLevelHighlight(span.summary, level)
    for (const range of span.ranges) {
      from.delete(range)
      to.add(range)
    }
    span.level = level
  }
  if (target > span.value) span.value = target
}

function sfSpanDone(span, now) {
  if (span.ranges.length === 0) return now - span.born >= SF_DURATION * 2
  if (now < span.born) return false
  return span.value >= 1
}

/* Resolved by tag + class + reasoning context, never by element identity: the
   host rebuilds these nodes on every chunk, so an identity cache missed every
   time and each miss forced a document-wide style recalculation. */
function sfColorOf(element) {
  const facts = sfFacts(element)
  const className = typeof element.className === 'string' ? element.className : ''
  const key = (facts.think ? 'think|' : '') + element.tagName + '|' + className
  let color = sfColorCache.get(key)
  if (color === undefined) {
    color = window.getComputedStyle(element).color
    sfColorCache.set(key, color)
  }
  return color
}

function sfSchedule() {
  if (sfEnabled && sfRaf === 0) sfRaf = window.requestAnimationFrame(sfTick)
}

function sfFlush() {
  sfPending = false
  if (!sfEnabled) return
  if (!sfAllowed()) {
    sfRefresh()
    return
  }
  if (sfLocation !== window.location.href) {
    sfReset()
    sfLocation = window.location.href
    sfSeed()
    return
  }
  if (document.querySelector(SF_LIVE) !== null) sfSetRules(true)
  for (const seat of sfDirty) sfReadSeat(seat)
  sfDirty.clear()
  sfSchedule()
}

function sfMark(element) {
  if (!(element instanceof Element)) return
  const seat = element.closest(SF_SEAT)
  if (seat !== null && sfScopeOf(seat) !== null) sfDirty.add(seat)
  // Restrict discovery to inserted/replaced subtrees, not the transcript.
  for (const child of element.querySelectorAll(SF_SEAT)) {
    if (sfScopeOf(child) !== null) sfDirty.add(child)
  }
}

function sfOnMutations(records) {
  sfDisclosureFlush()
  // A bulk re-render emits thousands of records. Analysing each one costs
  // more than re-reading the handful of seats that can actually stream, and
  // walking the whole transcript here made the cost grow with chat length.
  if (records.length > 64) {
    for (const scope of document.querySelectorAll(SF_SCOPE)) {
      if (!sfScopes.has(scope)) sfSeed(scope)
    }
    for (const groups of sfScopes.values()) {
      for (const group of groups.values()) if (group.seat.isConnected) sfDirty.add(group.seat)
    }
    if (sfDirty.size > 0 && !sfPending) {
      sfPending = true
      queueMicrotask(sfFlush)
    }
    return
  }
  for (const record of records) {
    const element = record.target.nodeType === 1 ? record.target : record.target.parentElement
    if (element !== null) {
      // sfReadSeat resolves the scope itself; one closest per record is enough.
      const seat = element.closest(SF_SEAT)
      if (seat !== null) sfDirty.add(seat)
    }
    if (record.type === 'attributes' && element !== null && element.closest(SF_SEAT) === null) {
      sfColorCache.clear()
      for (const state of sfActive) {
        const seat = state.root.closest(SF_SEAT)
        if (seat !== null) sfDirty.add(seat)
      }
    }
    for (const added of record.addedNodes) {
      if (added.nodeType === 1) {
        // New chat views are history hydration, including an already-running tail.
        if (added.matches(SF_SCOPE) || added.querySelector(SF_SCOPE) !== null) sfSeed(added)
        else sfMark(added)
      }
    }
  }
  // MutationObserver runs before paint, even for commits inside another RAF.
  // Waiting for our next RAF would expose one frame of solid, unfaded text.
  if (sfDirty.size > 0 && !sfPending) {
    sfPending = true
    queueMicrotask(sfFlush)
  }
  if (sfScopes.size > 0 || sfRows.size > 0 || sfRowAnimations.size > 0) sfSchedule()
  hfOnMutations(records)
  hfSchedule()
}

function sfSeed(root = document) {
  for (const seat of root instanceof Element && root.matches(SF_SEAT) ? [root] : root.querySelectorAll(SF_SEAT)) {
    if (sfHasLive(seat)) sfReadSeat(seat, true)
  }
}

function sfTick() {
  sfRaf = 0
  if (!sfAllowed()) {
    sfRefresh()
    return
  }
  if (sfLocation !== window.location.href) {
    sfReset()
    sfLocation = window.location.href
    sfSeed()
    return
  }
  for (const seat of sfDirty) sfReadSeat(seat)
  sfDirty.clear()
  for (const [scope, groups] of sfScopes) {
    for (const [key, group] of groups) {
      if (scope.isConnected && group.seat.isConnected && scope.contains(group.seat)) continue
      for (const state of group.sources.values()) sfDrop(state)
      groups.delete(key)
    }
    if (!scope.isConnected || groups.size === 0) sfScopes.delete(scope)
  }
  const now = performance.now()
  for (const state of sfActive) {
    if (!state.root.isConnected) {
      state.stale = true
      sfDrop(state)
      continue
    }
    sfDrive(state, now)
    const duration = sfDurationOf(state)
    let kept = 0
    for (const span of state.spans) {
      if (sfSpanDone(span, now)) {
        sfFreeSpan(span)
        continue
      }
      state.spans[kept] = span
      kept += 1
      const target = Math.min(1, Math.max(0, (now - span.born) / duration))
      sfAdvanceSpan(span, target)
    }
    state.spans.length = kept
    if (state.spans.length === 0) sfActive.delete(state)
  }
  for (const [scope, groups] of sfScopes) {
    for (const [key, group] of groups) {
      for (const [sourceKey, state] of group.sources) {
        if (state.stale === true ||
            (!state.running && state.spans.length === 0 && state.arrived <= state.cursor)) group.sources.delete(sourceKey)
      }
      if (group.sources.size === 0) groups.delete(key)
    }
    if (groups.size === 0) sfScopes.delete(scope)
  }
  for (const [scope, groups] of sfRows) {
    for (const [key, group] of groups) {
      if (!scope.isConnected || !group.seat.isConnected) groups.delete(key)
    }
    if (groups.size === 0) sfRows.delete(scope)
  }
  for (const [target, animation] of sfRowAnimations) {
    if (!target.isConnected) {
      animation.cancel()
      sfRowAnimations.delete(target)
    }
  }
  if (sfActive.size > 0) sfSchedule()
  else if (sfInkEls.size > 0 && sfInkTimer === 0) sfInkTimer = window.setTimeout(sfReapInk, 1500)
}

function sfReapInk() {
  sfInkTimer = 0
  if (sfActive.size > 0) return
  for (const element of sfInkEls) element.style.removeProperty('--daf-ink')
  sfInkEls.clear()
}

function sfReset() {
  if (sfInkTimer !== 0) {
    window.clearTimeout(sfInkTimer)
    sfInkTimer = 0
  }
  for (const element of sfInkEls) element.style.removeProperty('--daf-ink')
  sfInkEls.clear()
  if (sfRaf !== 0) window.cancelAnimationFrame(sfRaf)
  sfRaf = 0
  if (sfSelectFrame !== 0) window.cancelAnimationFrame(sfSelectFrame)
  sfSelectFrame = 0
  sfPending = false
  sfDisclosureStop()
  sfColorCache.clear()
  sfFactsCache = new WeakMap()
  sfGap = 0
  sfSpread = 0
  sfLastChunk = 0
  for (const state of sfActive) sfDrop(state)
  sfDisposeLevels()
  for (const animation of sfRowAnimations.values()) animation.cancel()
  sfRowAnimations.clear()
  sfRows.clear()
  sfScopes.clear()
  sfDirty.clear()
}

function sfRefresh() {
  const enabled = sfAllowed()
  if (sfEnabled === enabled) return
  sfEnabled = enabled
  sfObserver.disconnect()
  sfReset()
  if (!enabled) return
  sfLocation = window.location.href
  sfSeed()
  /* sfReset() releases the level highlights; turning the effect back on
     (settings toggle, reduced-motion change) has to re-register them or the
     next batch paints into an undefined Highlight. */
  sfPrepareLevels()
  sfObserver.observe(document.body, {
    childList: true, subtree: true, characterData: true, attributes: true,
    // Class churn is constant during streaming; only theme and state attributes re-colour a fade.
    attributeFilter: ['data-streaming', 'data-state', 'data-expanded', 'data-open', 'aria-expanded', 'data-ds-dark-theme'],
  })
}

function sfOnStorage(event) {
  if (event.key === SF_KILL || event.key === null) sfRefresh()
}

function sfInstall() {
  if (sfObserver !== null || !sfSupported()) return
  sfObserver = new MutationObserver(sfOnMutations)
  sfMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
  sfMedia.addEventListener('change', sfRefresh)
  window.addEventListener('storage', sfOnStorage)
  document.addEventListener('visibilitychange', sfRefresh)
  document.addEventListener('click', sfOnDisclosure, true)
  document.addEventListener('keydown', sfOnDisclosure, true)
  document.addEventListener('selectionchange', sfOnSelection)
  sfReadSelection()
  sfRefresh()
  sfPrepareLevels()
}

function sfStop() {
  if (sfObserver !== null) sfObserver.disconnect()
  sfObserver = null
  if (sfMedia !== null) sfMedia.removeEventListener('change', sfRefresh)
  sfMedia = null
  window.removeEventListener('storage', sfOnStorage)
  document.removeEventListener('visibilitychange', sfRefresh)
  document.removeEventListener('click', sfOnDisclosure, true)
  document.removeEventListener('keydown', sfOnDisclosure, true)
  document.removeEventListener('selectionchange', sfOnSelection)
  sfSelected = null
  sfEnabled = false
  sfReset()
  hfDispose()
}

function sfSetEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('stream fade enabled must be boolean')
  window.localStorage.setItem(SF_KILL, enabled ? '1' : '0')
  if (sfObserver !== null) sfRefresh()
  return sfStatus()
}

function sfStatus() {
  let buffer = 0
  let rate = 0
  let arrival = 0
  for (const state of sfActive) {
    buffer = Math.max(buffer, state.arrived - state.cursor)
    rate = Math.max(rate, state.rate)
    arrival = Math.max(arrival, state.arrivalRate)
  }
  return { version: PLUGIN_VERSION, supported: sfSupported(), allowed: sfAllowed(), enabled: sfEnabled,
    seen: sfSeen, remapped: sfRemapped, active: sfActive.size, rules: sfHighlights.length, duration: SF_DURATION,
    cadence: Math.round(sfGap),
    spread: Math.round(sfSpread),
    buffer,
    rate: Math.round(rate * 1000),
    arrival: Math.round(arrival * 1000),
    horizon: sfActive.size === 0 ? 0 : Math.round(sfHorizon(sfActive.values().next().value)),
    rowsSeen: sfRowSeen, rowsActive: sfRowAnimations.size, disclosuresActive: sfDisclosures.size,
    resizing: rsDrag !== null, frozenHistory: rsFrozen.length }
}
// #endregion stream-fade

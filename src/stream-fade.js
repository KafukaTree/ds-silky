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
const SF_DURATION = 64
const SF_SUMMARY_MS = 64

/* Rendered-character arrivals are a transport proxy, not raw token timing.
   One estimator per conversation survives thinking/body handoffs. A short
   feed-forward window follows speed steps; buffered feedback bounds lag.
   History is identified by hydration, never by the size of a live append. */
const SF_UNIT = 2
const SF_RATE_MIN = 0.008
const SF_RATE_MAX = 4
const SF_RATE_TAU = 70
const SF_ARRIVAL_MS = 360
const SF_DRAIN_MS = 650
const SF_BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd'           // slowest allowed drain of a full backlog
const SF_LEVELS = 16
let sfObserver = null
let sfRaf = 0
let sfPending = false
let sfLevelsReady = false
let sfHighlights = []
// Live DOM Ranges can move without their Text node being replaced.
const sfRangeBounds = new WeakMap()
let sfRuleTexts = []
let sfMedia = null
let sfSelectFrame = 0
let sfLocation = ''
let sfScopes = new Map()
// Bounded identities/fingerprints, never DOM or response text. Late session
// hydration can mount into an already-seeded empty chat scope.
const sfKnownBodies = new Map()
let sfViews = new Map()
let sfClocks = new Map()
let sfDirty = new Set()
let sfActive = new Set()
let sfRows = new Map()
let sfRowAnimations = new Map()
let sfPendingRows = new Set()
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

function sfSources(seat, previous) {
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
  for (const think of seat.querySelectorAll('[data-variant="think"][data-state]')) {
    if (think.closest(SF_SEAT) !== seat) continue
    const running = think.getAttribute('data-state') === 'running'
    if (think.hasAttribute('data-expanded') && think.getAttribute('data-expanded') !== 'false') {
      const key = 'think:' + index + ':body'
      // The final commit can append text, replace the row, and switch to ok
      // together. Continue only an already tracked source, never old history.
      if (running || previous?.has(key)) sources.push({ key, root: think, kind: 'reasoning', running })
    } else {
      const summary = think.querySelector('[data-streaming="true"]')
      const key = 'think:' + index + ':summary'
      if (summary !== null && (running || previous?.has(key))) sources.push({ key, root: summary, kind: 'summary', running })
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
    const code = parentElement.closest('code')
    if (lastBlock !== null && (block !== lastBlock || (code !== null && !code.contains(nodes[nodes.length - 1]?.node)))) blockStarts.push(length)
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

/* A view can mount empty before its history arrives. Hydrate the entire first
   population, including completed tool rows and reasoning, not just bodies we
   happened to see before navigation. Keep it open across loading commits;
   close only after reading the commit that removes the history hint. */
function sfBeginViews() {
  for (const view of sfViews.keys()) if (!view.isConnected) sfViews.delete(view)
  for (const view of document.querySelectorAll('[data-conversation-region="chat"][data-conversation-session]')) {
    const session = view.getAttribute('data-conversation-session')
    let entry = sfViews.get(view)
    if (!entry || entry.session !== session) {
      entry = { session, hydrating: true }
      sfViews.set(view, entry)
    }
    const column = view.querySelector('[data-chat-flow]')
    entry.loading = column !== null && [...column.children].some(child =>
      [...child.classList].some(name => name.endsWith('@host(chatView.historyHint.fragment)')))
    if (entry.loading) entry.hydrating = true
    else if (view.getAttribute('data-content-phase') === 'hero') entry.hydrating = false
  }
}

function sfEndViews() {
  for (const [view, entry] of sfViews) {
    if (entry.hydrating && !entry.loading && view.querySelector(SF_SEAT)) entry.hydrating = false
  }
}

function sfTextStamp(text, length = text.length) {
  let hash = 2166136261
  for (let i = 0; i < length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

function sfReadSeat(seat, baseline = false) {
  if (!seat.isConnected || seat.closest(SF_SKIP) !== null) return
  const scope = sfScopeOf(seat)
  if (scope === null) return
  baseline ||= sfViews.get(scope.closest('[data-conversation-session]'))?.hydrating === true
  sfProcessRows(seat, scope, baseline)
  const key = seat.getAttribute('data-chat-flow-key')
  const session = scope.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
  let groups = sfScopes.get(scope)
  let group = groups === undefined ? undefined : groups.get(key)
  if (group && group.session !== session) {
    for (const state of group.sources.values()) sfDrop(state)
    groups.delete(key)
    group = undefined
  }
  if (group === undefined) {
    // Settled history carries no streamed text; tracking it would only add
    // a full snapshot per seat on install and on every conversation switch.
    if (!sfHasLive(seat)) return
    if (groups === undefined) {
      groups = new Map()
      sfScopes.set(scope, groups)
    }
    group = { seat, session, sources: new Map() }
    groups.set(key, group)
  }
  group.seat = seat
  if (baseline) {
    for (const state of group.sources.values()) sfDrop(state)
    group.sources.clear()
  }
  const sources = sfSources(seat, group.sources)
  const found = new Set()
  for (const source of sources) {
    found.add(source.key)
    let state = group.sources.get(source.key)
    const snapshot = sfSnapshot(source, state === undefined ? undefined : state.nodes)
    const historyKey = session && source.kind === 'body' ? JSON.stringify([session, key, source.key]) : null
    const known = historyKey === null ? undefined : sfKnownBodies.get(historyKey)
    const restored = state === undefined && known && snapshot.text.length >= known.length &&
      sfTextStamp(snapshot.text, known.length) === known.hash
    if (historyKey !== null && (!state || state.text !== snapshot.text)) {
      sfKnownBodies.delete(historyKey)
      if (snapshot.text.length) sfKnownBodies.set(historyKey, { length: snapshot.text.length, hash: sfTextStamp(snapshot.text) })
      if (sfKnownBodies.size > 512) sfKnownBodies.delete(sfKnownBodies.keys().next().value)
    }
    if (state === undefined) {
      // Switching the disclosure view exposes existing reasoning, not new
      // generation. Its header/body gesture animation already owns that reveal.
      const counterpart = source.key.startsWith('think:') && [...group.sources.keys()].some(key =>
        key.startsWith(source.key.split(':').slice(0, 2).join(':') + ':'))
      const disclosure = source.root.closest('[data-variant="think"]')
      const gesture = disclosure !== null && (sfDisclosureViews.has(disclosure) || sfDisclosures.has(disclosure))
      const hydrated = baseline || restored || (counterpart && gesture)
      if (counterpart && gesture) sfDisclosureViews.delete(disclosure)
      state = {
        ...source, ...snapshot, spans: [], paints: [],
        // Only hydration or an explicit disclosure gesture exposes history.
        // A new live source starts hidden even when its first commit has text.
        cursor: hydrated ? snapshot.text.length : 0, arrived: hydrated ? snapshot.text.length : 0,
        scope, clock: sfClock(scope), surfacePending: !hydrated && source.kind === 'body', hydratedDecorations: hydrated,
        provisionalFloor: hydrated ? snapshot.text.length : 0,
        rate: 0, arrivalRate: 0, gapMs: 0, arrivals: [], lastArrival: 0, lastTick: 0, lastUnitBorn: 0,
      }
      group.sources.set(source.key, state)
      if (!hydrated && snapshot.text.length > 0) sfAppend(state, 0, snapshot.text.length)
    } else {
      sfUpdate(state, source, snapshot, !baseline)
    }
    sfSyncProvisionalLinks(state)
    sfSyncMarkers(state, baseline)
    sfSyncDecorations(state, baseline || state.hydratedDecorations)
    state.hydratedDecorations = false
    sfBind(state)
  }
  for (const [sourceKey, state] of group.sources) {
    if (found.has(sourceKey)) continue
    // A final Markdown commit may remove data-streaming and append a tail.
    // The tracked root retains ownership through its final paint.
    if (state.root.isConnected && seat.contains(state.root) &&
        !(state.kind === 'summary' && state.root.closest('[data-expanded]') !== null)) {
      sfUpdate(state, { root: state.root, kind: state.kind, running: false }, sfSnapshot(state, state.nodes), !baseline)
      sfSyncProvisionalLinks(state)
      sfSyncMarkers(state)
      sfSyncDecorations(state)
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
let sfDisclosureViews = new WeakSet()
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
  sfDisclosureViews.add(entry.box)
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
    sfDisclosureViews.add(target.box)
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
  sfDisclosureViews = new WeakSet()
}

function sfProcessRows(seat, scope, baseline) {
  let groups = sfRows.get(scope)
  if (groups === undefined) {
    groups = new Map()
    sfRows.set(scope, groups)
  }
  const key = seat.getAttribute('data-chat-flow-key')
  const session = scope.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
  let group = groups.get(key)
  if (group && group.session !== session) {
    for (const entry of group.pending.values()) sfReleaseRow(entry)
    group = undefined
  }
  if (group === undefined) {
    group = { seat, session, seen: new Set(), pending: new Map() }
    groups.set(key, group)
  }
  group.seat = seat
  const found = new Set()
  let index = 0
  for (const row of seat.querySelectorAll('[data-variant][data-state]')) {
    if (row.closest(SF_SEAT) !== seat) continue
    const parentRow = row.parentElement.closest('[data-variant][data-state]')
    if (parentRow !== null && seat.contains(parentRow)) continue
    const signature = row.getAttribute('data-variant') + ':' + (row.getAttribute('data-tool') || '') + ':' + index++
    found.add(signature)
    const pending = group.pending.get(signature)
    if (baseline) {
      if (pending) sfReleaseRow(pending)
      sfRowAnimations.get(row.querySelector('[data-disclosure-header]') || row)?.cancel()
      group.seen.add(signature)
      continue
    }
    if (pending !== undefined) {
      if (pending.row !== row) {
        pending.hold.cancel()
        pending.row = row
        pending.hold = sfHoldRow(row)
      }
      continue
    }
    if (group.seen.has(signature)) continue
    group.seen.add(signature)
    if (baseline || typeof row.animate !== 'function') continue
    const entry = { row, scope, group, signature, hold: sfHoldRow(row) }
    group.pending.set(signature, entry)
    sfPendingRows.add(entry)
  }
  for (const [signature, entry] of group.pending) if (!found.has(signature)) sfReleaseRow(entry)
}

function sfHoldRow(row) {
  // A paused effect hides the entire expanded row without changing layout,
  // inline styles, attributes, or source discovery. Visibility also removes
  // its controls from focus/accessibility while it waits. Unlike owned DOM
  // attributes, this effect cannot leak into a React clone or serialized HTML.
  const animation = row.animate([
    { opacity: 0, visibility: 'hidden' },
    { opacity: 0, visibility: 'hidden' },
  ], { duration: 1, fill: 'both' })
  animation.pause()
  animation.currentTime = 0
  return animation
}

function sfReleaseRow(entry, enter = false) {
  entry.hold.cancel()
  entry.group.pending.delete(entry.signature)
  sfPendingRows.delete(entry)
  if (!enter) return
  const target = entry.row.querySelector('[data-disclosure-header]') || entry.row
  // Entry retains the existing fixed-height, small-rise header motion.
  const animation = target.animate([
    { opacity: 0, transform: 'translateY(4px)' },
    { opacity: 1, transform: 'none' },
  ], { duration: SF_DURATION, easing: 'cubic-bezier(.2, 0, 0, 1)' })
  sfRowSeen += 1
  sfRowAnimations.set(target, animation)
  animation.onfinish = animation.oncancel = () => {
    if (sfRowAnimations.get(target) === animation) sfRowAnimations.delete(target)
    sfSchedule()
  }
}

function sfResolveRows() {
  for (const entry of sfPendingRows) {
    const { row, scope } = entry
    if (!row.isConnected || sfScopeOf(row) !== scope || !entry.group.seat.contains(row)) {
      sfReleaseRow(entry)
      continue
    }
    // Re-evaluate the actual preceding paint frontier. Earlier sources may
    // receive another tail while a row waits; own/descendant and later text
    // can never become a barrier, so expanded content cannot deadlock itself.
    let waiting = false
    for (const state of sfActive) {
      if (state.scope !== scope) continue
      const first = state.spans.find(span => span.value < 1)
      const node = first && sfNodeAt(state, first.start)
      if (node && !row.contains(node) && sfBefore(node, row)) { waiting = true; break }
    }
    const earlierRow = [...sfPendingRows].some(other => other !== entry && other.scope === scope && sfBefore(other.row, row))
    const earlierAnimation = [...sfRowAnimations.keys()].some(target => sfScopeOf(target) === scope && sfBefore(target, row))
    if (!waiting && !earlierRow && !earlierAnimation) sfReleaseRow(entry, true)
  }
}

function sfClock(scope) {
  let clock = sfClocks.get(scope)
  if (clock === undefined) {
    clock = { arrivals: [], lastArrival: 0, arrivalRate: 0, gapMs: 0 }
    sfClocks.set(scope, clock)
  }
  return clock
}

function sfAppend(state, start, end, recordArrival = true) {
  const now = performance.now()
  // A provisional destination has no painted glyphs. Do not teach its raw URL
  // length to the arrival estimator or queue it ahead of the compact label.
  state.provisionalRanges = sfProvisionalCandidates(state)
  const hiddenLength = state.provisionalRanges.reduce((sum, range) => sum + Math.max(0, Math.min(end, range.end) - Math.max(start, range.start)), 0)
  const length = Math.max(0, end - start - hiddenLength)
  const clock = state.clock || state
  if (length === 0) {
    state.arrived = Math.max(state.arrived, end)
    if (!state.spans.length) state.cursor = state.arrived
    return
  }
  if (recordArrival) {
    const gap = clock.lastArrival ? now - clock.lastArrival : 0
    if (gap > 0) {
      clock.gapMs = clock.gapMs ? clock.gapMs * 0.6 + Math.min(700, gap) * 0.4 : gap
      sfGap = clock.gapMs
    }
    // A pause carries the learned rate, but does not count as slow generation.
    if (gap > 900) clock.arrivals = []
    clock.arrivals.push({ t: now, n: length })
    while (clock.arrivals.length > 2 && now - clock.arrivals[0].t > SF_ARRIVAL_MS) clock.arrivals.shift()
    if (clock.arrivals.length > 1) {
      const first = clock.arrivals[0]
      const elapsed = now - first.t
      if (elapsed > 0) {
        const chars = clock.arrivals.slice(1).reduce((sum, item) => sum + item.n, 0)
        clock.arrivalRate = Math.min(SF_RATE_MAX, chars / Math.max(40, elapsed))
      }
    } else if (!clock.arrivalRate) clock.arrivalRate = Math.min(0.12, Math.max(0.02, length / 240))
    clock.lastArrival = now
    state.arrivalRate = clock.arrivalRate
    state.gapMs = clock.gapMs
    sfLastChunk = now
  }
  // Keep UTF-16 surrogate pairs together at a changed suffix boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(state.text[start]) && /[\uD800-\uDBFF]/.test(state.text[start - 1])) start -= 1

  state.arrived = Math.max(state.arrived, end)
  // Queue fixed-size units behind the frontier; sfDrive releases them in
  // reading order. A unit never crosses a line ending, and the first unit
  // after one is marked so one release group cannot span two lines: the
  // previous line is fully bright before the next line starts.
  // Exceptional live backfills stay animated, with bounded range allocation
  // and a bulk drain budget. They are never reclassified as hydrated history.
  const unit = Math.max(SF_UNIT, Math.ceil((end - start) / 600))
  state.burstRate = Math.max(state.burstRate || SF_RATE_MAX, (end - start) / 1200)
  const from = Math.max(start, state.cursor)
  const text = state.text
  const blocks = state.blockStarts === undefined ? [] : state.blockStarts
  let blockIndex = 0
  while (blockIndex < blocks.length && blocks[blockIndex] < from) blockIndex += 1
  let boundary = from > 0 && (text.charCodeAt(from - 1) === 10 || blocks[blockIndex] === from)
  if (blockIndex < blocks.length && blocks[blockIndex] === from) blockIndex += 1
  for (let at = from; at < end;) {
    const provisional = state.provisionalRanges.find(range => range.end > at)
    if (provisional && provisional.start <= at) { at = provisional.end; continue }
    let unitEnd = Math.min(end, at + unit, provisional?.start ?? end)
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
    if (unitEnd < end && /[\uDC00-\uDFFF]/.test(text[unitEnd]) && /[\uD800-\uDBFF]/.test(text[unitEnd - 1])) unitEnd += 1
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
  return Math.min(80, Math.max(32, (state.clock || state).gapMs * 0.2 || 32))
}

// The first unfinished span is the paint frontier, not the fractional cursor.
// DOM order handles multiple sources in one seat and multiple seats in a chat.
function sfNodeAt(state, offset) {
  let low = 0
  let high = state.nodes.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (state.nodes[mid].end <= offset) low = mid + 1
    else high = mid
  }
  return state.nodes[low]?.node
}

function sfBefore(a, b) {
  return a !== b && a?.isConnected && b?.isConnected &&
    !!(a.compareDocumentPosition(b) & 4)
}

function sfBlocked(state, offset) {
  if (!state.scope) return false // deterministic controller without a DOM
  const node = sfNodeAt(state, offset)
  if (!node) return false
  for (const other of sfActive) {
    if (other === state || other.scope !== state.scope) continue
    const first = other.spans.find(span => span.value < 1)
    if (first && sfBefore(sfNodeAt(other, first.start), node)) return true
  }
  for (const entry of sfPendingRows) {
    if (entry.scope === state.scope && !entry.row.contains(node) && sfBefore(entry.row, node)) return true
  }
  // Expanded own content follows its header's actual animation completion.
  for (const target of sfRowAnimations.keys()) {
    if (sfScopeOf(target) === state.scope && sfBefore(target, node)) return true
  }
  return false
}

// Highlights cannot conceal excluded surfaces such as pre/code cards. A new
// separate body therefore owns a paused visibility effect until its external
// predecessor has painted. Never conceal an ancestor of that prerequisite.
function sfSurfaceBlocked(state, root = state.root) {
  const precedes = node => node && !root.contains(node) && sfBefore(node, root)
  for (const other of sfActive) {
    if (other.scope !== state.scope) continue
    const first = other.spans.find(span => span.value < 1)
    if (first && precedes(sfNodeAt(other, first.start))) return true
  }
  for (const entry of sfPendingRows) {
    if (entry.scope === state.scope && !entry.row.contains(root) && precedes(entry.row)) return true
  }
  for (const target of sfRowAnimations.keys()) {
    if (sfScopeOf(target) === state.scope && precedes(target)) return true
  }
  return false
}

function sfClearSurface(state) {
  if (state.surfaceHold) state.surfaceHold.cancel()
  state.surfaceHold = null
  state.surfaceRoot = null
}

/* Only a trailing, still-open inline Markdown destination is provisional.
   Ordinary URLs, visibly escaped syntax, images, code, closed links and
   destinations crossing a block are excluded. The host strips some source
   escapes: identical rendered syntax is necessarily provisional too, and is
   restored on close/settle. Offsets span inline nodes without editing them. */
function sfUnfinishedDestination(text, from = 0) {
  const tail = text.slice(from)
  const match = /\[([^\[\]\n]+)\]\((https?:\/\/[^\s]*)$/.exec(tail)
  if (!match || tail.slice(0, match.index).includes('`')) return null
  const open = from + match.index
  let escapes = 0
  for (let at = open - 1; at >= 0 && text[at] === '\\'; at--) escapes += 1
  if (escapes % 2 || text[open - 1] === '!') return null
  const start = open + match[1].length + 3
  let depth = 1
  for (let at = start; at < text.length; at++) {
    if (text[at] === '\\') { at += 1; continue }
    if (text[at] === '(') depth += 1
    if (text[at] === ')' && --depth === 0) return null
  }
  return { start, end: text.length }
}

function sfProvisionalCandidates(state) {
  const found = []
  const destination = state.running && sfUnfinishedDestination(state.text, state.blockStarts?.at(-1) || 0)
  if (!destination || destination.start < (state.provisionalFloor || 0) || !state.root?.querySelectorAll) return found
  for (const element of state.root.querySelectorAll('a[href]')) {
    const entries = state.nodes.filter(entry => element.contains(entry.node))
    if (!entries.length || entries[0].start < destination.start || entries.at(-1).end > destination.end) continue
    if (element.closest('code, pre') !== null || typeof element.animate !== 'function') continue
    const text = entries.map(entry => entry.node.data).join('')
    // A labelled link inside the literal suffix is not a raw autolink.
    if (!/^https?:\/\//.test(text) || element.getAttribute('href') !== text) continue
    found.push({ element, text, start: entries[0].start, end: entries.at(-1).end })
  }
  return found
}

function sfSyncProvisionalLinks(state) {
  const previous = state.provisionalLinks || new Map()
  const next = new Map()
  state.provisionalRanges = sfProvisionalCandidates(state)
  for (const range of state.provisionalRanges) {
    // The scheme may have arrived as plain Text before the host recognized an
    // autolink. Retire those in-flight glyphs too, so restoration cannot create
    // overlapping paint spans with conflicting progress for the same label.
    state.spans = state.spans.flatMap(span => {
      if (span.end <= range.start || span.start >= range.end) return [span]
      sfFreeSpan(span)
      const kept = []
      if (span.start < range.start) kept.push({ ...span, end: range.start, ranges: [], level: -1 })
      if (span.end > range.end) kept.push({ ...span, start: range.end, ranges: [], level: -1 })
      return kept
    })
  }
  for (const { element } of state.provisionalRanges) {
    let hold = previous.get(element)
    if (!hold) {
      // Zero-size only this transient URL box. Text, href and inline styles
      // remain React-owned; cancel restores malformed final Markdown too.
      const frame = { display: 'inline-block', width: '0px', maxWidth: '0px', height: '0px',
        maxHeight: '0px', padding: '0px', margin: '0px', borderWidth: '0px',
        overflow: 'hidden', fontSize: '0px', lineHeight: '0px', opacity: 0, visibility: 'hidden' }
      hold = element.animate([frame, frame], { duration: 1, fill: 'both' })
      hold.pause()
      hold.currentTime = 0
    }
    next.set(element, hold)
  }
  for (const [element, hold] of previous) if (!next.has(element)) hold.cancel()
  state.provisionalLinks = next
}

/* Highlights hide glyphs, not code backgrounds, borders, or toolbar surfaces.
   Track these separately inside an existing live root. Effects never serialize
   into host clones, and a settled logical owner never replays on replacement. */
function sfSyncDecorations(state, baseline = false) {
  const previous = state.decorations || []
  const byElement = new Map(previous.map(entry => [entry.element, entry]))
  const owners = [...state.root.querySelectorAll('.md-code-block, pre, code, a[href]')].filter(element => {
    if (element.parentElement.closest('.md-code-block, pre, code, a[href]') !== null) return false
    const facts = sfFacts(element.tagName === 'PRE' ? element.parentElement : element)
    return !facts.skip && !(state.kind === 'body' && facts.think) &&
      !(state.kind === 'reasoning' && facts.header)
  })
  // Host links put their globe/site glyph directly inside the anchor. Fade
  // that decoration only: parent opacity would attenuate highlighted text twice.
  const surfaces = owners.flatMap(owner => owner.tagName === 'A'
    ? [...owner.children].filter(element => element.matches('svg[aria-hidden="true"], img[aria-hidden="true"]')).map(element => ({ element, owner }))
    : [{ element: owner, owner }])
  const elements = surfaces.map(surface => surface.element)
  state.decorations = surfaces.map(({ element, owner }) => {
    const first = state.nodes.find(entry => owner.contains(entry.node))
    // Excluded block code still has a logical position between prose nodes.
    // Array index alone can transfer a settled owner's visibility to a newly
    // inserted/reordered code surface during a wholesale Markdown replacement.
    const anchor = first?.start ?? state.nodes.find(entry => sfBefore(element, entry.node))?.start ?? state.text.length
    const text = owner.textContent
    const prior = byElement.get(element) || previous.find(entry => !elements.includes(entry.element) &&
      entry.element.tagName === element.tagName && entry.anchor === anchor && entry.text === text)
    const inline = owner.tagName === 'CODE' || owner.tagName === 'A'
    const changed = prior && (prior.anchor !== anchor || (inline ? first && sfMarkerSpan(state, first.start) !== null : prior.text !== text))
    const entry = { element, owner, offset: first?.start, anchor, inline, text,
      pending: !baseline && (prior ? prior.pending || !!changed : true), hold: prior?.element === element ? prior.hold : null,
      fading: prior?.element === element && prior.fading }
    return entry
  })
  for (const entry of previous) {
    if (entry.hold && !state.decorations.some(next => next.hold === entry.hold)) entry.hold.cancel()
  }
}

function sfPaintDecorations(state) {
  for (const entry of state.decorations || []) {
    if (!entry.pending) continue
    const span = entry.offset === undefined ? null : sfMarkerSpan(state, entry.offset)
    const waiting = entry.element.isConnected && (sfSurfaceBlocked(state, entry.owner || entry.element) ||
      (entry.inline && (span ? span.level <= 0 : entry.offset === undefined && state.running)))
    if (waiting && typeof entry.element.animate === 'function') {
      if (entry.fading) { entry.hold.cancel(); entry.hold = null; entry.fading = false }
      if (!entry.hold) entry.hold = sfHoldRow(entry.element)
    } else if (entry.inline && span && span.level < SF_LEVELS - 1 && typeof entry.element.animate === 'function') {
      if (!entry.hold) entry.hold = sfHoldRow(entry.element)
      if (!entry.fading) {
        // The surface uses the first glyph's existing paint clock, not a new
        // animation timer. Underlying opacity remains the host's own value.
        // Text is also highlighted: its brief extra attenuation preserves
        // the queued suffix instead of exposing the whole code at once.
        entry.hold.effect.setKeyframes([{ opacity: 0, visibility: 'visible' }, { visibility: 'visible' }])
        entry.fading = true
      }
      entry.hold.currentTime = Math.max(0, span.level) / (SF_LEVELS - 1)
    } else {
      if (entry.hold) entry.hold.cancel()
      entry.hold = null
      entry.fading = false
      entry.pending = false
    }
  }
}

function sfSyncSurfaces() {
  for (const groups of sfScopes.values()) for (const group of groups.values()) {
    for (const state of group.sources.values()) {
      sfPaintDecorations(state)
      if (!state.surfacePending) continue
      if (state.surfaceRoot && state.surfaceRoot !== state.root) sfClearSurface(state)
      const blocked = state.root.isConnected && sfSurfaceBlocked(state)
      if (blocked && typeof state.root.animate === 'function') {
        if (!state.surfaceHold) {
          state.surfaceHold = sfHoldRow(state.root)
          state.surfaceRoot = state.root
        }
      } else {
        const held = !!state.surfaceHold
        sfClearSurface(state)
        // Empty live roots can precede their first prose/code commit.
        if (held || state.root.textContent.length > 0 || !state.root.isConnected) state.surfacePending = false
      }
    }
  }
}

function sfDrive(state, now) {
  let dt = state.lastTick === 0 ? 16 : Math.min(48, Math.max(0, now - state.lastTick))
  state.lastTick = now
  const hiddenAhead = (state.provisionalRanges || []).reduce((sum, range) => sum + Math.max(0, range.end - Math.max(state.cursor, range.start)), 0)
  const backlog = state.arrived - state.cursor - hiddenAhead
  if (backlog <= 0) { state.cursor = state.arrived; state.burstRate = SF_RATE_MAX; return }
  const pending = state.spans.find(span => span.born === Infinity)
  if (pending && sfBlocked(state, pending.start)) { state.waiting = true; return }
  if (state.waiting) { dt = Math.min(dt, 16); state.waiting = false }
  const clock = state.clock || state
  const upstream = clock.arrivalRate || 0.03
  state.arrivalRate = upstream
  state.gapMs = clock.gapMs
  const target = Math.max(1, upstream * sfHorizon(state))
  // Additive feedback responds immediately to excess queued characters even
  // while the feed-forward estimate is adapting. Bursts drain continuously;
  // neither turn completion nor waiting creates a special speed multiplier.
  let desired = upstream + (backlog - target) / 160
  desired = Math.min(state.burstRate || SF_RATE_MAX, Math.max(SF_RATE_MIN, backlog / SF_DRAIN_MS, desired))
  if (!state.rate) state.rate = Math.min(upstream, desired)
  state.rate += (desired - state.rate) * (1 - Math.exp(-dt / SF_RATE_TAU))
  state.cursor = Math.min(state.arrived, state.cursor + state.rate * dt)
  for (const range of state.provisionalRanges || []) {
    if (state.cursor >= range.start && state.cursor < range.end) state.cursor = range.end
  }
  // A line boundary waits for the previous line's paint. No elapsed-time
  // credit is banked at boundaries or source/row waits.
  for (const span of state.spans) {
    if (span.start >= state.cursor) break
    // A tail rewrite can queue new text before a retained, already fading
    // suffix. Pending spans are ordered by offset, but need not be a tail.
    if (span.born !== Infinity) continue
    // The check sits on the boundary span itself, so a cursor jump that
    // crosses a whole line in one tick still cannot reveal the next line
    // before the previous one has finished fading.
    if (span.paraStart === true && state.lastUnitBorn !== 0 &&
        now < state.lastUnitBorn + SF_DURATION) {
      state.cursor = span.start
      break
    }
    if (sfBlocked(state, span.start)) {
      state.cursor = span.start
      break
    }
    span.born = now
    state.lastUnitBorn = now
  }
}

/* Bounded Myers alignment for the changed middle only. Markdown can remove
   syntax near the start and append a tail in the same commit. Prefix/suffix
   alone would replay the surviving prose. Ordinary appends never enter here;
   unrelated large replacements fall back to the conservative old behavior. */
function sfRetainedMiddle(a, b, offset) {
  if (!a.length || !b.length) return []
  let work = 0
  const trace = []
  let frontier = new Map([[1, 0]])
  for (let distance = 0; distance <= Math.min(128, a.length + b.length); distance += 1) {
    trace.push(frontier)
    const next = new Map()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 65536) return null
      const down = diagonal === -distance || (diagonal !== distance &&
        (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1
      let y = x - diagonal
      while (x < a.length && y < b.length && a[x] === b[y]) {
        if (++work > 65536) return null
        x += 1; y += 1
      }
      next.set(diagonal, x)
      // Once either side is consumed, the remainder is a plain append/delete.
      // A large final batch must not exhaust the edit budget just by arriving.
      if (x < a.length && y < b.length) continue
      const runs = []
      for (let d = distance; d >= 0; d -= 1) {
        const v = trace[d], k = x - y
        const previousK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1
        const previousX = v.get(previousK) ?? 0
        const previousY = previousX - previousK
        const endX = x, endY = y
        while (x > previousX && y > previousY) { x -= 1; y -= 1 }
        if (endX > x) runs.push({ oldStart: offset + x, start: offset + y, end: offset + endY })
        x = previousX; y = previousY
      }
      return runs.reverse()
    }
    frontier = next
  }
  return null
}

function sfUpdate(state, source, snapshot, animate) {
  const oldText = state.text
  const oldProvisional = state.provisionalRanges || []
  const newText = snapshot.text
  let prefix = 0
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1
  let suffix = 0
  const gaps = []
  if (oldText !== newText) {
    while (suffix < oldText.length - prefix && suffix < newText.length - prefix &&
           oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix += 1
    // Include the suffix in alignment: the final full stop of a new paragraph
    // must not steal the identity of the previous paragraph's full stop.
    const middle = oldText.length > prefix + suffix && newText.length > prefix + suffix
      ? sfRetainedMiddle(oldText.slice(prefix), newText.slice(prefix), prefix) : null
    const runs = [{ oldStart: 0, start: 0, end: prefix },
      ...(middle ?? [{ oldStart: oldText.length - suffix, start: newText.length - suffix, end: newText.length }]),
      { oldStart: oldText.length, start: newText.length, end: newText.length }]
    const retained = []
    for (const span of state.spans) {
      if (span.end <= prefix) { retained.push(span); continue }
      sfFreeSpan(span)
      for (const run of runs) {
        const start = Math.max(span.start, run.oldStart)
        const end = Math.min(span.end, run.oldStart + run.end - run.start)
        if (start >= end) continue
        const shift = run.start - run.oldStart
        retained.push({ start: start + shift, end: end + shift, born: span.born, ranges: [], level: -1, summary: span.summary, value: span.value, paraStart: span.paraStart })
      }
    }
    state.spans = retained
    let frontier = 0, end = 0
    for (const run of runs) {
      if (run.start > end) gaps.push({ start: end, end: run.start })
      if (run.start === frontier && state.cursor >= run.oldStart) {
        frontier = Math.min(run.end, run.start + state.cursor - run.oldStart)
      }
      end = run.end
    }
    state.cursor = frontier
    state.arrived = newText.length
  }
  const replacedFrom = snapshot.replacedFrom
  if (replacedFrom !== undefined) {
    sfRemapped += 1
    state.dirtyFrom = state.dirtyFrom === undefined ? replacedFrom : Math.min(state.dirtyFrom, replacedFrom)
  }
  Object.assign(state, source, snapshot)
  if (animate && newText !== oldText) {
    for (const gap of gaps) sfAppend(state, gap.start, gap.end)
    // Changed middles join all retained runs in reading order.
    if (prefix !== oldText.length) state.spans.sort((a, b) => a.start - b.start)
  }
  const nextProvisional = sfProvisionalCandidates(state)
  for (const range of oldProvisional) {
    if (prefix < range.end || newText.slice(range.start, range.end) !== range.text ||
        nextProvisional.some(next => next.start <= range.start && next.end >= range.end)) continue
    // A malformed final destination (or a trailing space) becomes real prose.
    // Restore it in reading order, without inventing another network arrival.
    state.cursor = Math.min(state.cursor, range.start)
    sfAppend(state, range.start, range.end, false)
    state.spans.sort((a, b) => a.start - b.start)
  }
  state.provisionalRanges = nextProvisional
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

/* Highlights do not paint ::marker. Own only markers whose first meaningful
   character is in flight (plus newly arriving empty items). Never dim a li:
   that would also dim its independent nested lists and inline content. */
function sfMarkerSpan(state, offset) {
  let low = 0
  let high = state.spans.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (state.spans[mid].end <= offset) low = mid + 1
    else high = mid
  }
  const span = state.spans[low]
  return span !== undefined && span.start <= offset ? span : null
}

function sfFreeMarker(element) {
  element.removeAttribute('data-daf-stream-marker')
  element.style.removeProperty('--daf-marker-ink')
  element.style.removeProperty('--daf-marker-alpha')
}

function sfSyncMarkers(state, baseline = false) {
  const previous = state.markerLists || []
  const previousByElement = new Map(previous.map(entry => [entry.element, entry]))
  const owned = state.markers || new Map()
  const lists = []
  const byElement = new Map()
  for (const element of state.root.querySelectorAll('li')) {
    const facts = sfFacts(element)
    if (facts.skip || (state.kind === 'body' && facts.think) ||
        (state.kind === 'reasoning' && facts.header)) continue
    // innerHTML/cloneNode can copy our paint without copying its JS owner.
    // Only inspect this source's eligible items: a nested reasoning source
    // can legitimately own markers inside a body source's DOM subtree.
    if (!owned.has(element) && element.hasAttribute('data-daf-stream-marker')) sfFreeMarker(element)
    const entry = { element, offset: null, node: null, empty: false }
    lists.push(entry)
    byElement.set(element, entry)
  }
  if (lists.length === 0) {
    for (const element of owned.keys()) sfFreeMarker(element)
    owned.clear()
    state.markerLists = lists
    state.markers = owned
    return
  }
  for (const entry of state.nodes) {
    const first = entry.node.data.search(/\S/)
    if (first < 0) continue
    // A parent with only a nested list follows its first descendant text;
    // each child still owns its own marker, never an ancestor's opacity.
    let element = entry.node.parentElement.closest('li')
    while (element !== null && byElement.has(element)) {
      const marker = byElement.get(element)
      if (marker.offset === null) {
        marker.offset = entry.start + first
        marker.node = entry.node
      }
      element = element.parentElement.closest('li')
    }
  }
  const next = new Map()
  for (let index = 0; index < lists.length; index += 1) {
    const entry = lists[index]
    const element = entry.element
    if (entry.offset === null) {
      // Keep already-visible empty history visible, also across React node
      // replacement. Text excluded from the reveal (e.g. pre) is not empty.
      entry.empty = element.textContent.trim().length === 0
      const replaced = previous[index]
      const prior = previousByElement.get(element) ||
        (replaced !== undefined && !byElement.has(replaced.element) ? replaced : undefined)
      entry.wait = entry.empty && state.running && !baseline &&
        (prior === undefined || !prior.empty || prior.wait)
    }
    if (!entry.wait && (entry.offset === null || sfMarkerSpan(state, entry.offset) === null)) continue
    const owner = owned.get(element)
    if (owner !== undefined) entry.level = owner.level
    else {
      // Read the host marker colour before adding our selector; it is often
      // secondary ink rather than the li's ordinary text colour.
      const color = window.getComputedStyle(element, '::marker').color
      element.style.setProperty('--daf-marker-ink', color)
      element.style.setProperty('--daf-marker-alpha', '0%')
      element.setAttribute('data-daf-stream-marker', '')
      entry.level = 0
    }
    next.set(element, entry)
  }
  for (const element of owned.keys()) if (!next.has(element)) sfFreeMarker(element)
  state.markerLists = lists
  state.markers = next
}

function sfPaintMarkers(state) {
  if (state.markers === undefined) return
  const selection = sfSelection()
  for (const [element, entry] of state.markers) {
    const span = entry.offset === null ? null : sfMarkerSpan(state, entry.offset)
    if (!element.isConnected || (!entry.wait && span === null)) {
      sfFreeMarker(element)
      state.markers.delete(element)
      continue
    }
    let level = span === null ? 0 : span.level
    if (span !== null && span.summary && level > 0) level = SF_LEVELS / 2 + (level >> 1)
    if (entry.node !== null && selection !== null && selection.containsNode(entry.node, true)) level = SF_LEVELS - 1
    if (entry.level === level) continue
    element.style.setProperty('--daf-marker-alpha', (Math.max(0, level) * 100 / (SF_LEVELS - 1)).toFixed(2) + '%')
    entry.level = level
  }
}

function sfRelease(state) {
  sfClearSurface(state)
  for (const hold of state.provisionalLinks?.values() || []) hold.cancel()
  state.provisionalLinks = new Map()
  for (const entry of state.decorations || []) if (entry.hold) entry.hold.cancel()
  state.decorations = []
  for (const span of state.spans) sfFreeSpan(span)
  if (state.markers !== undefined) {
    for (const element of state.markers.keys()) sfFreeMarker(element)
    state.markers.clear()
  }
  state.markerLists = []
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
  /* Queued summaries are hidden just like body text. Once released they
     walk the top half of the ladder, sharing the same highlight rules. */
  return sfHighlights[summary && level > 0 ? SF_LEVELS / 2 + (level >> 1) : level]
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
    sfPaintMarkers(state)
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
    // Text setters and partial replaceData can move live Range endpoints,
    // even when the node and its text are unchanged. Rebind altered ranges
    // before paint, preserving born/value so the fade never restarts.
    if (span.ranges.some(range => {
      const bounds = sfRangeBounds.get(range)
      return range.startContainer !== bounds.node || range.endContainer !== bounds.node ||
        range.startOffset !== bounds.start || range.endOffset !== bounds.end
    })) sfFreeSpan(span)
    if (span.ranges.length === 0) sfPaintSpan(state, span, selection, now, duration)
    else sfAdvanceSpan(span, Math.min(1, Math.max(0, (now - span.born) / duration)))
  }
  sfPaintMarkers(state)
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
    sfRangeBounds.set(range, { node: entry.node, start: start - entry.start, end: end - entry.start })
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
  sfBeginViews()
  for (const seat of sfDirty) sfReadSeat(seat)
  sfDirty.clear()
  sfEndViews()
  sfResolveRows()
  sfSyncSurfaces()
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
      // Loading hint insertion/removal can be the only mutation in this commit.
      // Re-read the column before closing its history boundary.
      if (record.type === 'childList' && element.matches('[data-chat-flow]')) sfMark(element)
    }
    if (record.type === 'attributes' && record.attributeName === 'data-conversation-session' && element !== null) sfMark(element)
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
  sfBeginViews()
  for (const seat of root instanceof Element && root.matches(SF_SEAT) ? [root] : root.querySelectorAll(SF_SEAT)) {
    if (sfHasLive(seat)) sfReadSeat(seat, true)
    else {
      const scope = sfScopeOf(seat)
      if (scope !== null) sfProcessRows(seat, scope, true)
    }
  }
  sfEndViews()
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
  sfBeginViews()
  for (const seat of sfDirty) sfReadSeat(seat)
  sfDirty.clear()
  sfEndViews()
  for (const [scope, groups] of sfScopes) {
    for (const [key, group] of groups) {
      if (scope.isConnected && group.seat.isConnected && scope.contains(group.seat)) continue
      for (const state of group.sources.values()) sfDrop(state)
      groups.delete(key)
    }
    if (!scope.isConnected || groups.size === 0) sfScopes.delete(scope)
    if (!scope.isConnected) sfClocks.delete(scope)
  }
  for (const scope of sfClocks.keys()) if (!scope.isConnected) sfClocks.delete(scope)
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
    sfPaintMarkers(state)
    if (state.spans.length === 0) sfActive.delete(state)
  }
  sfSyncSurfaces()
  for (const [scope, groups] of sfScopes) {
    for (const [key, group] of groups) {
      for (const [sourceKey, state] of group.sources) {
        if (state.stale === true ||
            (!state.running && !state.surfaceHold && !(state.decorations || []).some(entry => entry.pending) && state.spans.length === 0 && state.arrived <= state.cursor)) group.sources.delete(sourceKey)
      }
      if (group.sources.size === 0) groups.delete(key)
    }
    if (groups.size === 0) sfScopes.delete(scope)
  }
  sfResolveRows()
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
  // Empty arriving items can own a marker without any active text spans.
  for (const groups of sfScopes.values()) {
    for (const group of groups.values()) {
      for (const state of group.sources.values()) sfDrop(state)
    }
  }
  for (const state of sfActive) sfDrop(state)
  sfDisposeLevels()
  for (const entry of sfPendingRows) sfReleaseRow(entry)
  for (const animation of sfRowAnimations.values()) animation.cancel()
  sfRowAnimations.clear()
  sfRows.clear()
  sfScopes.clear()
  sfViews.clear()
  sfClocks.clear()
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
    attributeFilter: ['data-streaming', 'data-state', 'data-expanded', 'data-open', 'aria-expanded', 'data-ds-dark-theme', 'data-conversation-session'],
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
  sfKnownBodies.clear()
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
    rateSource: 'rendered-characters',
    conversations: sfClocks.size,
    horizon: sfActive.size === 0 ? 0 : Math.round(sfHorizon(sfActive.values().next().value)),
    rowsSeen: sfRowSeen, rowsActive: sfRowAnimations.size, rowsPending: sfPendingRows.size, disclosuresActive: sfDisclosures.size,
    resizing: rsDrag !== null, frozenHistory: rsFrozen.length }
}
// #endregion stream-fade

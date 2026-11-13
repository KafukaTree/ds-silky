// #region scroll-cull
/* Keep settled history out of layout. A row's measured height becomes its
   intrinsic size, so scrollHeight and every host rect read stay put while
   Chrome skips style/layout for content far outside the viewport. The
   newest rows, live output, and any active selection stay fully rendered;
   find-in-page still reveals skipped rows (content-visibility: auto). */
const SC_TAIL = 30
const SC_MIN_ROWS = 50
const SC_KILL = 'daf.scrollCull'
const SC_SCOPE = '[data-conversation-region="chat"], [data-slot="conversation.chat.flow"]'
const SC_ROW = '[data-chat-flow-key]'
const SC_LIVE = '[data-streaming="true"], [data-variant="think"][data-state="running"]'
/* Font size and family live as inline custom properties on <body>. Their
   change reflows every row, so the measured placeholders must be renewed. */
const SC_FONT_VARS = ['--dsh-content-font-size', '--dsh-font-family-text', '--dsh-font-family-code', '--dsh-font-family-terminal']
let scEnabled = true
let scInstalled = false
let scObserver = null
let scBodyObserver = null
let scFontSignature = ''
let scStyle = null
let scTimer = 0
let scSelectionTimer = 0
let scSelecting = false
let scApplied = new Set()

try {
  scEnabled = window.localStorage.getItem(SC_KILL) !== '0'
} catch (error) {
  /* Storage can be unavailable in embedded clients; culling stays on. */
}

function scRowGroups() {
  const groups = new Map()
  for (const row of document.querySelectorAll(SC_ROW)) {
    const scope = row.closest(SC_SCOPE)
    if (scope === null) continue
    // Group seats own leaf seats; culling the group would also skip them.
    if (row.querySelector(SC_ROW) !== null) continue
    let rows = groups.get(scope)
    if (rows === undefined) {
      rows = []
      groups.set(scope, rows)
    }
    rows.push(row)
  }
  return [...groups.values()]
}

function scRowCount() {
  let count = 0
  for (const rows of scRowGroups()) count += rows.length
  return count
}

function scSelectionActive() {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false
  const node = selection.anchorNode
  const element = node === null ? null : node.nodeType === 1 ? node : node.parentElement
  return element !== null && typeof element.closest === 'function' && element.closest(SC_SCOPE) !== null
}

function scUncull(row) {
  row.removeAttribute('data-daf-cull')
  row.style.removeProperty('--daf-cull-h')
  scApplied.delete(row)
}

function scThaw() {
  for (const row of scApplied) scUncull(row)
  scApplied.clear()
}

function scSchedule(delay) {
  if (!scInstalled) return
  if (scTimer !== 0) window.clearTimeout(scTimer)
  scTimer = window.setTimeout(() => {
    scTimer = 0
    scSweep()
  }, delay)
}

function scFontSignatureNow() {
  const style = document.body === null ? null : document.body.style
  if (style === null) return ''
  return SC_FONT_VARS.map(name => style.getPropertyValue(name)).join('|')
}

function scOnBodyStyle() {
  const signature = scFontSignatureNow()
  if (signature === scFontSignature) return
  scFontSignature = signature
  scOnResize()
}

function scMeasureNear(viewport) {
  for (const row of scApplied) {
    if (!row.isConnected) {
      scUncull(row)
      continue
    }
    const rect = row.getBoundingClientRect()
    // Far skipped rows report their intrinsic size, so this only refreshes
    // rows Chrome renders (width, font, or late content changes).
    if (rect.height <= 0 || rect.bottom < -viewport || rect.top > viewport * 2) continue
    const stored = Number.parseFloat(row.style.getPropertyValue('--daf-cull-h'))
    if (!Number.isFinite(stored) || Math.abs(rect.height - stored) > 0.5) {
      row.style.setProperty('--daf-cull-h', rect.height + 'px')
    }
  }
}

function scSweep() {
  if (!scInstalled) return
  if (!scEnabled || scSelectionActive()) {
    scThaw()
    return
  }
  const groups = scRowGroups()
  let total = 0
  for (const rows of groups) total += rows.length
  if (total < SC_MIN_ROWS) {
    scThaw()
    return
  }
  const reads = []
  for (const rows of groups) {
    const tailStart = Math.max(0, rows.length - SC_TAIL)
    // Paging or row removal can move a row back into the live tail.
    for (let index = tailStart; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.getAttribute('data-daf-cull') !== null) scUncull(row)
    }
    for (let index = 0; index < tailStart; index += 1) {
      const row = rows[index]
      if (row.getAttribute('data-daf-cull') !== null) continue
      // Never skip the row that owns live output, wherever it sits.
      if (row.matches(SC_LIVE) || row.querySelector(SC_LIVE) !== null) continue
      reads.push({ row, height: row.getBoundingClientRect().height })
    }
  }
  for (const row of scApplied) {
    if (!row.isConnected) scUncull(row)
  }
  // Finish the layout reads before writing any style.
  for (const read of reads) {
    if (!(read.height > 0)) continue
    read.row.style.setProperty('--daf-cull-h', read.height + 'px')
    read.row.setAttribute('data-daf-cull', '')
    scApplied.add(read.row)
  }
  scMeasureNear(window.innerHeight)
}

function scOnMutations(records) {
  for (const record of records) {
    if (record.type !== 'childList') continue
    for (const nodes of [record.addedNodes, record.removedNodes]) {
      for (const node of nodes) {
        if (node.nodeType !== 1) continue
        if (typeof node.matches === 'function' && node.matches(SC_ROW)) {
          scSchedule(350)
          return
        }
        if (typeof node.querySelector === 'function' && node.querySelector(SC_ROW) !== null) {
          scSchedule(350)
          return
        }
      }
    }
  }
}

function scOnSelection() {
  if (scSelectionTimer !== 0) window.clearTimeout(scSelectionTimer)
  scSelectionTimer = window.setTimeout(() => {
    scSelectionTimer = 0
    const active = scSelectionActive()
    // A caret moving in the composer must not re-sweep on every pause.
    if (active === scSelecting) return
    scSelecting = active
    scSchedule(80)
  }, 120)
}

function scOnScroll() {
  // Height changes reach us as a row scrolls back into rendering.
  if (scApplied.size > 0) scSchedule(160)
}

function scOnResize() {
  // Width or font changes reflow every row; placeholders must be re-measured.
  scThaw()
  scSchedule(260)
}

function scOnVisibility() {
  if (!document.hidden) scSchedule(200)
}

function scSetEnabled(value) {
  scEnabled = value === true
  try {
    window.localStorage.setItem(SC_KILL, scEnabled ? '1' : '0')
  } catch (error) {
    /* The in-memory choice still applies for this page. */
  }
  if (scEnabled) scSchedule(0)
  else scThaw()
  return scStatus()
}

function scRefresh() {
  scThaw()
  scSchedule(0)
  return scStatus()
}

function scStatus() {
  return {
    enabled: scEnabled, installed: scInstalled, applied: scApplied.size,
    rows: scRowCount(), tail: SC_TAIL,
  }
}

function scInstall() {
  if (scInstalled) return
  scInstalled = true
  scStyle = document.createElement('style')
  scStyle.dataset.pluginCss = 'dsh-anthropic-fonts-cull'
  scStyle.textContent = '[data-daf-cull] { content-visibility: auto; contain-intrinsic-size: auto var(--daf-cull-h, 80px); }'
  document.head.appendChild(scStyle)
  scObserver = new MutationObserver(scOnMutations)
  scObserver.observe(document.body, { childList: true, subtree: true })
  if (document.body !== null) {
    scFontSignature = scFontSignatureNow()
    scBodyObserver = new MutationObserver(scOnBodyStyle)
    scBodyObserver.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  }
  document.addEventListener('selectionchange', scOnSelection)
  document.addEventListener('scroll', scOnScroll, true)
  window.addEventListener('resize', scOnResize)
  document.addEventListener('visibilitychange', scOnVisibility)
  scSchedule(800)
}

function scStop() {
  if (!scInstalled) return
  scInstalled = false
  if (scTimer !== 0) window.clearTimeout(scTimer)
  if (scSelectionTimer !== 0) window.clearTimeout(scSelectionTimer)
  scTimer = 0
  scSelectionTimer = 0
  if (scObserver !== null) scObserver.disconnect()
  scObserver = null
  if (scBodyObserver !== null) scBodyObserver.disconnect()
  scBodyObserver = null
  document.removeEventListener('selectionchange', scOnSelection)
  document.removeEventListener('scroll', scOnScroll, true)
  window.removeEventListener('resize', scOnResize)
  document.removeEventListener('visibilitychange', scOnVisibility)
  scThaw()
  if (scStyle !== null) scStyle.remove()
  scStyle = null
}
// #endregion scroll-cull

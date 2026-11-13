// #region resize
/* Freeze only distant history while the user drags a shell divider. Visible
   output and the host's own pointer/width handling stay untouched. */
let rsDrag = null
/* Host width vars republished per drag frame. Writing either one restyles the
   whole Conversation subtree (~143 ms unfrozen, ~23 ms when only the visible
   rows are live), so they are coalesced while a divider is dragged and applied
   once on release; the chat reflows on pointerup instead of every frame. */
const RS_WIDTH_VARS = ['--dsh-conversation-column-width', '--dsh-chat-user-width']
let rsWriteGuard = null

function rsGuardBegin() {
  if (rsWriteGuard !== null || window.CSSStyleDeclaration === undefined) return
  const proto = window.CSSStyleDeclaration.prototype
  const guard = { proto, original: proto.setProperty, pending: new Map(), applied: new Map(),
    stepped: rsDrag !== null && rsDrag.width === true }
  rsWriteGuard = guard
  proto.setProperty = function (name, value, priority) {
    if (rsWriteGuard !== guard || RS_WIDTH_VARS.indexOf(name) === -1) {
      return guard.original.call(this, name, value, priority)
    }
    const numeric = Number.parseFloat(value)
    if (guard.stepped && Number.isFinite(numeric)) {
      // A width handle is dragged to change the text width, so it needs live
      // feedback: repaint in ~32 px steps instead of every frame.
      let perTarget = guard.applied.get(this)
      if (perTarget === undefined) {
        perTarget = new Map()
        guard.applied.set(this, perTarget)
      }
      const previous = perTarget.get(name)
      const base = previous === undefined ? Number.parseFloat(this.getPropertyValue(name)) : previous
      if (!Number.isFinite(base) || Math.abs(numeric - base) >= 32) {
        perTarget.set(name, numeric)
        let pendingTarget = guard.pending.get(this)
        if (pendingTarget !== undefined) pendingTarget.delete(name)
        return guard.original.call(this, name, value, priority)
      }
    }
    let deferred = guard.pending.get(this)
    if (deferred === undefined) {
      deferred = new Map()
      guard.pending.set(this, deferred)
    }
    deferred.set(name, { value, priority: priority === undefined ? '' : priority })
    return
  }
}

function rsGuardEnd() {
  const guard = rsWriteGuard
  if (guard === null) return
  rsWriteGuard = null
  guard.proto.setProperty = guard.original
  for (const [target, perTarget] of guard.pending) {
    for (const [name, entry] of perTarget) {
      try { guard.original.call(target, name, entry.value, entry.priority) } catch (error) {}
    }
  }
}
let rsFrozen = []
let rsFrame = 0
let rsStyle = null

function rsThaw() {
  for (const item of rsFrozen) {
    item.element.removeAttribute('data-daf-resize-frozen')
    if (item.value === '') item.element.style.removeProperty('--daf-resize-height')
    else item.element.style.setProperty('--daf-resize-height', item.value, item.priority)
  }
  rsFrozen = []
}

function rsBegin(event) {
  if (event.button !== 0 || !(event.target instanceof Element) || rsDrag !== null) return
  const handle = event.target.closest('[data-side="sidebar"], [data-side="rightbar"], [data-width-handle]')
  if (handle === null) return
  if (rsFrame !== 0) { window.cancelAnimationFrame(rsFrame); rsFrame = 0 }
  rsDrag = { pointerId: event.pointerId, handle, width: handle.hasAttribute('data-width-handle') }
  rsGuardBegin()
  document.documentElement.setAttribute('data-daf-resizing', '')
  if (hlTimer !== 0) { window.clearTimeout(hlTimer); hlTimer = 0 }
  if (sfObserver !== null) sfRefresh()
  const reads = []
  const viewport = window.innerHeight
  for (const scope of document.querySelectorAll('[data-conversation-region="chat"]')) {
    // One layout flush for the whole transcript, then read every row's box.
    for (const element of scope.querySelectorAll('[data-chat-flow-key]')) {
      // Group seats contain leaf seats; freezing a group would hide visible descendants.
      if (element.querySelector('[data-chat-flow-key]') !== null) continue
      const rect = element.getBoundingClientRect()
      // Keep every row that can still be seen; cull the rest so a width change
      // only restyles what is on screen. Frozen rows keep their old height, so
      // no line of text is visible while it is stale.
      if (rect.height <= 0 || (rect.bottom > 0 && rect.top < viewport)) continue
      reads.push({ element, height: rect.height, value: element.style.getPropertyValue('--daf-resize-height'),
        priority: element.style.getPropertyPriority('--daf-resize-height') })
    }
  }
  // Finish every geometry read before changing any styles.
  for (const item of reads) {
    item.element.style.setProperty('--daf-resize-height', item.height + 'px')
    item.element.setAttribute('data-daf-resize-frozen', '')
  }
  rsFrozen = reads
}

function rsEnd() {
  if (rsFrame !== 0) window.cancelAnimationFrame(rsFrame)
  rsFrame = 0
  if (rsDrag === null) return
  rsDrag = null
  // Apply the final width while the rows are still frozen, then restore them.
  rsGuardEnd()
  rsThaw()
  document.documentElement.removeAttribute('data-daf-resizing')
  if (sfObserver !== null) sfRefresh()
  hlSchedule(100)
}

function rsPointerEnd(event) {
  if (rsDrag === null || event.pointerId !== rsDrag.pointerId || rsFrame !== 0) return
  rsFrame = window.requestAnimationFrame(rsEnd)
}

function rsOnScroll(event) {
  // A width change makes the host adjust scrollTop, which fires scroll events
  // mid-drag. Thawing everything there dropped the freeze for the rest of the
  // drag (measured: 152 frozen rows -> 0 after one anchoring scroll). Restore
  // only the rows the viewport actually reached.
  if (rsDrag === null || rsFrozen.length === 0) return
  if (!(event.target instanceof Element) || event.target.closest(SF_SCOPE) === null) return
  const viewport = window.innerHeight
  const keep = []
  for (const item of rsFrozen) {
    const rect = item.element.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > 0 && rect.top < viewport) {
      item.element.removeAttribute('data-daf-resize-frozen')
      if (item.value === '') item.element.style.removeProperty('--daf-resize-height')
      else item.element.style.setProperty('--daf-resize-height', item.value, item.priority)
    } else {
      keep.push(item)
    }
  }
  rsFrozen = keep
}

function rsVisibility() {
  if (document.hidden) rsEnd()
}

function rsInstall() {
  rsStyle = document.createElement('style')
  rsStyle.dataset.pluginCss = 'dsh-anthropic-fonts-resize'
  rsStyle.textContent = '[data-daf-resize-frozen] { height: var(--daf-resize-height) !important; box-sizing: border-box !important; min-height: 0 !important; max-height: none !important; overflow: clip !important; content-visibility: hidden !important; }'
  document.head.appendChild(rsStyle)
  document.addEventListener('pointerdown', rsBegin, true)
  document.addEventListener('pointerup', rsPointerEnd, true)
  document.addEventListener('pointercancel', rsPointerEnd, true)
  document.addEventListener('lostpointercapture', rsPointerEnd, true)
  document.addEventListener('scroll', rsOnScroll, true)
  window.addEventListener('blur', rsEnd)
  document.addEventListener('visibilitychange', rsVisibility)
}

function rsStop() {
  document.removeEventListener('pointerdown', rsBegin, true)
  document.removeEventListener('pointerup', rsPointerEnd, true)
  document.removeEventListener('pointercancel', rsPointerEnd, true)
  document.removeEventListener('lostpointercapture', rsPointerEnd, true)
  document.removeEventListener('scroll', rsOnScroll, true)
  window.removeEventListener('blur', rsEnd)
  document.removeEventListener('visibilitychange', rsVisibility)
  rsEnd()
  if (rsStyle !== null) rsStyle.remove()
  rsStyle = null
}
// #endregion resize

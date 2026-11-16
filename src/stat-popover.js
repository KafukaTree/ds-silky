// CSS anchored portals can inherit scroll deltas from a sticky composer's
// scroller even while the trigger stays still. Own only stat-dialog geometry;
// the host still owns opening, dismissal, content, and conversation scrolling.
const SP_VARS = ['--daf-stat-left', '--daf-stat-top', '--daf-stat-height']
let spPanels = new Map()
let spObserver = null
let spStyle = null
let spRaf = 0

function spName(panel) {
  return panel.style.positionAnchor || panel.style.getPropertyValue('--dsh-model-anchor')
}

function spAnchor(name) {
  const matches = [...document.querySelectorAll('[style*="anchor-name"], [style*="--dsh-model-anchor"] button[aria-haspopup="menu"]')]
    .filter(node => (node.style.anchorName || getComputedStyle(node).anchorName) === name)
  return matches.find(node => node.querySelector('[aria-expanded="true"]')) ?? matches[0] ?? null
}

function spRelease(panel, entry) {
  panel.removeAttribute('data-daf-stat-position')
  for (const [key, value, priority] of entry.saved) {
    if (value) panel.style.setProperty(key, value, priority)
    else panel.style.removeProperty(key)
  }
  spPanels.delete(panel)
}

function spPlace(panel, entry) {
  const name = spName(panel)
  if (!entry.anchor.isConnected || entry.name !== name) {
    const anchor = spAnchor(name)
    if (anchor === null) { spRelease(panel, entry); return }
    entry.anchor = anchor
    entry.name = name
  }
  const view = window.visualViewport
  const left = (view?.offsetLeft ?? 0) + 12
  const right = (view?.offsetLeft ?? 0) + (view?.width ?? document.documentElement.clientWidth) - 12
  const height = view?.height ?? window.innerHeight
  const bottom = (view?.offsetTop ?? 0) + height - 12
  const set = (key, value) => {
    const next = value + 'px'
    if (panel.style.getPropertyValue(key) !== next) panel.style.setProperty(key, next)
  }
  // Resolve the host's calc() inset through a length-valued CSS property;
  // model cards keep a separate, smaller max-height cap.
  set('--daf-stat-height', Math.max(0, height - 12))
  const top = (view?.offsetTop ?? 0) + Number.parseFloat(getComputedStyle(panel).scrollMarginTop)
  const anchor = entry.anchor.getBoundingClientRect()
  const box = panel.getBoundingClientRect()
  let y = anchor.top - entry.gap - box.height
  if (y < top && anchor.bottom + entry.gap + box.height <= bottom) y = anchor.bottom + entry.gap
  const x = entry.model || panel.getAttribute('data-anchor-align') === 'end' ? anchor.right - box.width : anchor.left
  set('--daf-stat-left', Math.max(left, Math.min(x, right - box.width)))
  set('--daf-stat-top', Math.max(top, Math.min(y, bottom - box.height)))
}

function spUpdate() {
  for (const [panel, entry] of spPanels) {
    if (!panel.isConnected) spRelease(panel, entry)
    else spPlace(panel, entry)
  }
}

function spTick() {
  spRaf = 0
  spUpdate()
  // Two geometry reads per open panel; no transcript scan or work while closed.
  if (spPanels.size) spRaf = requestAnimationFrame(spTick)
}

function spDiscover(panel) {
  if (!(panel instanceof Element) || spPanels.has(panel)) return
  const name = spName(panel)
  const dialog = panel.matches('[role="dialog"]')
  const stat = dialog && name?.startsWith('--dsh-stat-') && panel.querySelector('[data-turn-usage-details], [data-session-stats-details], [data-session-stats-usage]')
  const context = dialog && name?.startsWith('--dsh-context-')
  const menu = name?.startsWith('--dsh-menu-trigger-') && panel.matches('[role="menu"][data-menu-material="translucent"][data-anchor-side="top"]:not([data-context-menu]):not([data-match-anchor-width])')
  const model = name?.startsWith('--dsh-model-') && panel.matches('[data-menu-material="translucent"]')
  if (!stat && !context && !menu && !model) return
  const anchor = spAnchor(name)
  // Only composer context/menus need this repair; unrelated menus/submenus
  // keep their host placement and anchor chains.
  if (anchor === null || (!stat && !anchor.closest('[data-composer-seat]'))) return
  const entry = { name, anchor, model, gap: menu ? 4 : 8, saved: SP_VARS.map(key => [key, panel.style.getPropertyValue(key), panel.style.getPropertyPriority(key)]) }
  spPanels.set(panel, entry)
  panel.setAttribute('data-daf-stat-position', model ? 'model' : '')
  spPlace(panel, entry)
  if (!spRaf) spRaf = requestAnimationFrame(spTick)
}

function spInstall() {
  spStyle = document.createElement('style')
  spStyle.dataset.pluginCss = 'dsh-anthropic-fonts-stat-position'
  spStyle.textContent = `[data-daf-stat-position] {
    position: fixed !important;
    position-anchor: auto !important;
    position-area: none !important;
    position-try-fallbacks: none !important;
    inset: auto !important;
    left: var(--daf-stat-left) !important;
    top: var(--daf-stat-top) !important;
    scroll-margin-top: max(12px, var(--dsh-frame-overlay-top, 12px)) !important;
    max-height: max(0px, min(var(--daf-stat-cap, 100dvh), calc(var(--daf-stat-height) - max(12px, var(--dsh-frame-overlay-top, 12px))))) !important;
    align-self: auto !important;
    justify-self: auto !important;
  }
  [data-daf-stat-position="model"] { --daf-stat-cap: min(360px, calc(100dvh - 96px)); }`
  document.head.append(spStyle)
  for (const child of document.body.children) spDiscover(child)
  // Both host statistics components portal directly to body. Observe that
  // boundary, not streamed text or the plugin's own positioning properties.
  spObserver = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) spDiscover(node)
    spUpdate()
  })
  spObserver.observe(document.body, { childList: true })
}

function spStop() {
  spObserver?.disconnect()
  spObserver = null
  if (spRaf) cancelAnimationFrame(spRaf)
  spRaf = 0
  for (const [panel, entry] of spPanels) spRelease(panel, entry)
  spStyle?.remove()
  spStyle = null
}

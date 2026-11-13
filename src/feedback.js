/* Copy buttons give no confirmation. The terminal card's is a bare
   <button>复制</button> that never changes; the code block's is an icon
   with no state either. A click that copied nothing looks exactly like
   one that worked. The host owns the handler, so the confirmation is
   ours: flip the glyph to a check for 1.2s. */
let copyTimer = 0
let copyButton = null

function clearCopyFeedback() {
  if (copyTimer !== 0) window.clearTimeout(copyTimer)
  copyTimer = 0
  if (copyButton !== null) copyButton.classList.remove('dsh-copied')
  copyButton = null
}

function copyInstall() {
  document.addEventListener('click', onCopyClick, true)
}

function copyStop() {
  document.removeEventListener('click', onCopyClick, true)
  clearCopyFeedback()
}

function onCopyClick(event) {
  const target = event.target
  if (target === null || target === undefined || typeof target.closest !== 'function') return
  const button = target.closest('@host(terminal.copyButton.contains), @host(codeToolbar.action.contains)')
  if (button === null) return
  // The host wrap toggle exposes aria-pressed, independent of UI language.
  if (button.hasAttribute('aria-pressed')) return
  if ((button.getAttribute('aria-label') || '') === '自动换行') return
  clearCopyFeedback()
  copyButton = button
  void button.offsetWidth
  button.classList.add('dsh-copied')
  copyTimer = window.setTimeout(clearCopyFeedback, 1200)
}

/* File-type glyphs on the deliverables card tile are chosen by the child
   svg's class, which CSS cannot read without :has(); a single :has() rule
   makes every class change recalc the whole document (measured 135 ms on
   the 7.4k-node transcript). Mirror the kind onto the tile once, at mount,
   and let the stylesheet key on the attribute. */
const TAG_TILE_SELECTOR = 'span@host(fileCard.fileIcon.exact):not([data-daf-icon])'
let tagObserver = null

function tagTile(tile) {
  if (tile === null || tile === undefined || tile.hasAttribute('data-daf-icon')) return
  const svg = tile.firstElementChild
  if (svg === null || svg === undefined || String(svg.tagName).toLowerCase() !== 'svg') return
  const className = svg.getAttribute('class') || ''
  const kind = className.indexOf('@host(fileGlyph.image.fragment)') !== -1 ? 'image'
    : className.indexOf('@host(fileGlyph.html.fragment)') !== -1 ? 'html'
      : className.indexOf('@host(fileGlyph.code.fragment)') !== -1 ? 'code'
        : ''
  if (kind !== '') tile.setAttribute('data-daf-icon', kind)
}

function tagFileIcons(root) {
  if (root === null || root === undefined || root.nodeType !== 1) return
  if (typeof root.matches === 'function' && root.matches(TAG_TILE_SELECTOR)) tagTile(root)
  if (typeof root.querySelectorAll !== 'function') return
  for (const tile of root.querySelectorAll(TAG_TILE_SELECTOR)) tagTile(tile)
}

function tagObserve() {
  if (tagObserver !== null) return
  tagFileIcons(document.body)
  tagObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue
        const tile = typeof added.closest === 'function' ? added.closest(TAG_TILE_SELECTOR) : null
        if (tile !== null) tagTile(tile)
        else if (added.firstElementChild !== null) tagFileIcons(added)
      }
    }
  })
  tagObserver.observe(document.body, { childList: true, subtree: true })
}

function tagStop() {
  if (tagObserver !== null) {
    tagObserver.disconnect()
    tagObserver = null
  }
}

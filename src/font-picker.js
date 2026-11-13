const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.6 7.4 5.5 10.3 11.4 4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const TEXT = {
  zh: { reset: '恢复默认', empty: '没有匹配的字体', list: '可选字体' },
  en: { reset: 'Reset to default', empty: 'No matching font', list: 'Available fonts' },
}

/* aria-labels the theme puts on the three font fields, per locale. */
const FONT_LABELS = new Set([
  '正文字体',
  '代码字体',
  '终端字体',
  '文本字体',
  'Text font',
  'Code font',
  'Terminal font',
  'Body font',
])

const state = {
  input: null,
  zh: true,
  query: '',
  openValue: '',
  active: -1,
  options: [],
}

let panel = null
let headTitle = null
let resetButton = null
let listBox = null
let rafPending = 0
let removalRaf = 0

/* The label the theme gives a font field, whether it sits on the input or
   on the control that wraps it. */
function labelOf(element) {
  if (!element || !element.getAttribute) return ''
  const own = (element.getAttribute('aria-label') || '').trim()
  if (own !== '') return own
  const owner = element.closest ? element.closest('[aria-label]') : null
  return owner === null ? '' : (owner.getAttribute('aria-label') || '').trim()
}

/* Resolve the event target to the theme's font-family text field, whichever
   element carries the label. */
function fontInputFrom(target) {
  const element = target && target.nodeType === 1 ? target : target && target.parentElement
  if (!element) return null
  if (element.tagName === 'INPUT' && FONT_LABELS.has(labelOf(element))) return element
  const owner = element.closest ? element.closest('[aria-label]') : null
  if (owner === null || !FONT_LABELS.has(labelOf(owner))) return null
  const input = owner.tagName === 'INPUT' ? owner : owner.querySelector('input')
  return input instanceof HTMLInputElement ? input : null
}

function text() {
  return state.zh ? TEXT.zh : TEXT.en
}

/* Caret of the host field; the field is focused whenever the menu is open. */
function caretOf(input) {
  const position = input.selectionStart
  return typeof position === 'number' ? position : input.value.length
}

function injectStyle() {
  let tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = STYLE_ID
    tag.dataset.pluginCss = STYLE_ID
    document.head.appendChild(tag)
  }
  if (tag.textContent !== CSS) tag.textContent = CSS
}

function ensurePanel() {
  if (panel !== null) return panel
  panel = document.createElement('div')
  panel.className = 'daf-panel'
  panel.id = PANEL_ID
  panel.hidden = true
  panel.setAttribute('role', 'presentation')

  const head = document.createElement('div')
  head.className = 'daf-head'
  headTitle = document.createElement('span')
  headTitle.className = 'daf-title'
  resetButton = document.createElement('button')
  resetButton.type = 'button'
  resetButton.className = 'daf-reset'
  resetButton.addEventListener('click', (event) => {
    event.preventDefault()
    resetValue()
  })
  head.appendChild(headTitle)
  head.appendChild(resetButton)

  listBox = document.createElement('div')
  listBox.className = 'daf-list'
  listBox.id = LISTBOX_ID
  listBox.setAttribute('role', 'listbox')
  listBox.setAttribute('tabindex', '-1')
  listBox.addEventListener('click', (event) => {
    const option = event.target && event.target.closest ? event.target.closest('.daf-opt') : null
    if (option === null) return
    event.preventDefault()
    const index = Number(option.dataset.index)
    const item = state.options[index]
    if (item) selectFamily(item.name)
  })
  listBox.addEventListener('pointermove', (event) => {
    const option = event.target && event.target.closest ? event.target.closest('.daf-opt') : null
    if (option === null) return
    const index = Number(option.dataset.index)
    if (index !== state.active) setActive(index, false)
  })

  panel.appendChild(head)
  panel.appendChild(listBox)
  /* Keep focus in the host field while the pointer is over the menu. */
  panel.addEventListener('pointerdown', (event) => event.preventDefault())
  document.body.appendChild(panel)
  return panel
}

function setInputAria(input, open) {
  if (open) {
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', LISTBOX_ID)
    if (listBox !== null) {
      listBox.setAttribute('aria-label', labelOf(input) + ' · ' + text().list)
    }
  } else {
    input.removeAttribute('aria-autocomplete')
    input.removeAttribute('aria-expanded')
    input.removeAttribute('aria-controls')
    input.removeAttribute('aria-activedescendant')
  }
}

function renderList() {
  ensurePanel()
  const query = normalizeQuery(state.query)
  const selected = state.input === null ? '' : currentFamily(state.input.value, caretOf(state.input))
  const fragment = document.createDocumentFragment()
  state.options = []
  let index = 0
  for (const group of GROUPS) {
    const items = []
    for (const name of group.items) {
      if (matches(name, query)) items.push(name)
    }
    if (items.length === 0) continue
    const title = document.createElement('div')
    title.className = 'daf-group-title'
    title.textContent = state.zh ? group.zh : group.en
    fragment.appendChild(title)
    for (const name of items) {
      const option = document.createElement('div')
      option.className = 'daf-opt'
      option.id = 'daf-opt-' + index
      option.dataset.index = String(index)
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', name === selected ? 'true' : 'false')

      const check = document.createElement('span')
      check.className = 'daf-check'
      check.innerHTML = CHECK_SVG

      const label = document.createElement('span')
      label.className = 'daf-name'
      label.textContent = name

      const preview = document.createElement('span')
      preview.className = 'daf-preview'
      preview.textContent = group.sample
      preview.style.fontFamily = quoteFamily(name)

      option.appendChild(check)
      option.appendChild(label)
      option.appendChild(preview)
      fragment.appendChild(option)
      state.options.push({ name, element: option })
      index += 1
    }
  }
  listBox.textContent = ''
  if (state.options.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'daf-empty'
    empty.textContent = text().empty
    listBox.appendChild(empty)
  } else {
    listBox.appendChild(fragment)
  }
  state.active = -1
}

function quoteFamily(name) {
  return GENERIC_SET.has(name.toLowerCase()) ? name : '"' + name.replace(/"/g, '') + '"'
}

function setActive(index, scroll) {
  if (index === state.active) {
    if (scroll) scrollActiveIntoView()
    return
  }
  const previous = state.options[state.active]
  if (previous) delete previous.element.dataset.active
  state.active = index
  const current = state.options[index]
  if (current) {
    current.element.dataset.active = 'true'
    if (state.input !== null) state.input.setAttribute('aria-activedescendant', current.element.id)
    if (scroll) scrollActiveIntoView()
  } else if (state.input !== null) {
    state.input.removeAttribute('aria-activedescendant')
  }
}

function scrollActiveIntoView() {
  const current = state.options[state.active]
  if (!current) return
  current.element.scrollIntoView({ block: 'nearest' })
}

function moveActive(delta) {
  if (state.options.length === 0) return
  let next = state.active + delta
  if (state.active === -1) next = delta > 0 ? 0 : state.options.length - 1
  if (next < 0) next = state.options.length - 1
  if (next >= state.options.length) next = 0
  setActive(next, true)
}

function layout() {
  if (panel === null || panel.hidden) return
  const input = state.input
  if (input === null || !input.isConnected) {
    closePanel()
    return
  }
  const rect = input.getBoundingClientRect()
  const vw = window.innerWidth || document.documentElement.clientWidth || 1024
  const vh = window.innerHeight || document.documentElement.clientHeight || 768
  const margin = 8
  const gap = 4
  if (rect.bottom < 0 || rect.top > vh) {
    closePanel()
    return
  }
  const width = Math.round(Math.min(Math.max(rect.width, 300), vw - margin * 2))
  panel.style.width = width + 'px'
  const spaceBelow = vh - margin - (rect.bottom + gap)
  const spaceAbove = rect.top - gap - margin
  const above = spaceBelow < 240 && spaceAbove > spaceBelow
  const available = Math.max(160, Math.min(430, above ? spaceAbove : spaceBelow))
  panel.style.maxHeight = Math.round(available) + 'px'
  const height = Math.round(panel.getBoundingClientRect().height)
  let top = above ? rect.top - gap - height : rect.bottom + gap
  top = Math.min(Math.max(top, margin), Math.max(margin, vh - margin - height))
  const left = Math.min(Math.max(rect.left, margin), Math.max(margin, vw - margin - width))
  panel.style.top = Math.round(top) + 'px'
  panel.style.left = Math.round(left) + 'px'
}

function openPanel(input, options) {
  const opts = options || {}
  ensurePanel()
  if (state.input !== null && state.input !== input) closePanel()
  state.input = input
  const label = labelOf(input)
  state.zh = CJK_RE.test(label)
  state.openValue = input.value
  state.query = ''
  input.removeAttribute('list')
  headTitle.textContent = label
  resetButton.textContent = text().reset
  resetButton.disabled = input.value.trim() === ''
  panel.hidden = false
  renderList()
  const selectedIndex = state.options.findIndex((item) => item.name === currentFamily(input.value, caretOf(input)))
  setActive(selectedIndex === -1 ? (opts.focusFirst === true ? 0 : -1) : selectedIndex, true)
  setInputAria(input, true)
  layout()
  if (removalRaf === 0) removalRaf = window.requestAnimationFrame(watchForRemoval)
}

function closePanel() {
  if (removalRaf !== 0) window.cancelAnimationFrame(removalRaf)
  removalRaf = 0
  if (panel === null || panel.hidden) return
  panel.hidden = true
  const input = state.input
  state.input = null
  state.options = []
  state.active = -1
  if (input !== null && input.isConnected) setInputAria(input, false)
}

function resetValue() {
  const input = state.input
  if (input === null) return
  closePanel()
  commitInput(input, '')
}

function selectFamily(name) {
  const input = state.input
  if (input === null) return
  const next = composeValue(input.value, caretOf(input), name)
  closePanel()
  commitInput(input, next)
}

/* The host field commits on blur (uncontrolled Input + key={persisted});
   writing the value and blurring reuses that path, normalization included. */
function commitInput(input, value) {
  if (!input.isConnected) return
  input.value = value
  if (document.activeElement === input) {
    input.blur()
  } else {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  }
}

function onPointerDown(event) {
  const target = event.target
  if (panel !== null && !panel.hidden) {
    if (panel.contains(target)) return
    if (target === state.input) {
      layout()
      return
    }
    closePanel()
  }
  const input = fontInputFrom(target)
  if (input === null) return
  openPanel(input)
}

function onInput(event) {
  const input = fontInputFrom(event.target)
  if (input === null || state.input !== input || panel === null || panel.hidden) return
  const value = input.value
  let query
  if (state.openValue !== '' && value.indexOf(state.openValue) === 0) {
    /* Typing continued from the value the field had when the menu opened
       (typically a persisted, quoted family): treat only the new tail as
       the filter, so the first keystroke does not filter against itself. */
    query = stripQuotes(value.slice(state.openValue.length))
  } else {
    query = segmentQuery(value, caretOf(input))
  }
  resetButton.disabled = value.trim() === ''
  if (query === state.query && state.options.length > 0) return
  state.query = query
  renderList()
  if (state.options.length > 0) setActive(0, true)
}

function onKeyDown(event) {
  if (event.isComposing || event.keyCode === 229) return
  const input = fontInputFrom(event.target)
  const open = input !== null && panel !== null && panel.hidden === false && state.input === input
  if (!open) {
    if (input !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      event.stopPropagation()
      openPanel(input, { focusFirst: true })
    }
    return
  }
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      event.stopPropagation()
      moveActive(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      event.stopPropagation()
      moveActive(-1)
      break
    case 'Home':
      event.preventDefault()
      event.stopPropagation()
      setActive(0, true)
      break
    case 'End':
      event.preventDefault()
      event.stopPropagation()
      setActive(state.options.length - 1, true)
      break
    case 'PageDown':
      event.preventDefault()
      event.stopPropagation()
      moveActive(5)
      break
    case 'PageUp':
      event.preventDefault()
      event.stopPropagation()
      moveActive(-5)
      break
    case 'Enter': {
      const item = state.options[state.active]
      if (item) {
        event.preventDefault()
        event.stopPropagation()
        selectFamily(item.name)
      }
      break
    }
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      closePanel()
      break
    case 'Tab':
      closePanel()
      break
    default:
      break
  }
}

function onFocusOut(event) {
  const input = fontInputFrom(event.target)
  if (input === null || state.input !== input) return
  const next = event.relatedTarget
  if (next !== null && panel !== null && panel.contains(next)) return
  closePanel()
}

function onScroll() {
  if (panel === null || panel.hidden) return
  if (rafPending !== 0) return
  rafPending = window.requestAnimationFrame(() => {
    rafPending = 0
    layout()
  })
}

function watchForRemoval() {
  removalRaf = 0
  /* The settings page can unmount (or the field remount on commit) while
     the menu is open; a menu whose anchor is gone closes itself. */
  if (panel === null || panel.hidden) return
  if (state.input === null || !state.input.isConnected) {
    closePanel()
    return
  }
  removalRaf = window.requestAnimationFrame(watchForRemoval)
}

function fontPickerInstall() {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
}

function fontPickerStop() {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('input', onInput, true)
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('focusout', onFocusOut, true)
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  // Restore the anchor's ARIA state before discarding the input reference.
  closePanel()
  if (rafPending !== 0) window.cancelAnimationFrame(rafPending)
  rafPending = 0
  if (panel !== null) panel.remove()
  panel = null
  headTitle = null
  resetButton = null
  listBox = null
  state.input = null
  state.options = []
  state.active = -1
}

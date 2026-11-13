// #region highlight
/* Standard highlight path (handoff J, revised).

   The earlier revision carried its own regex tokenizer. It is gone: the
   application already ships shiki with 59 lazy-loaded grammars and a
   css-variables theme whose --shiki-token-* variables are the same palette
   markdown code blocks use. Plugins may require the app's shared modules,
   so the bridge below reuses the primitives hook (useCodeHighlighter) and
   paints exactly the tokens the host itself would paint: same engine,
   same scopes, same colours.

   What is left here is language detection. Tool output carries no
   language attribute, so it is inferred from the command, then from the
   content. null means "leave it plain" instead of guessing a colour. */
const HL_MAX_LINES = 2000
const HL_MAX_CHARS = 200000
const HL_LANG_ALIAS = {
  py: 'python',
  python: 'python',
  python3: 'python',
  py3: 'python',
  js: 'typescript',
  jsx: 'typescript',
  javascript: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  console: 'shellscript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  diff: 'diff',
  patch: 'diff',
  gitdiff: 'diff',
}

function hlLangName(value) {
  const name = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  if (name === '') return null
  if (HL_LANG_ALIAS[name] !== undefined) return HL_LANG_ALIAS[name]
  return null
}

function hlDetectFromText(text) {
  const head = text.slice(0, 4000)
  const trimmed = head.replace(/^\s+/, '')
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try {
      JSON.parse(text)
      return 'json'
    } catch (error) {
      /* not JSON: fall through to the other heuristics */
    }
  }
  if (/^(?:diff --git|@@ |\+\+\+ |--- )/m.test(head)) return 'diff'
  if (/^\s*(?:def|class)\s+[A-Za-z_]|^\s*(?:import|from)\s+[A-Za-z_][\w.]*\s*$/m.test(head)) return 'python'
  if (/\b(?:const|let|var|function)\s+[A-Za-z_$]|=>|console\.log/.test(head)) return 'typescript'
  if (/^\s*#!.*\b(?:ba|z)?sh\b/m.test(head)) return 'shellscript'
  return null
}

// #endregion highlight

// #region highlight-dom
/* Highlight structured inspect payloads only. Terminal commands and logs
   retain native neutral text / ANSI colours; an interpreter name does not
   describe the language of stdout. Markdown/code already use host shiki. */
const HL_ATTR = 'data-daf-hl'
const HL_SRC = 'data-daf-hl-src'
const HL_SKIP = 'data-daf-hl-skip'
const HL_DEBOUNCE_MS = 200
const HL_MAX_ELEMENTS = 400
const HL_SCOPES = [
  ['pre@host(inspectPayload.body.contains)', 'block'],
]
let hlObserver = null
let hlTimer = 0
let hlWrote = false
let hlBridgeBroken = false
let hlBridges = null
let hlRequire = null

function hlClock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function hlSignature(text) {
  return text.length + '|' + text.slice(-24)
}

/* One React bridge per language: the primitives hook hands back a function
   (text) => token lines, and re-runs its subscription whenever a grammar
   chunk finishes loading, which is our cue to repaint. */
function hlBridgeFor(lang) {
  if (hlBridgeBroken || hlRequire === null) return null
  if (hlBridges === null) hlBridges = new Map()
  const existing = hlBridges.get(lang)
  if (existing !== undefined) return existing
  let React = null
  let ReactDOM = null
  let primitives = null
  try {
    React = hlRequire('react')
    ReactDOM = hlRequire('react-dom/client')
    primitives = hlRequire('@deepseek-ai/dsh-client-ui-primitives')
  } catch (error) {
    hlBridgeBroken = true
    console.warn('[dsh-anthropic-fonts] shared modules unavailable; terminal output stays plain', error)
    return null
  }
  if (
    React === null ||
    React === undefined ||
    ReactDOM === null ||
    ReactDOM === undefined ||
    primitives === null ||
    primitives === undefined ||
    typeof primitives.useCodeHighlighter !== 'function' ||
    typeof ReactDOM.createRoot !== 'function'
  ) {
    hlBridgeBroken = true
    return null
  }
  const record = { ready: false, highlight: null, root: null }
  hlBridges.set(lang, record)
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.setAttribute('data-daf-hl-host', lang)
  function Bridge() {
    const highlight = primitives.useCodeHighlighter(lang)
    React.useEffect(() => {
      record.highlight = highlight
      record.ready = true
      hlSchedule(0)
    }, [highlight])
    return null
  }
  try {
    record.root = ReactDOM.createRoot(container)
    record.root.render(React.createElement(Bridge))
  } catch (error) {
    hlBridgeBroken = true
    hlBridges.delete(lang)
    return null
  }
  return record
}

function hlPaintTokens(el, lang) {
  const record = hlBridgeFor(lang)
  if (record === null || record.highlight === null) return
  const text = el.textContent === null ? '' : el.textContent
  let lines
  try {
    lines = record.highlight(text)
  } catch (error) {
    el.setAttribute(HL_ATTR, 'none')
    return
  }
  if (lines === undefined) {
    /* The grammar chunk is still loading: shiki resolves it lazily on the
       first request. Retry per element with backoff; the bridge's own
       store subscription also repaints as soon as the chunk lands, so this
       is only a safety net. */
    const tries = Number(el.getAttribute(HL_ATTR + '-try') === null ? '0' : el.getAttribute(HL_ATTR + '-try')) + 1
    el.setAttribute(HL_ATTR + '-try', String(tries))
    if (tries < 10) hlSchedule(400 + 400 * tries)
    else el.setAttribute(HL_ATTR, 'none')
    return
  }
  if (el.hasAttribute(HL_ATTR + '-try')) el.removeAttribute(HL_ATTR + '-try')
  const fragment = document.createDocumentFragment()
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) fragment.appendChild(document.createTextNode('\n'))
    const tokens = lines[index]
    for (let token = 0; token < tokens.length; token += 1) {
      const part = tokens[token]
      if (part.style !== undefined && part.style !== null && part.style.color !== undefined) {
        const span = document.createElement('span')
        span.style.color = part.style.color
        span.textContent = part.text
        fragment.appendChild(span)
      } else {
        fragment.appendChild(document.createTextNode(part.text))
      }
    }
  }
  el.replaceChildren(fragment)
  el.setAttribute(HL_SRC, hlSignature(text))
  el.setAttribute(HL_ATTR, lang)
  hlWrote = true
}

function hlLanguageOf(el, text) {
  const own = el.getAttribute('data-language')
  if (own !== null && own !== '' && hlLangName(own) !== null) return hlLangName(own)
  const owner = el.closest('[data-language]')
  if (owner !== null) {
    const value = owner.getAttribute('data-language')
    if (value !== null && value !== '' && hlLangName(value) !== null) return hlLangName(value)
  }
  return hlDetectFromText(text)
}

function hlApply(el, mode) {
  if (el.hasAttribute(HL_SKIP) || el.closest('[data-terminal]') !== null) return
  if (el.closest('@host(fragment.shiki.contains)') !== null) {
    el.setAttribute(HL_SKIP, 'shiki')
    return
  }
  const text = el.textContent === null ? '' : el.textContent
  if (text === '') return
  if (text.length > HL_MAX_CHARS) {
    el.setAttribute(HL_SKIP, 'chars')
    return
  }
  if (mode !== 'line' && text.indexOf('\n') !== -1 && text.split('\n').length > HL_MAX_LINES) {
    el.setAttribute(HL_SKIP, 'lines')
    return
  }
  /* A line that already carries element children is either model-styled
     (terminal segments keep their own colours) or our own earlier output. */
  if (mode === 'line' && el.childElementCount > 0) return
  const signature = hlSignature(text)
  if (el.getAttribute(HL_SRC) === signature) {
    if (el.getAttribute(HL_ATTR) === 'none') return
    if (el.querySelector('span[style]') !== null) return
  }
  const lang = hlLanguageOf(el, text)
  if (lang === null) {
    el.setAttribute(HL_ATTR, 'none')
    el.setAttribute(HL_SRC, signature)
    return
  }
  el.setAttribute(HL_SRC, signature)
  el.setAttribute(HL_ATTR, lang)
  hlPaintTokens(el, lang)
}

function hlScan() {
  hlTimer = 0
  if (rsDrag !== null) return
  hlWrote = false
  const deadline = hlClock() + 12
  let budget = HL_MAX_ELEMENTS
  for (const scope of HL_SCOPES) {
    for (const el of document.querySelectorAll(scope[0])) {
      if (budget <= 0 || hlClock() > deadline) {
        if (hlWrote) hlSchedule()
        return
      }
      budget -= 1
      hlApply(el, scope[1])
    }
  }
}

function hlSchedule(delay) {
  if (hlTimer !== 0) return
  hlTimer = window.setTimeout(() => {
    hlScan()
  }, typeof delay === 'number' ? delay : HL_DEBOUNCE_MS)
}

function hlObserve() {
  if (hlObserver !== null) return
  hlObserver = new MutationObserver(records => {
    if (rsDrag !== null) return
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement
      if (target !== null && target.closest('pre@host(inspectPayload.body.contains)') !== null) {
        hlSchedule()
        return
      }
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue
        if (added.matches('pre@host(inspectPayload.body.contains)') ||
            added.querySelector('pre@host(inspectPayload.body.contains)') !== null) {
          hlSchedule()
          return
        }
      }
    }
  })
  hlObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-running', 'data-body'],
  })
  hlSchedule()
}

function hlStop() {
  if (hlObserver !== null) {
    hlObserver.disconnect()
    hlObserver = null
  }
  if (hlTimer !== 0) {
    window.clearTimeout(hlTimer)
    hlTimer = 0
  }
  if (hlBridges !== null) {
    for (const record of hlBridges.values()) if (record.root !== null) record.root.unmount()
  }
  hlBridges = null
  hlRequire = null
}

function hlStatus() {
  const langs = []
  if (hlBridges !== null) {
    for (const entry of hlBridges) langs.push(entry[0] + ':' + (entry[1].highlight === null ? 'loading' : 'ready'))
  }
  return { bridge: hlBridgeBroken ? 'unavailable' : 'ok', langs }
}
// #endregion highlight-dom

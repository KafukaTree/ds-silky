    // #region has-freeze
    /* Any :has() rule in the document makes Blink invalidate the whole document
       when a subtree changes. Streaming appends and replaces text nodes, so each
       batch pays a full style recalculation (measured 88 ms on a 7.4k-node
       transcript). The rules belong to the host; while assistant output is live
       this lifts every :has() rule out of the active stylesheets and supplies
       the few chat layout rules those selectors carried. Everything is put back
       a beat after the last live row settles. */
    const HF_LIVE = '[data-streaming="true"], [data-variant="think"][data-state="running"], [data-trigger-menu], [data-context-menu], [role="menu"], [role="listbox"]'
    const HF_SETTLE_MS = 1200
    /* Replica of the five chat gap/empty-seat rules deleted with the :has()
       sweep. No :has() here: the point is a document with none. */
    const HF_CSS = `
[data-daf-has-freeze] :is([data-chat-flow], [data-slot="conversation.chat.flow"]) > :not([hidden]):not([data-text-interaction-surface]):not([data-daf-empty]):not([data-chat-flow-key]:empty) ~ :not([hidden]):not([data-text-interaction-surface]):not([data-daf-empty]):not([data-chat-flow-key]:empty) {
  margin-top: var(--dsh-chat-flow-gap, 4px);
}
[data-daf-has-freeze] [data-chat-flow-key][data-chat-group-part="response"] {
  --dsh-chat-flow-gap: 12px;
}
[data-daf-has-freeze] [data-chat-flow-kind="turn-process"] {
  --dsh-chat-flow-gap: 16px;
}
[data-daf-has-freeze] @host(fragment.running.contains) {
  --dsh-chat-flow-gap: 12px;
}
[data-daf-has-freeze] :is([data-chat-flow], [data-slot="conversation.chat.flow"]) > [data-chat-group-part="response"]:not([hidden]):not(:empty) + :not([hidden]):not([data-text-interaction-surface]):not([data-daf-empty]) {
  --dsh-chat-flow-gap: 12px;
}
[data-daf-has-freeze] [data-chat-history] + [data-slot="conversation.chat.flow"] > :not([hidden]):not([data-text-interaction-surface]):not([data-daf-empty]):not([data-chat-flow-key]:empty) {
  margin-top: var(--dsh-chat-flow-gap, 4px);
}
[data-daf-has-freeze] :is([data-chat-flow], [data-slot="conversation.chat.flow"]) > [data-chat-flow-kind="turn-process"] + :not([hidden]):not([data-text-interaction-surface]):not([data-daf-empty]):not([data-submission-echo], [data-pending-steering]):not(@host(fragment.running.contains)) {
  --dsh-chat-flow-gap: 16px;
}
[data-daf-has-freeze] [data-chat-flow-key][data-daf-gap="44"] {
  --dsh-chat-flow-gap: calc(44px + var(--dsh-content-font-delta, 0px));
}
[data-daf-has-freeze] [data-chat-flow-key][data-daf-empty] {
  height: 0;
}
[data-daf-has-freeze] [data-daf-header-plain] {
  min-height: 0px;
  padding-bottom: 10px;
}
[data-daf-has-freeze] [data-conversation-scroll] {
  overscroll-behavior-y: none;
}
[data-daf-has-freeze] [data-chat-following-tail] @host(fragment.scroll.contains),
[data-daf-has-freeze] [data-daf-following-tail] {
  overflow-anchor: none;
}
`
    let hfSaved = []
    let hfActive = false
    let hfInstalled = false
    let hfStyle = null
    let hfRaf = 0
    let hfTimer = 0
    let hfHeadObserver = null
    let hfRestored = 0
    let hfDirty = false

    function hfCollect(root, owner, list, path) {
      for (let index = list.length - 1; index >= 0; index--) {
        const rule = list[index]
        if (rule === undefined) continue
        if (rule.selectorText !== undefined) {
          if ((rule.cssText || '').indexOf(':has(') !== -1) {
            hfSaved.push({ root, path: path.slice(), index, text: rule.cssText })
            owner.deleteRule(index)
          }
        } else if (rule.cssRules !== undefined && rule.cssRules.length > 0) {
          hfCollect(root, rule, rule.cssRules, path.concat(index))
        }
      }
    }

    function hfSweep() {
      for (const sheet of document.styleSheets) {
        let rules
        try { rules = sheet.cssRules } catch (error) { continue }
        if (rules !== null) hfCollect(sheet, sheet, rules, [])
      }
      if (document.adoptedStyleSheets !== undefined) {
        for (const sheet of document.adoptedStyleSheets) {
          let rules
          try { rules = sheet.cssRules } catch (error) { continue }
          if (rules !== null) hfCollect(sheet, sheet, rules, [])
        }
      }
    }

    function hfOwner(root, path) {
      if (path.length === 0) return root
      let rule = root.cssRules[path[0]]
      for (let depth = 1; depth < path.length; depth++) {
        if (rule === undefined || rule.cssRules === undefined) return null
        rule = rule.cssRules[path[depth]]
      }
      return rule !== undefined && typeof rule.insertRule === 'function' ? rule : null
    }

    function hfRestore() {
      const groups = new Map()
      for (const item of hfSaved) {
        let list = groups.get(item.root)
        if (list === undefined) {
          list = []
          groups.set(item.root, list)
        }
        list.push(item)
      }
      for (const [root, items] of groups) {
        items.sort((a, b) => {
          if (a.path.length !== b.path.length) return a.path.length - b.path.length
          for (let depth = 0; depth < a.path.length; depth++) {
            if (a.path[depth] !== b.path[depth]) return a.path[depth] - b.path[depth]
          }
          return a.index - b.index
        })
        for (const item of items) {
          try {
            const owner = hfOwner(root, item.path)
            if (owner === null) continue
            owner.insertRule(item.text, Math.min(item.index, owner.cssRules.length))
            hfRestored++
          } catch (error) {
            /* A sheet or group the host replaced mid-stream: its rule is gone with it. */
          }
        }
      }
      hfSaved = []
    }

    function hfMarkElement(element) {
      if (!(element instanceof Element) || !element.hasAttribute('data-chat-flow-key')) return
      const node = element.querySelector(':scope > [data-slot="conversation.chat.node"]')
      const empty = element.childNodes.length === 0 || (node !== null && node.childNodes.length === 0)
      if (empty) element.setAttribute('data-daf-empty', '')
      else element.removeAttribute('data-daf-empty')
      if (node !== null && node.querySelector(':scope > [data-chat-steering-batch="start"]') !== null) {
        element.setAttribute('data-daf-gap', '44')
      } else {
        element.removeAttribute('data-daf-gap')
      }
    }

    function hfMarkAll() {
      for (const element of document.querySelectorAll('[data-chat-flow-key]')) hfMarkElement(element)
      const scroll = document.querySelector('[data-conversation-scroll]')
      if (scroll === null) return
      const root = scroll.querySelector('[data-chat-following-tail]') ?? document.querySelector('[data-chat-following-tail]')
      if (root !== null) scroll.setAttribute('data-daf-following-tail', '')
      else scroll.removeAttribute('data-daf-following-tail')
      const header = document.querySelector('[data-slot="conversation.header"] > [data-window-drag]')
      if (header !== null && header.querySelector('@host(fragment.tabs.contains)') === null) header.setAttribute('data-daf-header-plain', '')
      else if (header !== null) header.removeAttribute('data-daf-header-plain')
    }

    function hfStart() {
      if (hfActive) return
      hfActive = true
      hfRestored = 0
      hfStyle = document.createElement('style')
      hfStyle.dataset.pluginCss = 'dsh-anthropic-fonts-has-freeze'
      hfStyle.textContent = HF_CSS
      document.head.appendChild(hfStyle)
      document.documentElement.setAttribute('data-daf-has-freeze', '')
      hfMarkAll()
      hfSweep()
      hfHeadObserver = new MutationObserver(() => hfSweep())
      hfHeadObserver.observe(document.head, { childList: true })
    }

    function hfStop() {
      if (!hfActive) return
      hfActive = false
      if (hfHeadObserver !== null) {
        hfHeadObserver.disconnect()
        hfHeadObserver = null
      }
      hfRestore()
      if (hfStyle !== null) {
        hfStyle.remove()
        hfStyle = null
      }
      document.documentElement.removeAttribute('data-daf-has-freeze')
      for (const element of document.querySelectorAll('[data-daf-empty], [data-daf-gap], [data-daf-following-tail], [data-daf-header-plain]')) {
        element.removeAttribute('data-daf-empty')
        element.removeAttribute('data-daf-gap')
        element.removeAttribute('data-daf-following-tail')
        element.removeAttribute('data-daf-header-plain')
      }
      if (sfActive.size === 0) sfSetRules(false)
    }

    function hfOnTrigger(event) {
      if (!hfInstalled || (event.button !== 0 && event.button !== 2)) return
      const target = event.target instanceof Element ? event.target : null
      if (target === null) return
      if (target.closest('[aria-haspopup], [data-trigger-menu], [data-context-menu]') === null) return
      if (!hfActive) hfStart()
      hfSchedule()
    }

    function hfOnKeyTrigger(event) {
      if (!hfInstalled || (event.key !== 'Enter' && event.key !== ' ')) return
      const target = document.activeElement
      if (!(target instanceof Element)) return
      if (target.closest('[aria-haspopup], [data-trigger-menu]') === null) return
      if (!hfActive) hfStart()
      hfSchedule()
    }

    function hfCheck() {
      if (!hfInstalled) return
      if (document.querySelector(HF_LIVE) !== null) {
        if (hfTimer !== 0) {
          window.clearTimeout(hfTimer)
          hfTimer = 0
        }
        if (!hfActive) hfStart()
      } else if (hfActive && hfTimer === 0) {
        hfTimer = window.setTimeout(() => {
          hfTimer = 0
          if (document.querySelector(HF_LIVE) === null) hfStop()
        }, HF_SETTLE_MS)
      }
    }

    function hfSchedule() {
      if (!hfInstalled || hfRaf !== 0) return
      hfRaf = window.requestAnimationFrame(() => {
        hfRaf = 0
        hfCheck()
        if (hfActive && hfDirty) {
          hfDirty = false
          hfMarkAll()
        }
      })
    }

    function hfOnMutations(records) {
      if (!hfActive) return
      for (const record of records) {
        if (record.type !== 'childList') continue
        hfDirty = true
        for (const added of record.addedNodes) {
          if (added.nodeType === 1 && (added.nodeName === 'STYLE' || added.nodeName === 'LINK')) hfSweep()
        }
      }
    }

    function hfInstall() {
      hfInstalled = true
      document.addEventListener('pointerdown', hfOnTrigger, true)
      document.addEventListener('keydown', hfOnKeyTrigger, true)
      hfCheck()
      sfSetRules(document.querySelector(SF_LIVE) !== null)
      hfSchedule()
    }

    function hfDispose() {
      hfInstalled = false
      document.removeEventListener('pointerdown', hfOnTrigger, true)
      document.removeEventListener('keydown', hfOnKeyTrigger, true)
      if (hfRaf !== 0) {
        window.cancelAnimationFrame(hfRaf)
        hfRaf = 0
      }
      if (hfTimer !== 0) {
        window.clearTimeout(hfTimer)
        hfTimer = 0
      }
      hfStop()
    }

    function hfStatus() {
      return { active: hfActive, saved: hfSaved.length, restored: hfRestored,
        marked: document.documentElement.hasAttribute('data-daf-has-freeze') }
    }
    // #endregion has-freeze

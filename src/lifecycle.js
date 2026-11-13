/* The only assembly point. Features retain their own resource cleanup.
   HMR must stop the previous instance before installing another one. */
const GLOBAL_KEY = '__dshAnthropicFonts'
let started = false

function dispose() {
  if (!started) return
  fontPickerStop()
  copyStop()
  // End a drag FIRST: rsEnd may resume highlighter/stream work. Stop those
  // consumers afterwards, otherwise disposal can accidentally restart them.
  rsStop()
  scStop()
  hlStop()
  // Stream owns the shared mutation observer; sfStop also disposes has-freeze.
  sfStop()
  tagStop()
  const style = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
  if (style !== null) style.remove()
  started = false
  const owner = window[GLOBAL_KEY]
  if (owner !== undefined && owner !== null && owner.dispose === dispose) delete window[GLOBAL_KEY]
}

function start(ctx) {
  if (started) return
  const previous = window[GLOBAL_KEY]
  if (previous !== undefined && previous !== null && typeof previous.dispose === 'function') {
    try {
      previous.dispose()
    } catch (error) {
      /* A half-built previous instance must not block this one. */
    }
  }
  const stale = document.getElementById(PANEL_ID)
  if (stale !== null) stale.remove()
  started = true
  window[GLOBAL_KEY] = { dispose, highlightStatus: hlStatus, streamFadeStatus: sfStatus, setStreamFadeEnabled: sfSetEnabled, hasFreezeStatus: hfStatus, scrollCullStatus: scStatus, setScrollCullEnabled: scSetEnabled, refreshScrollCull: scRefresh }
  injectStyle()
  const legacy = document.getElementById(LEGACY_DATALIST_ID)
  if (legacy !== null) legacy.remove()
  for (const input of document.querySelectorAll('input[list="' + LEGACY_DATALIST_ID + '"]')) {
    input.removeAttribute('list')
  }
  fontPickerInstall()
  copyInstall()
  hlRequire = require
  hlObserve()
  tagObserve()
  sfInstall()
  hfInstall()
  rsInstall()
  scInstall()
  if (ctx !== undefined && typeof ctx.effect === 'function') ctx.effect(() => dispose)
}

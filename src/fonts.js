/* Installed font families on this machine, captured at install time.
   Anthropic first, then alphabetical, then the CSS generic families. */
const FONT_FAMILIES = [
  "Anthropic Sans",
  "Anthropic Serif",
  "Academy Engraved LET",
  "Al Bayan",
  "Al Nile",
  "Al Tarikh",
  "American Typewriter",
  "Andale Mono",
  "Apple Braille",
  "Apple Chancery",
  "Apple Color Emoji",
  "Apple SD Gothic Neo",
  "Apple Symbols",
  "AppleGothic",
  "AppleMyungjo",
  "Arial",
  "Arial Black",
  "Arial Hebrew",
  "Arial Hebrew Scholar",
  "Arial Narrow",
  "Arial Rounded MT Bold",
  "Arial Unicode MS",
  "Artifakt Element",
  "Avenir",
  "Avenir Next",
  "Avenir Next Condensed",
  "Ayuthaya",
  "Baghdad",
  "Bangla MN",
  "Bangla Sangam MN",
  "Baskerville",
  "Beirut",
  "Big Caslon",
  "Bodoni 72",
  "Bodoni 72 Oldstyle",
  "Bodoni 72 Smallcaps",
  "Bodoni Ornaments",
  "Bradley Hand",
  "Brush Script MT",
  "Chalkboard",
  "Chalkboard SE",
  "Chalkduster",
  "Charter",
  "Cochin",
  "Comic Sans MS",
  "Copperplate",
  "Corsiva Hebrew",
  "Courier New",
  "Damascus",
  "DecoType Naskh",
  "Devanagari MT",
  "Devanagari Sangam MN",
  "Didot",
  "DIN Alternate",
  "DIN Condensed",
  "Diwan Kufi",
  "Diwan Thuluth",
  "Euphemia UCAS",
  "Farah",
  "Farisi",
  "Futura",
  "Galvji",
  "GB18030 Bitmap",
  "Geeza Pro",
  "Geneva",
  "Georgia",
  "Gill Sans",
  "Grantha Sangam MN",
  "Gujarati MT",
  "Gujarati Sangam MN",
  "Gurmukhi MN",
  "Gurmukhi MT",
  "Gurmukhi Sangam MN",
  "Helvetica",
  "Helvetica Neue",
  "Herculanum",
  "Hiragino Maru Gothic ProN",
  "Hiragino Mincho ProN",
  "Hiragino Sans",
  "Hoefler Text",
  "Impact",
  "InaiMathi",
  "ITF Devanagari",
  "ITF Devanagari Marathi",
  "Kailasa",
  "Kannada MN",
  "Kannada Sangam MN",
  "Kefa III",
  "Khmer MN",
  "Khmer Sangam MN",
  "Kohinoor Bangla",
  "Kohinoor Devanagari",
  "Kohinoor Gujarati",
  "Kohinoor Telugu",
  "Kokonor",
  "Krungthep",
  "KufiStandardGK",
  "Lao MN",
  "Lao Sangam MN",
  "Lucida Grande",
  "Luminari",
  "Malayalam MN",
  "Malayalam Sangam MN",
  "Marker Felt",
  "Menlo",
  "Microsoft Sans Serif",
  "Mishafi",
  "Mishafi Gold",
  "Monaco",
  "Mshtakan",
  "Mukta Mahee",
  "Muna",
  "Myanmar MN",
  "Myanmar Sangam MN",
  "Nadeem",
  "New Peninim MT",
  "Noteworthy",
  "Noto Nastaliq Urdu",
  "Noto Sans Batak",
  "Noto Sans Kannada",
  "Noto Sans Myanmar",
  "Noto Sans NKo",
  "Noto Sans Oriya",
  "Noto Sans Syriac",
  "Noto Sans Tagalog",
  "Noto Serif Myanmar",
  "Optima",
  "Oriya MN",
  "Oriya Sangam MN",
  "Palatino",
  "Papyrus",
  "Party LET",
  "Phosphate",
  "Plantagenet Cherokee",
  "PT Mono",
  "PT Sans",
  "PT Sans Caption",
  "PT Sans Narrow",
  "PT Serif",
  "PT Serif Caption",
  "Raanana",
  "Rockwell",
  "Sana",
  "Sathu",
  "Savoye LET",
  "Shree Devanagari 714",
  "SignPainter",
  "Silom",
  "Sinhala MN",
  "Sinhala Sangam MN",
  "Skia",
  "Snell Roundhand",
  "STIX Two Math",
  "STIX Two Text",
  "Sukhumvit Set",
  "Symbol",
  "Tahoma",
  "Tamil MN",
  "Tamil Sangam MN",
  "Telugu MN",
  "Telugu Sangam MN",
  "Thonburi",
  "Times New Roman",
  "Trattatello",
  "Trebuchet MS",
  "Verdana",
  "Waseem",
  "Webdings",
  "Wingdings",
  "Wingdings 2",
  "Wingdings 3",
  "Zapf Dingbats",
  "Zapfino",
  "冬青黑体简体中文",
  "华文仿宋",
  "华文宋体",
  "华文楷体",
  "华文黑体",
  "宋体-简",
  "宋体-繁",
  "楷体-简",
  "楷体-繁",
  "系统字体",
  "苹方-港",
  "苹方-澳",
  "苹方-简",
  "苹方-繁",
  "黑体-简",
  "黑体-繁",
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
]

/* Families worth one click: the plugin's own faces first, then the system
   faces that read best in this UI. Each one is lifted out of its category
   group so the list has no duplicates. */
const RECOMMENDED = [
  'Anthropic Sans',
  'Anthropic Serif',
  '系统字体',
  '苹方-简',
  'Helvetica Neue',
  'Georgia',
  'Menlo',
]

const SANS = [
  'Arial',
  'Arial Black',
  'Arial Narrow',
  'Arial Rounded MT Bold',
  'Avenir',
  'Avenir Next',
  'Avenir Next Condensed',
  'Futura',
  'Geneva',
  'Gill Sans',
  'Helvetica',
  'Hiragino Sans',
  'Lucida Grande',
  'Microsoft Sans Serif',
  'Optima',
  'PT Sans',
  'PT Sans Caption',
  'PT Sans Narrow',
  'Skia',
  'Tahoma',
  'Trebuchet MS',
  'Verdana',
  'Apple SD Gothic Neo',
  'AppleGothic',
]

const SERIF = [
  'Baskerville',
  'Big Caslon',
  'Bodoni 72',
  'Bodoni 72 Oldstyle',
  'Charter',
  'Cochin',
  'Didot',
  'Hoefler Text',
  'Palatino',
  'PT Serif',
  'PT Serif Caption',
  'STIX Two Text',
  'Times New Roman',
]

const MONO = ['Andale Mono', 'Courier New', 'Monaco', 'PT Mono']

/* CSS Fonts keywords: valid values, never quoted. */
const GENERIC = [
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  '-apple-system',
]

const GROUP_DEFS = [
  { id: 'recommended', zh: '常用', en: 'Common', sample: 'Aa' },
  { id: 'sans', zh: '无衬线', en: 'Sans serif', sample: 'Aa' },
  { id: 'serif', zh: '衬线', en: 'Serif', sample: 'Aa' },
  { id: 'mono', zh: '等宽', en: 'Monospace', sample: 'abc' },
  { id: 'cjk', zh: '中文', en: 'Chinese', sample: '永' },
  { id: 'generic', zh: '通用族', en: 'Generic', sample: 'Aa' },
  { id: 'other', zh: '其他', en: 'Other', sample: 'Aa' },
]

const CJK_RE = /[\u3400-\u9fff]/
const GENERIC_SET = new Set(GENERIC)
const COLLATOR = new Intl.Collator(['zh-Hans-CN', 'en'], {
  sensitivity: 'base',
  numeric: true,
})

function classify(name) {
  if (RECOMMENDED.indexOf(name) !== -1) return 'recommended'
  if (GENERIC_SET.has(name.toLowerCase())) return 'generic'
  if (MONO.indexOf(name) !== -1) return 'mono'
  if (SERIF.indexOf(name) !== -1) return 'serif'
  if (SANS.indexOf(name) !== -1) return 'sans'
  if (CJK_RE.test(name)) return 'cjk'
  return 'other'
}

/* Grouped, sorted, de-duplicated option catalogue, built once. */
const GROUPS = (() => {
  const buckets = new Map()
  for (const def of GROUP_DEFS) buckets.set(def.id, [])
  for (const name of FONT_FAMILIES) buckets.get(classify(name)).push(name)
  for (const name of GENERIC) {
    if (buckets.get('generic').indexOf(name) === -1) buckets.get('generic').push(name)
  }
  const groups = []
  for (const def of GROUP_DEFS) {
    const items = buckets.get(def.id)
    items.sort(COLLATOR.compare)
    if (items.length === 0) continue
    groups.push({ id: def.id, zh: def.zh, en: def.en, sample: def.sample, items })
  }
  return groups
})()

/* Free-text value helpers. The host field holds a comma-separated
   font-family list; everything here is quote/whitespace tolerant. */
function stripQuotes(value) {
  return value.replace(/["']/g, '').replace(/\s+/g, ' ').trim()
}

/* The comma-delimited family segment around the caret. Leading separator
   whitespace belongs to the list, not to the segment. */
function segmentAt(value, caret) {
  const raw = typeof caret === 'number' && caret >= 0 ? Math.min(caret, value.length) : value.length
  let start = 0
  for (let i = raw - 1; i >= 0; i -= 1) {
    if (value.charAt(i) === ',') {
      start = i + 1
      break
    }
  }
  let end = value.length
  for (let i = Math.max(raw, start); i < value.length; i += 1) {
    if (value.charAt(i) === ',') {
      end = i
      break
    }
  }
  while (start < end && (value.charAt(start) === ' ' || value.charAt(start) === '\t')) start += 1
  return { start, end }
}

/* The segment being edited, un-quoted and trimmed. */
function segmentQuery(value, caret) {
  const bounds = segmentAt(value, caret)
  return stripQuotes(value.slice(bounds.start, bounds.end))
}

/* The family occupying the caret's segment, un-quoted. */
function currentFamily(value, caret) {
  const bounds = segmentAt(value, caret)
  return stripQuotes(value.slice(bounds.start, bounds.end))
}

/* Replace only the segment around the caret, keeping the other fallbacks. */
function composeValue(value, caret, family) {
  const bounds = segmentAt(value, caret)
  let head = value.slice(0, bounds.start)
  if (head.length > 0 && head.charAt(head.length - 1) === ',') head += ' '
  return head + family + value.slice(bounds.end)
}

function normalizeQuery(query) {
  return query.toLowerCase().replace(/[\s"']/g, '')
}

function matches(name, query) {
  if (query === '') return true
  return normalizeQuery(name).indexOf(query) !== -1
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../../src/fonts.js', import.meta.url), 'utf8')
const fonts = runInNewContext(source + '\n({ composeValue, segmentQuery, matches, classify, stripQuotes, normalizeQuery })')

test('replacing a family preserves fallbacks on either side of the caret', () => {
  assert.equal(fonts.composeValue('Arial, Georgia, monospace', 10, 'Anthropic Serif'), 'Arial, Anthropic Serif, monospace')
  assert.equal(fonts.composeValue('Arial, monospace', 2, 'Anthropic Sans'), 'Anthropic Sans, monospace')
})

test('quoted names and whitespace remain searchable', () => {
  assert.equal(fonts.segmentQuery('Arial, "Times New Roman", serif', 15), 'Times New Roman')
  assert.equal(fonts.matches('Times New Roman', fonts.normalizeQuery('times new')), true)
  assert.equal(fonts.matches('Georgia', 'times'), false)
})

test('an empty family list and a trailing separator accept a new family', () => {
  assert.equal(fonts.composeValue('', 0, 'serif'), 'serif')
  assert.equal(fonts.composeValue('Arial,', 6, 'serif'), 'Arial, serif')
})

test('generic and CJK families retain their group classification', () => {
  assert.equal(fonts.classify('monospace'), 'generic')
  assert.equal(fonts.classify('测试字体'), 'cjk')
  assert.equal(fonts.classify('Unlisted Family'), 'other')
})

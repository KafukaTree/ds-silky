import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderBuild, expandHost, assertBudgets, digest, root } from '../../scripts/build.mjs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const result = await renderBuild()

test('build is deterministic and matches the installed artifact', async () => {
  assert.equal((await renderBuild()).code, result.code)
  assert.equal(await readFile(resolve(root, 'lib/client.js'), 'utf8'), result.code)
})

test('all CSS token lines and cascade order match the reviewed 0.20.2 cards and list markers', () => {
  const normalized = result.css.split('\n').map(line => line.trim()).filter(Boolean).join('\n')
  assert.equal(digest(normalized), 'efb470cd7d10bbe90de1fd155bdfb6c290f08a46dd01884994187bab57e5de01')
})

test('single-file host format keeps one version source and no unresolved adapters', () => {
  assert.ok(result.code.startsWith('/* GENERATED'))
  assert.equal((result.code.match(/window\.__ModuleLoader__\.load\(/g) || []).length, 1)
  assert.ok(result.code.includes(`const PLUGIN_VERSION = '${result.version}'`))
  assert.ok(!result.code.includes('@host('))
  assert.ok(!result.code.includes('@version'))
})

test('published identity resolves to the registered client and branded assets', async () => {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  let registered
  runInNewContext(result.code, { window: { __ModuleLoader__: { load(module) { registered = module.id } } } })
  assert.equal(registered, pkg.name)
  assert.ok((await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')).includes(`name: '${pkg.name}'`))
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(resolve(root, `locale/${language}.json`), 'utf8'))
    assert.equal(locale.meta.title, 'DS Silky')
    assert.ok(locale.meta.description.length > 0)
  }
  const icon = await readFile(resolve(root, pkg.icon))
  assert.ok(icon.length < 256 * 1024)
  assert.ok(icon.toString().includes('<svg'))
})

test('adapter expansion preserves selector operators and resolves reused names', () => {
  const used = new Set()
  assert.equal(expandHost('@host(row) + @host(row)', { row: '[class~="Row_title"]' }, used), '[class~="Row_title"] + [class~="Row_title"]')
  assert.equal(used.size, 1)
})

test('unknown, malformed and unsafe adapter entries fail before writing output', () => {
  assert.throws(() => expandHost('@host(missing)', {}), /Unknown/)
  assert.throws(() => expandHost('@host(missing', {}), /Malformed/)
  assert.throws(() => expandHost('@host(row)', { row: "');alert(1)//" }), /Unsafe/)
})

test('source growth is bounded by explicit budgets', () => {
  assert.doesNotThrow(() => assertBudgets({ clientBytes: 10 }, { clientBytes: 10 }))
  assert.throws(() => assertBudgets({ clientBytes: 11 }, { clientBytes: 10 }), /exceeds/)
  assert.throws(() => assertBudgets({}, { missing: 10 }), /Invalid/)
})

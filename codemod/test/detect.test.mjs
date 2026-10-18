import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { scanProject } from '../src/detect.mjs'
import { changes } from '../src/changes.mjs'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const names = readdirSync(fixtures, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)

for (const name of names) {
  test(name, () => {
    const expected = JSON.parse(readFileSync(join(fixtures, name + '.expected.json'), 'utf8'))
    const actual = scanProject(join(fixtures, name)).findings
      .map(f => [f.id, f.file + ':' + f.line])
      .sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0]))
    assert.deepEqual(actual, expected)
  })
}

test('every finding a fixture expects has advice', () => {
  const ids = new Set(names.flatMap(name => JSON.parse(readFileSync(join(fixtures, name + '.expected.json'), 'utf8')).map(([id]) => id)))
  ids.delete('node-version')
  for (const id of ids)
    assert.ok(changes[id], id)
})

test('every rule with advice has a fixture that triggers it', () => {
  const ids = new Set(names.flatMap(name => JSON.parse(readFileSync(join(fixtures, name + '.expected.json'), 'utf8')).map(([id]) => id)))
  for (const id of Object.keys(changes))
    assert.ok(ids.has(id), id)
})

test('the report groups findings by level', () => {
  const out = execFileSync(process.execPath, [cli, join(fixtures, 'single')], { encoding: 'utf8' })
  assert.match(out, /Change before switching/)
  assert.match(out, /src\/reserve\.ts:7/)
  assert.ok(out.indexOf('Change before switching') < out.indexOf('Review'))
})

test('a clean project reports nothing to change', () => {
  const out = execFileSync(process.execPath, [cli, join(fixtures, 'clean')], { encoding: 'utf8' })
  assert.match(out, /Nothing found that the switch changes/)
})

test('--json prints facts and findings', () => {
  const out = JSON.parse(execFileSync(process.execPath, [cli, join(fixtures, 'imports'), '--json'], { encoding: 'utf8' }))
  assert.equal(out.facts.clients, 4)
  assert.ok(out.findings.length > 0)
})

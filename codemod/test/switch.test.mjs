import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const spec = 'npm:@steadybrew/postgresjs@^4'

function switched(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'postgresjs-migrate-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(fixtures, name), dir, { recursive: true })
  const run = spawnSync(process.execPath, [cli, dir, '--switch'], { encoding: 'utf8' })
  const json = file => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const text = file => readFileSync(join(dir, file), 'utf8')
  return { dir, run, json, text }
}

test('aliases postgres and drops a patch the fork makes unnecessary', t => {
  const { run, json, dir } = switched(t, 'single')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(json('package.json').dependencies.postgres, spec)
  assert.equal(json('package.json').pnpm, undefined)
  assert.equal(existsSync(join(dir, 'patches/postgres@3.4.9.patch')), false)
  assert.match(run.stdout, /pnpm install|npm install/)
  assert.match(run.stdout, /left\)/)
})

test('a patch with changes the fork does not have stops the switch before any write', t => {
  const { run, json, dir } = switched(t, 'unknown-patch')
  assert.equal(run.status, 1)
  assert.match(run.stdout, /1 of 2 changes/)
  assert.equal(json('package.json').dependencies.postgres, '3.4.9')
  assert.equal(existsSync(join(dir, 'patches/postgres@3.4.9.patch')), true)
})

test('pnpm: aliases the workspace package and overrides packages that bring their own postgres', t => {
  const { run, json } = switched(t, 'pnpm-monorepo')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(json('packages/db/package.json').dependencies.postgres, spec)
  assert.deepEqual(json('package.json').pnpm.overrides, { postgres: spec })
  assert.match(run.stdout, /client-lib, inner-z/)
})

test('pnpm catalog: changes the catalog entry, not the catalog: references', t => {
  const { run, json, text } = switched(t, 'pnpm-catalog')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(json('packages/api/package.json').dependencies.postgres, 'catalog:')
  assert.match(text('pnpm-workspace.yaml'), /^  postgres: 'npm:@steadybrew\/postgresjs@\^4'$/m)
  assert.match(text('pnpm-workspace.yaml'), /^  drizzle-orm: \^0\.45\.0$/m)
})

test('npm: alias plus overrides, not for tooling-only packages', t => {
  const { run, json } = switched(t, 'npm-lock')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(json('package.json').dependencies.postgres, spec)
  assert.deepEqual(json('package.json').overrides, { postgres: spec })
  assert.doesNotMatch(run.stdout.split('Switched:')[1], /seeder/)
})

test('yarn: resolutions', t => {
  const { run, json } = switched(t, 'yarn-lock')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.deepEqual(json('package.json').resolutions, { postgres: spec })
})

test('bun: overrides', t => {
  const { run, json } = switched(t, 'bun-lock')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.deepEqual(json('package.json').overrides, { postgres: spec })
})

test('running it twice changes nothing the second time', t => {
  const { dir } = switched(t, 'clean')
  const again = spawnSync(process.execPath, [cli, dir, '--switch'], { encoding: 'utf8' })
  assert.equal(again.status, 0)
  assert.match(again.stdout, /Nothing to switch/)
})

test('without --switch nothing is written', t => {
  const dir = mkdtempSync(join(tmpdir(), 'postgresjs-migrate-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(fixtures, 'clean'), dir, { recursive: true })
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' })
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
})

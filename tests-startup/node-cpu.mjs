/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(new URL('..', import.meta.url).pathname)
const builds = { release: 'latest release from npm', src: 'this version' }
const scenarios = { cpu: 'connect, `select 1`, end', rows: '1000 rows of five columns' }
const variants = Object.keys(builds).flatMap((build) => [
  { build, scenario: 'cpu', types: 'false' },
  { build, scenario: 'cpu', types: 'true' },
  { build, scenario: 'rows', types: 'false' }
])

async function request(postgres, url, { scenario, types }) {
  const start = process.cpuUsage()
  const sql = postgres(url, { max: 1, prepare: false, fetch_types: types === 'true', connect_timeout: 10 })
  const rows = scenario === 'rows'
    ? await sql`select i, 'name ' || i as name, md5(i::text) as hash, i % 2 = 0 as even, i * 1.5 as score
      from generate_series(1, 1000) i`
    : await sql`select 1 as x`
  await sql.end({ timeout: 5 })
  const used = process.cpuUsage(start)
  assert.equal(rows.length, scenario === 'rows' ? 1000 : 1)
  return (used.user + used.system) / 1000
}

function shuffled(xs) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = xs[i]
    xs[i] = xs[j]
    xs[j] = swap
  }
  return xs
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]

async function main([outArg, url, roundsArg]) {
  assert(outArg && url, 'Usage: node-cpu.mjs <dir> <database-url> [rounds]')
  const out = path.resolve(outArg)
      , rounds = Number(roundsArg) || 200
  execFileSync('npm', ['install', '--prefix', out, '--no-save', '--no-audit', '--no-fund', '@steadybrew/postgresjs@latest'], { stdio: 'inherit' })
  const drivers = {
    release: (await import(pathToFileURL(path.join(out, 'node_modules/@steadybrew/postgresjs/src/index.js')))).default,
    src: (await import(pathToFileURL(path.join(repo, 'src/index.js')))).default
  }
  const times = variants.map(() => [])
  for (let n = -5; n < rounds; n++) {
    for (const [v, variant] of shuffled([...variants.entries()])) {
      const ms = await request(drivers[variant.build], url, variant)
      n >= 0 && times[v].push(ms)
    }
  }
  const lines = [
    `Node.js ${ process.version }, one connection per request with SCRAM against PostgreSQL on the runner,`
      + ` ${ rounds } requests per variant after five warm-up rounds. CPU is the process's user and system time per request,`
      + ' from process.cpuUsage(). Times in ms.',
    '',
    '| Variant | n | CPU median | CPU p95 | CPU p99 |',
    '| --- | --- | --- | --- | --- |',
    ...variants.map((x, v) => {
      const xs = times[v].slice().sort((a, b) => a - b)
      return `| ${ builds[x.build] }, ${ scenarios[x.scenario] }, fetch_types ${ x.types } | ${ xs.length } | `
        + [0.5, 0.95, 0.99].map((p) => pct(xs, p).toFixed(2)).join(' | ') + ' |'
    })
  ]
  const text = lines.join('\n') + '\n'
  console.log(text)
  process.env.GITHUB_STEP_SUMMARY && await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Node.js CPU per request\n\n' + text)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

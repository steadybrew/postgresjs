/* eslint no-console: 0, no-process-env: 0 */
/* global Bun */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rankTest } from './rank.js'

const repo = path.resolve(new URL('..', import.meta.url).pathname)
const bun = typeof Bun !== 'undefined'
const runtime = bun ? 'Bun ' + Bun.version : 'Node.js ' + process.version
const scenarios = { cpu: 'connect, `select 1`, end', rows: '1000 rows of five columns' }
const rowsQuery = `select i, 'name ' || i as name, md5(i::text) as hash, i % 2 = 0 as even, i * 1.5 as score
  from generate_series(1, 1000) i`

function postgresjs(postgres) {
  return (url, types) => {
    const sql = postgres(url, { max: 1, prepare: false, fetch_types: types === 'true', connect_timeout: 10 })
    return { query: (text) => sql.unsafe(text), end: () => sql.end({ timeout: 5 }) }
  }
}

function nodePostgres(pg) {
  return (url) => {
    const client = new pg.Client({ connectionString: url })
    const connected = client.connect()
    return { query: async(text) => (await connected, (await client.query(text)).rows), end: () => client.end() }
  }
}

function bunSql(SQL) {
  return (url) => {
    const sql = new SQL(url, { max: 1, prepare: false })
    return { query: (text) => sql.unsafe(text), end: () => sql.close() }
  }
}

async function drivers(out) {
  const packages = ['@steadybrew/postgresjs@latest', ...(bun ? [] : ['pg@latest'])]
  execFileSync('npm', ['install', '--prefix', out, '--no-save', '--no-audit', '--no-fund', ...packages], { stdio: 'inherit' })
  const load = (x) => import(pathToFileURL(path.join(out, 'node_modules', x)))
  const release = (await load('@steadybrew/postgresjs/src/index.js')).default
  const src = (await import(pathToFileURL(path.join(repo, 'src/index.js')))).default
  return {
    release: { label: 'Postgres.js fork, latest release from npm', types: true, connect: postgresjs(release) },
    src: { label: 'Postgres.js fork, this version', types: true, connect: postgresjs(src) },
    ...bun
      ? { bun: { label: 'Bun.SQL ' + Bun.version, connect: bunSql(Bun.SQL) } }
      : { pg: { label: 'node-postgres ' + await version(out, 'pg'), connect: nodePostgres((await load('pg/lib/index.js')).default) } }
  }
}

async function version(out, name) {
  return JSON.parse(await readFile(path.join(out, 'node_modules', name, 'package.json'), 'utf8')).version
}

async function request(connect, url, { scenario, types }) {
  const start = process.cpuUsage()
  const sql = connect(url, types)
  const rows = await sql.query(scenario === 'rows' ? rowsQuery : 'select 1 as x')
  await sql.end()
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
  assert(outArg && url, 'Usage: driver-cpu.mjs <dir> <database-url> [rounds]')
  const out = path.resolve(outArg)
      , rounds = Number(roundsArg) || 200
  const all = await drivers(out)
  const variants = Object.entries(all).flatMap(([build, x]) => [
    { build, scenario: 'cpu', types: 'false' },
    ...x.types ? [{ build, scenario: 'cpu', types: 'true' }] : [],
    { build, scenario: 'rows', types: 'false' }
  ])
  const times = variants.map(() => [])
  for (let n = -5; n < rounds; n++) {
    for (const [v, variant] of shuffled([...variants.entries()])) {
      const ms = await request(all[variant.build].connect, url, variant)
      n >= 0 && times[v].push(ms)
    }
  }
  const lines = [
    `${ runtime }, one connection per request with SCRAM against PostgreSQL on the runner, ${ rounds } requests per variant`
      + ' after five warm-up rounds, with prepared statements off. CPU is the process\'s user and system time per request,'
      + ' from process.cpuUsage(). fetch_types is a Postgres.js option; the other drivers have no catalog fetch.'
      + ' The last two columns are one-sided Mann-Whitney rank tests against the latest release on the same request. Times in ms.',
    '',
    '| Driver | Request | n | CPU median | CPU p95 | CPU p99 | More than release, p | Less than release, p |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...variants.map((x, v) => {
      const xs = times[v].slice().sort((a, b) => a - b)
      const request = scenarios[x.scenario] + (all[x.build].types ? ', fetch_types ' + x.types : '')
      const base = variants.findIndex((y) => y.build === 'release' && y.scenario === x.scenario && y.types === x.types)
      const ranks = x.build === 'release'
        ? ['', '']
        : [rankTest(times[v], times[base]), rankTest(times[base], times[v])].map((p) => p.toPrecision(2))
      return `| ${ all[x.build].label } | ${ request } | ${ xs.length } | `
        + [0.5, 0.95, 0.99].map((p) => pct(xs, p).toFixed(2)).join(' | ') + ' | ' + ranks.join(' | ') + ' |'
    })
  ]
  const text = lines.join('\n') + '\n'
  console.log(text)
  process.env.GITHUB_STEP_SUMMARY && await appendFile(process.env.GITHUB_STEP_SUMMARY, `## CPU per request on ${ runtime }\n\n` + text)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarios } from './harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(here)
const keep = process.argv.includes('--keep')
const tracers = { 'dd-trace': '6.20.1', '@sentry/node': '11.7.0', '@sentry/server-utils': '11.7.0' }
const runs = [
  { mode: 'dd', type: 'esm', flags: ['--import', 'dd-trace/initialize.mjs'] },
  { mode: 'dd', type: 'cjs', flags: ['-r', 'dd-trace/init'] },
  { mode: 'dd-dbm', type: 'esm', flags: ['--import', 'dd-trace/initialize.mjs'], env: { DD_DBM_PROPAGATION_MODE: 'full' } },
  { mode: 'sentry-auto', type: 'esm', flags: ['--import', '@sentry/node/import'] },
  { mode: 'sentry-auto', type: 'cjs', flags: ['--import', '@sentry/node/import'] },
  { mode: 'sentry-manual', type: 'esm', flags: [] },
  { mode: 'sentry-manual', type: 'cjs', flags: [] }
]

const work = mkdtempSync(path.join(os.tmpdir(), 'pg-tracing-'))
const data = path.join(work, 'data')
const port = await freePort()
let started = false

try {
  execFileSync('npm', ['run', 'build:cjs', '--silent'], { cwd: repo, stdio: 'inherit' })
  const tarball = path.join(work, execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', work], { cwd: repo, encoding: 'utf8' }).trim().split('\n').pop())

  execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8'], { stdio: 'ignore' })
  execFileSync('pg_ctl', ['-D', data, '-l', path.join(work, 'postgres.log'), '-w', '-o', `-c listen_addresses=127.0.0.1 -c port=${ port } -c unix_socket_directories=''`, 'start'], { stdio: 'ignore' })
  started = true

  const variants = { upstream: install('upstream', '3.4.9'), fork: install('fork', 'file:' + tarball) }
  const results = {}
  for (const run of runs) {
    for (const [variant, dir] of Object.entries(variants))
      results[key(run, variant)] = execute(run, dir)
  }

  const forkPackage = path.join(variants.fork, 'node_modules', 'postgres', 'package.json')
  const original = readFileSync(forkPackage, 'utf8')
  writeFileSync(forkPackage, JSON.stringify({ ...JSON.parse(original), version: '3.99.0' }))
  for (const run of runs.filter(x => x.mode === 'sentry-auto'))
    results[key(run, 'fork as 3.x')] = execute(run, variants.fork)
  writeFileSync(forkPackage, original)

  const differences = report(results)
  process.exitCode = differences ? 1 : 0
} finally {
  started && execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' })
  keep ? console.log('kept ' + work) : rmSync(work, { recursive: true, force: true })
}

function install(name, spec) {
  const dir = path.join(work, name)
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { postgres: spec, ...tracers } }))
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], { cwd: dir, stdio: 'inherit' })
  for (const file of ['harness.mjs', 'entry.mjs', 'entry.cjs'])
    copyFileSync(path.join(here, file), path.join(dir, file))
  return dir
}

function execute({ mode, type, flags, env = {} }, dir) {
  const resultFile = path.join(dir, 'result.json')
  rmSync(resultFile, { force: true })
  const child = spawnSync(process.execPath, [...flags, type === 'esm' ? 'entry.mjs' : 'entry.cjs'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ...env,
      TRACER: mode,
      RESULT_FILE: resultFile,
      PGHOST: '127.0.0.1',
      PGPORT: String(port),
      PGUSER: 'postgres',
      PGDATABASE: 'postgres',
      DD_TRACE_EXPERIMENTAL_EXPORTER: 'log',
      DD_TRACE_FLUSH_INTERVAL: '0',
      DD_TRACE_STARTUP_LOGS: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_SERVICE: 'tracing-check'
    }
  })

  let output
  try {
    output = JSON.parse(readFileSync(resultFile, 'utf8'))
  } catch {
    return { crashed: (child.stderr || child.error?.message || 'no result').trim().split('\n').slice(-5).join('\n'), spans: {} }
  }

  const spans = mode.startsWith('dd') ? ddSpans(child.stdout) : sentrySpans(output.events)
  return { spans, failures: output.failures }
}

function ddSpans(stdout) {
  const traces = {}
  for (const line of stdout.split('\n').filter(x => x.startsWith('{"traces"'))) {
    for (const span of JSON.parse(line).traces.flat())
      (traces[span.trace_id] ??= []).push(span)
  }

  const spans = {}
  for (const trace of Object.values(traces)) {
    const root = trace.find(x => x.name === 'scenario')
    if (!root)
      continue
    spans[root.resource] = trace.filter(x => x !== root && !x.name.startsWith('tcp.')).map(x => ({
      label: `${ x.name } ${ x.resource }${ x.error ? ' [error]' : '' }`,
      keys: Object.keys({ ...x.meta, ...x.metrics }).filter(k => !/^_dd\.p\.|^_sampling|runtime-id|process_id/.test(k)).sort()
    })).sort(byLabel)
  }
  return spans
}

function sentrySpans(events) {
  const spans = {}
  for (const event of events) {
    spans[event.transaction] = (event.spans || []).map(x => ({
      label: `${ x.op } ${ x.description }${ x.status && x.status !== 'ok' ? ' [' + x.status + ']' : '' }`,
      keys: x.data.filter(k => !/^sentry\./.test(k)).sort()
    })).sort(byLabel)
  }
  return spans
}

function report(results) {
  let differences = 0
  const groups = [...new Set(runs.map(x => x.mode + ' ' + x.type))]
  for (const group of groups) {
    const upstream = results[group + ' upstream']
    const compared = Object.keys(results).filter(x => x.startsWith(group + ' ') && !x.endsWith(' upstream'))
    console.log('\n' + group)
    for (const name of compared) {
      const variant = name.slice(group.length + 1)
      const other = results[name]
      if (upstream.crashed || other.crashed) {
        differences++
        console.log(`  ${ variant }: run failed\n    upstream: ${ upstream.crashed || 'ok' }\n    ${ variant }: ${ other.crashed || 'ok' }`)
        continue
      }
      if (known(group, variant)) {
        console.log(`  ~ ${ variant }: ${ known(group, variant) }`)
        continue
      }
      for (const scenario of new Set([...Object.keys(scenarios), ...Object.keys(upstream.spans), ...Object.keys(other.spans)])) {
        const a = upstream.spans[scenario] || []
        const b = other.spans[scenario] || []
        const same = JSON.stringify(a) === JSON.stringify(b)
        const reason = !same && known(group, variant, scenario)
        same || reason || differences++
        console.log(`  ${ same ? ' ' : reason ? '~' : '✗' } ${ scenario.padEnd(12) } upstream ${ a.length } span(s), ${ variant } ${ b.length }${ same ? '' : reason ? ' (' + reason + ')' : diff(a, b, variant) }`)
      }
      differences += other.failures.length
      for (const { name: scenario, error } of [...upstream.failures, ...other.failures])
        console.log(`    scenario ${ scenario } threw: ${ error }`)
    }
  }
  console.log(differences ? `\n${ differences } difference(s) from upstream` : '\nNo differences from upstream')
  return differences
}

function known(group, variant, scenario) {
  if (group.startsWith('sentry-auto') && variant === 'fork')
    return 'expected: Sentry instruments postgres <4 only'
  if (group.startsWith('sentry-auto') && scenario === 'savepoint')
    return 'savepoint names are sent inline, not as a parameter'
  if (group.startsWith('dd-dbm') && ['commit', 'rollback', 'savepoint'].includes(scenario))
    return 'transaction control is sent unprepared, so dd-trace adds its SQL comment'
}

function diff(a, b, variant) {
  const lines = []
  const labels = x => x.map(s => s.label)
  for (const label of labels(a).filter(x => !labels(b).includes(x)))
    lines.push(`only upstream: ${ label }`)
  for (const label of labels(b).filter(x => !labels(a).includes(x)))
    lines.push(`only ${ variant }: ${ label }`)
  for (const span of a) {
    const match = b.find(x => x.label === span.label)
    if (!match)
      continue
    const missing = span.keys.filter(k => !match.keys.includes(k))
    const extra = match.keys.filter(k => !span.keys.includes(k))
    missing.length && lines.push(`${ span.label }: ${ variant } lacks ${ missing.join(', ') }`)
    extra.length && lines.push(`${ span.label }: ${ variant } adds ${ extra.join(', ') }`)
  }
  return lines.map(x => '\n      ' + x).join('')
}

function key({ mode, type }, variant) {
  return `${ mode } ${ type } ${ variant }`
}

function byLabel(a, b) {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
}

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

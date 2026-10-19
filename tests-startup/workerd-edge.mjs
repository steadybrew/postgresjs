/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const scenarios = [
  'arrays-false', 'arrays-true', 'timers', 'end-timeout', 'end-plain', 'end-while-connecting', 'end-tls',
  'copy-out', 'subscribe', 'diagnostics-channel', 'ssl-verify', 'pooled'
]
const hyperdrive = [
  { binding: 'HYPERDRIVE', id: '6cac003bd1af42849ca7e83e125d5a3d' },
  { binding: 'HYPERDRIVE_POOLED', id: 'ebb0176610db40e99887ede1f4fd7e66' },
  { binding: 'HYPERDRIVE_SUPABASE', id: 'dbfddf8b784343468b1b4b1a3074fa38' }
]
const closing = /Stream was cancelled|This socket has been closed/

const repo = path.resolve(new URL('..', import.meta.url).pathname)
const cpuVariants = [
  ...['release', 'cf', 'src'].flatMap((build) => ['false', 'true'].map((types) => ({ build, target: 'supabase', types }))),
  ...['release', 'cf', 'src'].map((build) => ({ build, target: 'neon', types: 'false' }))
]
const gate = { median: 1, p95: 1, exceeded: 0.02 }

async function prepare(out, compatibilityDate, release) {
  await mkdir(out, { recursive: true })
  await cp(path.join(repo, 'cf'), path.join(out, 'cf'), { recursive: true })
  await cp(path.join(repo, 'src'), path.join(out, 'src'), { recursive: true })
  await cp(path.join(repo, 'tests-startup/workerd-worker.js'), path.join(out, 'worker.js'))
  await writeFile(path.join(out, 'driver.js'), [
    'export { default } from \'./cf/src/index.js\'',
    'export { default as cf } from \'./cf/src/index.js\'',
    'export { default as src } from \'./src/index.js\'',
    ...(release ? ['export { default as release } from \'@steadybrew/postgresjs\''] : []),
    ''
  ].join('\n'))
  release && execFileSync('npm', ['install', '--prefix', out, '--no-save', '--no-audit', '--no-fund', release], { stdio: 'inherit' })
  await writeFile(path.join(out, 'wrangler.json'), JSON.stringify({
    name: 'postgresjs-edge',
    main: 'worker.js',
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    observability: { enabled: true },
    hyperdrive,
    previews: { observability: { enabled: true }, hyperdrive }
  }, null, 2))
}

function previewUrl(value) {
  if (typeof value === 'string')
    return /^https:\/\/\S+\.workers\.dev\/?$/.test(value) ? value : null
  if (value && typeof value === 'object') {
    for (const x of Object.values(value)) {
      const found = previewUrl(x)
      if (found) return found
    }
  }
  return null
}

async function ready(base) {
  const token = process.env.EDGE_TOKEN
  assert(token, 'EDGE_TOKEN is required')
  const headers = { authorization: 'Bearer ' + token }
  const deadline = Date.now() + 120000
  while ((await fetch(new URL('/health', base), { headers }).catch(() => null))?.status !== 200) {
    assert(Date.now() < deadline, 'The Preview did not serve this deployment within 120 seconds')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return headers
}

async function fetchWorker(url, headers) {
  let res
    , platformErrors = 0
    , waitedMs = 0
  for (;;) {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
    const fromWorker = res.ok || (res.headers.get('content-type') || '').includes('json')
    const wait = retryAfter(res.headers.get('retry-after')) ?? Math.min(2000 * 2 ** platformErrors, 30000)
    if (fromWorker || waitedMs + wait > 180000)
      return { res, platformErrors, waitedMs }
    platformErrors++
    waitedMs += wait
    await res.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

async function run(base) {
  const headers = await ready(base)
  const known = (process.env.EDGE_KNOWN_FAILURES || '').split(',').filter(Boolean)
  const rounds = Number(process.env.EDGE_HYPERDRIVE_ROUNDS) || 1
  const round = ['hyperdrive', 'hyperdrive-pooled', 'hyperdrive-supabase']
  const build = 'cf'
  for (const name of [...scenarios, ...Array(rounds).fill(round).flat()]) {
    let body
      , failure
      , fetched
    try {
      fetched = await fetchWorker(new URL('/?case=' + name + '&build=' + build, base), headers)
      const { res } = fetched
      assert.notEqual(res.status, 401, 'Preview rejected the token')
      assert((res.headers.get('content-type') || '').includes('json'), 'Cloudflare answered HTTP ' + res.status + ' instead of the Worker')
      body = await res.json()
      assert(res.ok && body.passed, JSON.stringify(body.error || body))
      const unexpected = body.unhandled.filter((x) => !closing.test(x))
      assert.deepEqual(unexpected, [], 'Unhandled rejections: ' + unexpected.join('\n'))
    } catch (error) {
      failure = error
    }
    const expected = known.includes(name)
    if (Boolean(failure) !== expected) process.exitCode = 1
    console.log(JSON.stringify({
      build,
      name,
      passed: !failure,
      ...(expected ? { knownFailure: true } : {}),
      result: body?.result,
      closeRejections: (body?.unhandled || []).filter((x) => closing.test(x)).length,
      ...(fetched?.platformErrors ? { platformErrors: fetched.platformErrors, waitedMs: fetched.waitedMs } : {}),
      error: failure?.message
    }))
  }
}

async function cpu(base, roundsArg) {
  await telemetry(Date.now() - 60000, [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: 'postgresjs-edge' }])
  const headers = await ready(base)
  const rounds = Number(roundsArg) || 60
  const run = Date.now().toString(36)
  console.log('Run ' + run)
  const from = Date.now() - 60000
  const failures = []
  for (let n = -2; n < rounds; n++) {
    for (const [v, x] of shuffled([...cpuVariants.entries()])) {
      const query = new URLSearchParams({ case: 'cpu', build: x.build, target: x.target, fetch_types: x.types, run, v, n })
      try {
        const { res } = await fetchWorker(new URL('/?' + query, base), headers)
        const body = await res.json().catch(() => null)
        body?.passed || failures.push({ v, n, status: res.status, error: body?.error?.message })
      } catch (error) {
        failures.push({ v, n, error: error.message })
      }
    }
  }

  const { measured: events, missing } = await collect(run, from, rounds, failures)
  const rows = cpuVariants.map((x, v) => ({ ...x, ...summary(events[v]), missing: missing[v] }))
  const builds = {
    release: 'latest release from npm',
    cf: 'cloudflare:sockets',
    src: 'node:net'
  }
  const order = ['supabase:false', 'supabase:true', 'neon:false']
  const groups = order.map((key) => rows.filter((x) => x.target + ':' + x.types === key))
  const heading = (key) => ({
    'supabase:false': 'Supabase pooler, plaintext, fetch_types false',
    'supabase:true': 'Supabase pooler, plaintext, fetch_types true',
    'neon:false': 'Neon, TLS, fetch_types false'
  })[key]
  const header = [
    '| Build | n | Not in Workers Logs | CPU median | CPU p95 | CPU p99 | Wall median | Wall p95 | Wall p99 | exceededCpu | Other outcomes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const table = [
    'cloudflare:sockets: the driver calls Cloudflare\'s socket API directly. node:net: the driver goes through workerd\'s Node.js'
      + ' emulation of node:net and node:tls. latest release from npm: the published package as users install it. Times in ms.',
    ...groups.flatMap((xs, i) => [
      '',
      '### ' + heading(order[i]),
      '',
      ...header,
      ...xs.map((x) => '| ' + [
        builds[x.build], x.n, x.missing, x.cpu.median, x.cpu.p95, x.cpu.p99, x.wall.median, x.wall.p95, x.wall.p99, x.exceeded, x.other || '-'
      ].join(' | ') + ' |')
    ])
  ].join('\n')

  const exportsMap = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).exports['.']
  const candidate = exportsMap.workerd.startsWith('./cf/') ? 'cf' : 'src'
  const find = (build, types) => rows.find((x) => x.build === build && x.target === 'supabase' && x.types === types)
  const regressions = ['false', 'true'].flatMap((types) => {
    const a = find(candidate, types)
        , b = find('release', types)
    return [
      a.cpu.median - b.cpu.median >= gate.median && `median ${ a.cpu.median } vs ${ b.cpu.median } ms`,
      a.cpu.p95 - b.cpu.p95 >= gate.p95 && `p95 ${ a.cpu.p95 } vs ${ b.cpu.p95 } ms`,
      (a.exceeded - b.exceeded) / a.n >= gate.exceeded && `exceededCpu ${ a.exceeded } vs ${ b.exceeded }`
    ].filter(Boolean).map((x) => 'fetch_types ' + types + ': ' + x)
  })
  const verdict = regressions.length
    ? `This version (${ builds[candidate] }) costs more CPU than the latest release: ${ regressions.join('; ') }.`
    : `This version (${ builds[candidate] }) costs no more CPU than the latest release.`
  const failedRequests = failures.length
    ? `\n${ failures.length } requests failed: ${ JSON.stringify(failures.slice(0, 10)) }\n`
    : ''
  const report = `${ table }\n\n${ verdict }\n${ failedRequests }`
  console.log(report)
  process.env.GITHUB_STEP_SUMMARY && await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Workers CPU per connection\n\n' + report)
  if (regressions.length || failures.length)
    process.exitCode = 1
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

async function collect(run, from, rounds, failed) {
  const deadline = Date.now() + 600000
  let previous = -1
  for (;;) {
    const events = []
    for (const v of cpuVariants.keys()) {
      events.push(await telemetry(from, [
        { key: '$workers.scriptName', operation: 'eq', type: 'string', value: 'postgresjs-edge' },
        { key: '$workers.event.search.run', operation: 'eq', type: 'string', value: run },
        { key: '$workers.event.search.v', operation: 'eq', type: 'number', value: v }
      ]))
    }
    const measured = events.map((xs) => xs.filter((x) => Number(x.$workers.event.search.n) >= 0))
    const missing = measured.map((xs, v) => {
      const seen = new Set(xs.map((x) => Number(x.$workers.event.search.n)))
      return Array.from({ length: rounds }, (_, n) => n).filter((n) => !seen.has(n) && !failed.some((x) => x.v === v && x.n === n)).length
    })
    const total = measured.reduce((sum, xs) => sum + xs.length, 0)
    if (missing.every((x) => x === 0) || (total === previous && Date.now() > deadline - 480000) || Date.now() > deadline)
      return { measured, missing }
    previous = total
    await new Promise((resolve) => setTimeout(resolve, 30000))
  }
}

async function telemetry(from, filters) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
      , token = process.env.CLOUDFLARE_API_TOKEN
  assert(account && token, 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required')
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ account }/workers/observability/telemetry/query`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        queryId: 'postgresjs-cpu',
        timeframe: { from, to: Date.now() + 60000 },
        view: 'events',
        limit: 1000,
        parameters: { filters }
      })
    })
    const body = await res.json().catch(() => null)
    if (body?.success) {
      const events = body.result.events.events
      assert(events.length < 1000, 'Workers observability query hit its 1000-event limit')
      return events
    }
    assert(res.status !== 403 && attempt < 6, 'Workers observability query failed: HTTP ' + res.status + ' ' + JSON.stringify(body?.errors))
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt))
  }
}

function summary(events) {
  const sorted = (key) => events.map((x) => x.$workers[key]).sort((a, b) => a - b)
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]
  const stats = (xs) => ({ median: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99) })
  return {
    n: events.length,
    cpu: stats(sorted('cpuTimeMs')),
    wall: stats(sorted('wallTimeMs')),
    exceeded: events.filter((x) => x.$workers.outcome === 'exceededCpu').length,
    other: Object.entries(Object.groupBy(
      events.filter((x) => !['ok', 'exceededCpu'].includes(x.$workers.outcome)),
      (x) => x.$workers.outcome
    )).map(([outcome, xs]) => outcome + ' ' + xs.length).join(', ')
  }
}

function retryAfter(value) {
  if (!value)
    return
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isNaN(ms) ? undefined : Math.max(ms, 0)
}

async function main([mode, ...args]) {
  if (mode === 'prepare')
    return prepare(path.resolve(args[0]), args[1], args[2])
  if (mode === 'url')
    return console.log(previewUrl(JSON.parse(await readFile(args[0], 'utf8')).deployment) || '')
  if (mode === 'run')
    return run(args[0])
  if (mode === 'cpu')
    return cpu(args[0], args[1])
  throw new Error('Usage: workerd-edge.mjs prepare <dir> <compatibility-date> [release-package] | url <preview.json> | run <preview-url>'
    + ' | cpu <preview-url> [rounds]')
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

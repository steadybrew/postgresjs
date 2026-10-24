/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const scenarios = [
  'arrays-false', 'arrays-true', 'timers', 'end-timeout', 'end-plain', 'end-while-connecting', 'end-tls',
  'copy-out', 'subscribe', 'diagnostics-channel', 'tracing-channels', 'ssl-verify', 'tls-private-ca', 'pooled', 'no-end',
  'abort-neon', 'abort-neon-pooled', 'abort-supabase-pooler', 'abort-hyperdrive', 'abort-hyperdrive-pooled', 'abort-hyperdrive-supabase'
]
const hyperdrive = [
  { binding: 'HYPERDRIVE', id: '6cac003bd1af42849ca7e83e125d5a3d' },
  { binding: 'HYPERDRIVE_POOLED', id: 'ebb0176610db40e99887ede1f4fd7e66' },
  { binding: 'HYPERDRIVE_SUPABASE', id: 'dbfddf8b784343468b1b4b1a3074fa38' }
]
const closing = /Stream was cancelled|This socket has been closed|Network connection lost/

const repo = path.resolve(new URL('..', import.meta.url).pathname)
const cpuVariants = [
  ...['release', 'cf', 'src'].flatMap((build) => ['false', 'true'].map((types) => ({ build, target: 'supabase', types }))),
  ...['release', 'cf', 'src'].map((build) => ({ build, target: 'neon', types: 'false' }))
]
const gate = { median: 1, p95: 1, exceeded: 0.02, p: 0.01, failures: 0.02 }

async function prepare(out, compatibilityDate, release, base) {
  await mkdir(out, { recursive: true })
  await cp(path.join(repo, 'cf'), path.join(out, 'cf'), { recursive: true })
  base && await cp(path.join(base, 'cf'), path.join(out, 'base/cf'), { recursive: true })
  await cp(path.join(repo, 'src'), path.join(out, 'src'), { recursive: true })
  await cp(path.join(repo, 'tests-startup/workerd-worker.js'), path.join(out, 'worker.js'))
  await writeFile(path.join(out, 'driver.js'), [
    'export { default } from \'./cf/src/index.js\'',
    'export { default as cf } from \'./cf/src/index.js\'',
    'export { default as src } from \'./src/index.js\'',
    ...(release ? ['export { default as release } from \'@steadybrew/postgresjs\''] : []),
    ...(base ? ['export { default as base } from \'./base/cf/src/index.js\''] : []),
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
      const tag = name === 'no-end' ? 'no-end-' + Date.now().toString(36) : ''
      fetched = await fetchWorker(new URL('/?case=' + name + '&build=' + build + (tag ? '&tag=' + tag : ''), base), headers)
      const { res } = fetched
      assert.notEqual(res.status, 401, 'Preview rejected the token')
      assert((res.headers.get('content-type') || '').includes('json'), 'Cloudflare answered HTTP ' + res.status + ' instead of the Worker')
      body = await res.json()
      assert(res.ok && body.passed, JSON.stringify(body.error || body))
      const unexpected = body.unhandled.filter((x) => !closing.test(x))
      assert.deepEqual(unexpected, [], 'Unhandled rejections: ' + unexpected.join('\n'))
      if (tag) body.result = { ...body.result, ...await released(base, headers, build, tag) }
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

async function released(base, headers, build, tag) {
  const start = Date.now()
  const counts = []
  for (;;) {
    const { res } = await fetchWorker(new URL('/?case=backends&build=' + build + '&tag=' + tag, base), headers)
    const n = (await res.json()).result?.n
    counts.push(n)
    if (n === 0)
      return { releasedAfterMs: Date.now() - start, counts }
    assert(Date.now() - start < 60000, 'The connection the request left open still has a backend after 60 s: ' + counts.join(','))
    await new Promise((resolve) => setTimeout(resolve, 1000))
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
  const rows = cpuVariants.map((x, v) => ({
    ...x,
    ...summary(events[v]),
    cpus: events[v].map((e) => e.$workers.cpuTimeMs),
    missing: missing[v]
  }))
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
  const tests = ['false', 'true'].flatMap((types) => [candidate, 'src'].filter((x, i, xs) => xs.indexOf(x) === i).map((build) => {
    const a = find(build, types)
        , b = find('release', types)
    return { build, types, a, b, p: rankTest(a.cpus, b.cpus) }
  }))
  const regressions = tests.filter((x) => x.build === candidate).flatMap(({ types, a, b, p }) => [
    p < gate.p && a.cpu.median - b.cpu.median >= gate.median
      && `median ${ a.cpu.median } vs ${ b.cpu.median } ms (rank test p = ${ p.toPrecision(2) })`,
    p < gate.p && a.cpu.p95 - b.cpu.p95 >= gate.p95
      && `p95 ${ a.cpu.p95 } vs ${ b.cpu.p95 } ms (rank test p = ${ p.toPrecision(2) })`,
    (a.exceeded - b.exceeded) / a.n >= gate.exceeded && `exceededCpu ${ a.exceeded } vs ${ b.exceeded }`
  ].filter(Boolean).map((x) => 'fetch_types ' + types + ': ' + x))
  const ranks = tests.map(({ build, types, p }) =>
    `- ${ builds[build] } vs latest release, fetch_types ${ types }: one-sided rank test p = ${ p.toPrecision(2) }`
  ).join('\n')
  const tooManyFailures = cpuVariants.some((x, v) => failures.filter((f) => f.v === v).length > Math.max(1, rounds * gate.failures))
  const verdict = regressions.length
    ? `This version (${ builds[candidate] }) costs more CPU than the latest release: ${ regressions.join('; ') }.`
    : `This version (${ builds[candidate] }) costs no more CPU than the latest release.`
  const failedRequests = failures.length
    ? `\n${ failures.length } requests failed: ${ JSON.stringify(failures.slice(0, 10)) }\n`
    : ''
  const report = `${ table }\n\nMann-Whitney rank test on CPU per request, whether the first build costs more:\n\n${ ranks }`
    + `\n\n${ verdict }\n${ failedRequests }`
  console.log(report)
  process.env.GITHUB_STEP_SUMMARY && await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Workers CPU per connection\n\n' + report)
  if (regressions.length || tooManyFailures)
    process.exitCode = 1
}

function rankTest(a, b) {
  const all = [...a.map((x) => [x, 0]), ...b.map((x) => [x, 1])].sort((x, y) => x[0] - y[0])
  const n = all.length
  let rankA = 0
    , ties = 0
  for (let i = 0; i < n;) {
    let j = i
    while (j < n && all[j][0] === all[i][0]) j++
    const t = j - i
    ties += t * t * t - t
    for (let k = i; k < j; k++) all[k][1] === 0 && (rankA += (i + j + 1) / 2)
    i = j
  }
  const u = rankA - a.length * (a.length + 1) / 2
  const mean = a.length * b.length / 2
  const sd = Math.sqrt(a.length * b.length / 12 * ((n + 1) - ties / (n * (n - 1))))
  return sd ? 0.5 * erfc((u - mean - 0.5) / sd / Math.SQRT2) : 1
}

function erfc(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x))
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? y : 2 - y
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

async function ab(base, roundsArg, targetArg, baseRef) {
  await telemetry(Date.now() - 60000, [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: 'postgresjs-edge' }])
  const headers = await ready(base)
  const rounds = Number(roundsArg) || 150
  const [target, types] = (targetArg || 'supabase-false').split('-')
  const variants = ['base', 'cf'].map((build) => ({ build, target, types }))
  const run = Date.now().toString(36)
  console.log('Run ' + run)
  const from = Date.now() - 60000
  const failures = []
  const served = variants.map(() => new Map())
  for (let n = -2; n < rounds; n++) {
    for (const [v, x] of shuffled([...variants.entries()])) {
      const query = new URLSearchParams({ case: 'cpu', build: x.build, target: x.target, fetch_types: x.types, run, v, n })
      try {
        const { res } = await fetchWorker(new URL('/?' + query, base), headers)
        const body = await res.json().catch(() => null)
        body?.passed ? served[v].set(n, body.result) : failures.push({ v, n, status: res.status, error: body?.error?.message })
      } catch (error) {
        failures.push({ v, n, error: error.message })
      }
    }
  }

  const { measured, missing } = await collect(run, from, rounds, failures, variants)
  const requests = measured.map((events, v) => events.map((e) => {
    const n = Number(e.$workers.event.search.n)
    return { n, cpu: e.$workers.cpuTimeMs, wall: e.$workers.wallTimeMs, outcome: e.$workers.outcome, ...served[v].get(n) }
  }))
  const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] : '-'
  const stats = (xs) => {
    const cpus = xs.map((x) => x.cpu).sort((a, b) => a - b)
    return [xs.length, pct(cpus, 0.5), pct(cpus, 0.95), pct(cpus, 0.99), cpus.length ? cpus[cpus.length - 1] : '-']
  }
  const slowest = (xs) => [...xs].sort((p, q) => q.cpu - p.cpu).slice(0, 8)
  const names = { base: 'base (' + baseRef + ')', cf: 'this branch' }
  const row = (cells) => '| ' + cells.join(' | ') + ' |'
  const [a, b] = requests.map((xs) => xs.map((x) => x.cpu))
  const lines = [
    `cloudflare:sockets builds of ${ baseRef } and this branch, ${ target }, fetch_types ${ types }, ${ rounds } rounds each`
      + ' in shuffled order. CPU is Workers Logs cpuTimeMs in whole ms. A build\'s first request in an isolate pays any per-isolate'
      + ' work for that build (SCRAM keys, its module\'s first use); the isolate\'s first request also pays loading the Worker.',
    '',
    row(['Build', 'n', 'Not in Workers Logs', 'Isolates', 'CPU median', 'CPU p95', 'CPU p99', 'CPU max']),
    row(Array(8).fill('---')),
    ...variants.map((x, v) => {
      const [n, ...cpu] = stats(requests[v])
      return row([names[x.build], n, missing[v], new Set(requests[v].map((r) => r.isolate)).size, ...cpu])
    }),
    '',
    `Mann-Whitney rank test on CPU per request: this branch costs more, p = ${ rankTest(b, a).toPrecision(2) }; `
      + `costs less, p = ${ rankTest(a, b).toPrecision(2) }.`,
    '',
    '### By request position in its isolate',
    '',
    row(['Build', 'Requests', 'n', 'CPU median', 'CPU p95', 'CPU p99', 'CPU max']),
    row(Array(7).fill('---')),
    ...variants.flatMap((x, v) => [
      ['first in its isolate', (r) => r.served === 1],
      ['first of this build in its isolate', (r) => r.served > 1 && r.buildServed === 1],
      ['later', (r) => r.buildServed > 1]
    ].map(([label, test]) => row([names[x.build], label, ...stats(requests[v].filter(test))]))),
    '',
    '### Slowest requests',
    '',
    row(['Build', 'Round', 'CPU', 'Wall', 'Outcome', 'Isolate', 'Isolate request', 'Build request in isolate']),
    row(Array(8).fill('---')),
    ...variants.flatMap((x, v) => slowest(requests[v]).map((r) =>
      row([names[x.build], r.n, r.cpu, r.wall, r.outcome, (r.isolate || '-').slice(0, 8), r.served ?? '-', r.buildServed ?? '-'])
    )),
    '',
    failures.length ? `${ failures.length } requests failed: ${ JSON.stringify(failures.slice(0, 10)) }` : 'No request failed.'
  ]
  const report = lines.join('\n')
  console.log(report)
  process.env.GITHUB_STEP_SUMMARY && await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Workers CPU, A/B\n\n' + report + '\n')
  const tooManyFailures = variants.some((x, v) => failures.filter((f) => f.v === v).length > Math.max(1, rounds * gate.failures))
  tooManyFailures && (process.exitCode = 1)
}

async function collect(run, from, rounds, failed, variants = cpuVariants) {
  const deadline = Date.now() + 600000
  let previous = -1
  for (;;) {
    const events = []
    for (const v of variants.keys()) {
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
    return prepare(path.resolve(args[0]), args[1], args[2], args[3] && path.resolve(args[3]))
  if (mode === 'url')
    return console.log(previewUrl(JSON.parse(await readFile(args[0], 'utf8')).deployment) || '')
  if (mode === 'run')
    return run(args[0])
  if (mode === 'cpu')
    return cpu(args[0], args[1])
  if (mode === 'ab')
    return ab(args[0], args[1], args[2], args[3])
  throw new Error('Usage: workerd-edge.mjs prepare <dir> <compatibility-date> [release-package] [base-checkout] | url <preview.json>'
    + ' | run <preview-url> | cpu <preview-url> [rounds] | ab <preview-url> [rounds] [target-fetch_types] [base-ref]')
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

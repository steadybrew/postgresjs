/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFile, cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { rankTest } from './rank.js'

const wranglerVersion = '4.151.1'
const devPort = 8787
const inspectorPort = 9229
const repo = path.resolve(new URL('..', import.meta.url).pathname)
const variants = ['release', 'cf'].flatMap((build) => [
  { build, scenario: 'cpu', types: 'false' },
  { build, scenario: 'cpu', types: 'true' },
  { build, scenario: 'rows', types: 'false' }
])
const scenarios = { cpu: 'connect, `select 1`, end', rows: '1000 rows of five columns' }
const builds = { release: 'latest release from npm', cf: 'this version' }

async function prepare(out, databaseUrl) {
  const install = out + '-release'
  await mkdir(out + '-profiles', { recursive: true })
  await cp(path.join(repo, 'cf'), path.join(out, 'cf'), { recursive: true })
  await cp(path.join(repo, 'tests-startup/workerd-worker.js'), path.join(out, 'worker.js'))
  execFileSync('npm', ['install', '--prefix', install, '--no-save', '--no-audit', '--no-fund', '@steadybrew/postgresjs@latest'], { stdio: 'inherit' })
  await cp(path.join(install, 'node_modules/@steadybrew/postgresjs/cf'), path.join(out, 'release/cf'), { recursive: true })
  await writeFile(path.join(out, 'driver.js'), [
    'export { default } from \'./cf/src/index.js\'',
    'export { default as cf } from \'./cf/src/index.js\'',
    'export { default as release } from \'./release/cf/src/index.js\'',
    ''
  ].join('\n'))
  await writeFile(path.join(out, 'wrangler.json'), JSON.stringify({
    name: 'postgresjs-profile',
    main: 'worker.js',
    compatibility_date: '2026-10-12',
    compatibility_flags: ['nodejs_compat'],
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
    vars: { SUPABASE_URL: databaseUrl }
  }, null, 2))
}

function dev(out) {
  const child = spawn('npx', [
    '--yes', 'wrangler@' + wranglerVersion, 'dev',
    '--ip', '127.0.0.1', '--port', String(devPort), '--inspector-port', String(inspectorPort)
  ], { cwd: out, detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
  return () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      error.code === 'ESRCH' || console.error(error)
    }
  }
}

async function ready() {
  const deadline = Date.now() + 120000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${ devPort }/health`)
      if (res.ok) return
    } catch (error) {
      assert(Date.now() < deadline, 'wrangler dev did not start: ' + error.message)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

async function inspector() {
  const targets = await (await fetch(`http://127.0.0.1:${ inspectorPort }/json`)).json()
  const target = targets.find((x) => /postgresjs-profile/.test(x.title + x.url)) || targets[0]
  assert(target?.webSocketDebuggerUrl, 'No inspector target: ' + JSON.stringify(targets))
  const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'https://devtools.devprod.cloudflare.dev' } })
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('Inspector connection failed'))
  })
  const pending = new Map()
  let id = 0
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    pending.has(message.id) && (pending.get(message.id)(message), pending.delete(message.id))
  }
  return {
    send: (method, params = {}) => new Promise((resolve) => {
      pending.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    }),
    close: () => ws.close()
  }
}

function fileName(url) {
  return url.replace(/^.*\/profile\//, '').replace(/^file:\/\//, '')
}

function frameName({ functionName, url, lineNumber }) {
  return (functionName || '(anonymous)') + (url ? ' ' + fileName(url) + ':' + (lineNumber + 1) : '')
}

function moduleName({ functionName, url }) {
  if (!url) return functionName.startsWith('(') ? functionName : '(native)'
  return fileName(url).replace(/^release\//, '')
}

function selfTimes(profile) {
  const nodes = new Map(profile.nodes.map((x) => [x.id, x]))
  const byFunction = new Map()
      , byModule = new Map()
  let samples = 0
  const frames = profile.samples.map((id) => nodes.get(id).callFrame).filter((x) => x.functionName !== '(idle)')
  for (const frame of frames) {
    samples++
    const fn = frameName(frame)
        , mod = moduleName(frame)
    byFunction.set(fn, (byFunction.get(fn) || 0) + 1)
    byModule.set(mod, (byModule.get(mod) || 0) + 1)
  }
  return { samples, byFunction, byModule }
}

function interval(profiles) {
  const xs = profiles.flatMap((x) => x.timeDeltas).sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]
const ms = (us) => (us / 1000).toFixed(2)

function shuffled(xs) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = xs[i]
    xs[i] = xs[j]
    xs[j] = swap
  }
  return xs
}

function report(results, rounds, us) {
  const label = ({ build, scenario, types }) => `${ builds[build] }, ${ scenarios[scenario] }, fetch_types ${ types }`
  const stats = (xs) => {
    const sorted = xs.slice().sort((a, b) => a - b)
    return [0.5, 0.95, 0.99].map((p) => ms(pct(sorted, p) * us))
  }
  const totals = new Map()
  results.forEach((r) => r.byModule.forEach((n, k) => totals.set(k, (totals.get(k) || 0) + n)))
  const modules = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k)
  const lines = [
    `Local workerd (Wrangler ${ wranglerVersion }) with the V8 sampling profiler attached, one connection per request`
      + ` with SCRAM against PostgreSQL on the runner. ${ rounds } requests per variant after two warm-up rounds.`
      + ` Workerd samples only while JavaScript runs, about every ${ ms(us) } ms, so CPU is samples times that interval;`
      + ' native work between samples is missed. The profiler slows workerd down, so compare rows with each other, not with edge numbers.'
      + ' Times in ms.',
    '',
    '| Variant | n | CPU median | CPU p95 | CPU p99 | More than release, p | Less than release, p |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => {
      const samples = r.requests.map((x) => x.samples)
      const base = results.find((x) => x.variant.build === 'release' && x.variant.scenario === r.variant.scenario
        && x.variant.types === r.variant.types).requests.map((x) => x.samples)
      const ranks = r.variant.build === 'release'
        ? ['', '']
        : [rankTest(samples, base), rankTest(base, samples)].map((p) => p.toPrecision(2))
      return `| ${ label(r.variant) } | ${ r.requests.length } | ${ stats(samples).join(' | ') } | ${ ranks.join(' | ') } |`
    }),
    '',
    '### Share of samples by module',
    '',
    '| Module | ' + results.map((r) => label(r.variant)).join(' | ') + ' |',
    '| --- |' + results.map(() => ' --- |').join(''),
    ...modules.map((k) => `| ${ k } | ` + results.map((r) => (100 * (r.byModule.get(k) || 0) / r.total).toFixed(1) + '%').join(' | ') + ' |')
  ]
  for (const { variant, byFunction, total } of results.filter((x) => x.variant.build === 'cf')) {
    lines.push(
      '',
      `### ${ label(variant) }: top functions by self time`,
      '',
      '| Function | Share of samples |',
      '| --- | --- |',
      ...[...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 25)
        .map(([k, n]) => `| \`${ k.replace(/\|/g, '\\|') }\` | ${ (100 * n / total).toFixed(1) }% |`)
    )
  }
  return lines.join('\n')
}

async function main([outArg, databaseUrl, roundsArg]) {
  assert(outArg && databaseUrl, 'Usage: workerd-profile.mjs <dir> <database-url> [rounds]')
  const out = path.resolve(outArg)
      , rounds = Number(roundsArg) || 200
  await prepare(out, databaseUrl)
  const stop = dev(out)
  try {
    await ready()
    const inspect = await inspector()
    await inspect.send('Profiler.enable')
    await inspect.send('Profiler.setSamplingInterval', { interval: 50 })
    const results = variants.map((variant) => ({ variant, requests: [], byFunction: new Map(), total: 0 }))
    const profiles = []
    const failures = []
    for (let n = -2; n < rounds; n++) {
      for (const [v, variant] of shuffled([...variants.entries()])) {
        const query = new URLSearchParams({ case: variant.scenario, build: variant.build, target: 'supabase', fetch_types: variant.types })
        await inspect.send('Profiler.start')
        const res = await fetch(`http://127.0.0.1:${ devPort }/?${ query }`)
        const body = await res.json().catch(() => null)
        const { result } = await inspect.send('Profiler.stop')
        body?.passed || failures.push({ variant, n, status: res.status, error: body?.error?.message })
        if (n >= 0 && body?.passed) {
          const r = results[v]
              , times = selfTimes(result.profile)
          profiles.push(result.profile)
          r.requests.push({ samples: times.samples, byModule: times.byModule })
          r.total += times.samples
          times.byFunction.forEach((x, k) => r.byFunction.set(k, (r.byFunction.get(k) || 0) + x))
          const file = path.join(out + '-profiles', `${ variant.build }-${ variant.scenario }-${ variant.types }-${ n }.cpuprofile`)
          await writeFile(file, JSON.stringify(result.profile))
        }
      }
    }
    results.forEach((r) => r.byModule = r.requests.reduce(
      (acc, x) => (x.byModule.forEach((n, k) => acc.set(k, (acc.get(k) || 0) + n)), acc),
      new Map()
    ))
    inspect.close()
    const text = report(results, rounds, interval(profiles))
        + (failures.length ? `\n\n${ failures.length } requests failed: ${ JSON.stringify(failures.slice(0, 10)) }\n` : '\n')
    console.log(text)
    process.env.GITHUB_STEP_SUMMARY && await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Workers CPU profile\n\n' + text)
    failures.length && (process.exitCode = 1)
  } finally {
    stop()
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

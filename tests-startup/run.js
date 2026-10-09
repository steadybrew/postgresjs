/* eslint no-console: 0 */
import assert from 'assert'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import { leaseNames } from './lease.js'
import { compatNames } from './compat.js'
import { cfNames } from './cf.js'

const ownershipNames = ['capacity', 'no-fetch-capacity', 'mixed-1-fetch', 'mixed-3-fetch', 'mixed-1-no-fetch', 'mixed-3-no-fetch',
                        'queued-reconnect', 'queued-drain', 'assigned-order', 'startup-drain', 'creation-failure',
                        'authentication-failure', 'startup-end']

const startupNames = ['first-types', 'first-types-no-fetch', 'first-types-transform', 'session-transform',
                      'catalog-error-reserve', 'catalog-error-query', 'session-error', 'catalog-close',
                      'stale-error', 'retry-bound', 'retry-stalled', 'long-backoff', 'server-budget', 'retry-zero', 'stalled', 'catalog-stalled',
                      'session-stalled', 'factory-timeout', 'factory-reject', 'factory-end', 'factory-multi',
                      'pending-write', 'password-late', 'password-reject', 'failure-drain', 'failover', 'session-select',
                      'budget-reset', 'end-backoff', 'graceful-startup-close', 'copy-close', 'copy-close-in',
                      'copy-final-close', 'password-close', 'half-open-end', 'graceful-queued-query', 'graceful-queued-reserve',
                      'graceful-first-query', 'forced-queued-query', 'forced-queued-reserve',
                      'backoff-end-query', 'backoff-end-reserve', 'backoff-close']

const phaseNames = ['stale-ending-lifetime', 'stale-ending-close', 'stale-ending-rst', 'backoff-budget', 'tls-throw', 'reserve-end',
                    'cancel-initial', 'factory-backoff', 'fin-inflight', 'rst-inflight', 'gap-query', 'all-down', 'churn',
                    'failover-timeout', 'late-error', 'drain-pipeline', 'drain-reserved', 'drain-reservation-queued', 'release-closed',
                    'prefer-standby-first', 'prefer-standby-last', 'outage-recover', 'forced-queued', 'reentrant-onclose', 'fatal-storm',
                    'cancel-errors', 'fatal-backoff', 'gap-query-pool', 'gap-listen',
                    'begin-socket-cause', 'begin-fatal-inflight', 'fatal-initializing', 'fatal-initializing-inflight',
                    'cancel-pipelined', 'cancel-pipelined-lost', 'cancel-settled', 'cancel-request-tls-error',
                    'cancel-request-refused', 'cancel-unawaited',
                    'first-query-pipeline', 'release-inflight', 'draining-release-busy',
                    'ending-queued-reconnect', 'ending-queued-down', 'ending-other-open']

const childPath = fileURLToPath(new URL('./case.js', import.meta.url))

async function run(name, deadline = name.startsWith('phase:') ? 8000 : 5000) {
  const start = Date.now()
  const child = fork(childPath, [name, process.argv.includes('--cjs') ? 'cjs' : 'esm'], { execArgv: ['--unhandled-rejections=strict'], silent: true })
  let output = ''
  let completed = false
  let timedOut = false
  let events = []
  child.stdout.on('data', x => output += x)
  child.stderr.on('data', x => output += x)
  child.on('message', x => {
    completed = x.completed === name || completed
    x.events && (events = x.events)
    x.event && events.push(x.event)
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, deadline)
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ name, code, signal, completed, timedOut, events, output,
                                                    elapsed: Date.now() - start }))
  }).finally(() => clearTimeout(timer))
  result.passed = result.code === 0 && result.completed && !result.timedOut
  return result
}

async function main() {
  if (process.argv.includes('--phases')) {
    for (const name of phaseNames) {
      const result = await run('phase:' + name, 8000)
      console.log(JSON.stringify({ name, passed: result.passed, elapsed: result.elapsed, output: result.output.slice(0, 300) }))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  if (process.argv.includes('--startup-failures')) {
    for (const name of startupNames) {
      const result = await run('startup:' + name)
      console.log(JSON.stringify(result))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  if (process.argv.includes('--integration')) {
    const result = await run('integration', 30000)
    assert(result.passed, JSON.stringify(result))
    console.log('PASS real PostgreSQL ownership matrix')
    return
  }
  if (process.argv.includes('--leases')) {
    for (const name of leaseNames) {
      const result = await run('lease:' + name)
      console.log(JSON.stringify({ name, passed: result.passed, elapsed: result.elapsed, output: result.output.slice(0, 300) }))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  if (process.argv.includes('--compat')) {
    for (const name of [...compatNames.map(x => 'compat:' + x), ...cfNames.map(x => 'cf:' + x)]) {
      const result = await run(name)
      console.log(JSON.stringify({ name, passed: result.passed, elapsed: result.elapsed, output: result.output.slice(0, 300) }))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  if (process.argv.includes('--ownership')) {
    for (const name of ownershipNames) {
      const result = await run('ownership:' + name)
      console.log(JSON.stringify(result))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  if (process.argv.includes('--regressions')) {
    for (const name of [...startupNames.map(x => 'startup:' + x), ...phaseNames.map(x => 'phase:' + x), ...leaseNames.map(x => 'lease:' + x),
                        ...compatNames.map(x => 'compat:' + x), ...cfNames.map(x => 'cf:' + x)]) {
      const result = await run(name)
      console.log(JSON.stringify(result))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  for (const name of ['frames', 'cold-query', 'cold-query-no-fetch', 'cold-reserve', 'cold-reserve-no-fetch',
                      ...ownershipNames.map(x => 'ownership:' + x), ...startupNames.map(x => 'startup:' + x),
                      ...phaseNames.map(x => 'phase:' + x), ...leaseNames.map(x => 'lease:' + x),
                      ...compatNames.map(x => 'compat:' + x), ...cfNames.map(x => 'cf:' + x)]) {
    const result = await run(name)
    assert(result.passed, JSON.stringify(result))
    console.log('PASS ' + name)
  }
  const hung = await run('watchdog-hang', 500)
  assert(hung.timedOut && !hung.passed && hung.signal === 'SIGKILL')
  const unhandled = await run('watchdog-unhandled')
  assert(!unhandled.passed && unhandled.code !== 0 && unhandled.output.includes('sentinel unhandled rejection'))
  const empty = await run('watchdog-empty')
  assert(empty.code === 0 && !empty.completed && !empty.passed)
  console.log('PASS watchdog rejects hangs, unhandled rejections, and empty successful exits')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

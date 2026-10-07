/* eslint no-console: 0 */
import assert from 'assert'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'

const childPath = fileURLToPath(new URL('./case.js', import.meta.url))

async function run(name, deadline = 5000) {
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
  if (process.argv.includes('--regressions')) {
    for (const name of ['cold-reserve-no-fetch', 'catalog-error']) {
      const result = await run(name)
      console.log(JSON.stringify(result))
      !result.passed && (process.exitCode = 1)
    }
    return
  }
  for (const name of ['frames', 'cold-query', 'cold-reserve']) {
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

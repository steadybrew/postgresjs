import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const [side, suite, ws, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })

const setups = {
  simulate: { entry: 'tests/simulate.js', env: { MAXFAIL: '200' } },
  'simulate-globals': { entry: 'tests/simulate.js', env: { MAXFAIL: '200', GLOBALS: '1' } },
  'simulate-globals-nobatch': { entry: 'tests/simulate.js', env: { MAXFAIL: '200', GLOBALS: '1' } },
  failover: { entry: 'tests/failover.js', env: {} }
}
const { entry, env } = setups[suite]

const log = path.join(out, 'script.log')
const sink = fs.createWriteStream(log)
const started = Date.now()
const result = await new Promise(resolve => {
  const child = spawn(process.execPath, [entry], { cwd: ws, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(sink, { end: false })
  child.stderr.pipe(sink, { end: false })
  let killed = false
  const timer = setTimeout(() => (killed = true, child.kill('SIGKILL')), 40 * 60 * 1000)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    sink.end(() => resolve({ code, signal, killed, ms: Date.now() - started }))
  })
})

const text = fs.readFileSync(log, 'utf8')
const seeds = []
const re = /⛔️ SEED=(\d+) \(([^)]+)\)\n((?: {2}.*\n?)*)/g
for (const m of text.matchAll(re))
  seeds.push({ seed: +m[1], scenario: m[2], violations: m[3].split('\n').map(x => x.trim()).filter(Boolean) })

const summary = { side, suite, process: result, tail: text.slice(-4000), seeds }
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(side, suite, JSON.stringify(result), 'failing seeds', seeds.length)

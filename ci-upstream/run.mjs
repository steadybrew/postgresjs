import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const [side, suite, ws, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })

const entry = suite === 'unit' ? 'tests/unit/index.js' : 'tests/' + suite + '.js'
const fileTimeout = 25 * 60
const isolatedTimeout = 120
const isolatedRuns = 2

function run(args, env, timeout, log) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, args, { cwd: ws, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = fs.createWriteStream(log)
    child.stdout.pipe(sink, { end: false })
    child.stderr.pipe(sink, { end: false })
    let killed = false
    const timer = setTimeout(() => (killed = true, child.kill('SIGKILL')), timeout * 1000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      sink.end()
      resolve({ code, signal, killed, ms: Date.now() - started })
    })
  })
}

function read(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x))
    : []
}

function outcome(events, line, name) {
  const hit = events.find(x => (x.event === 'pass' || x.event === 'fail') && x.line === line && x.name === name)
  return hit ? { result: hit.event, ms: hit.ms, error: hit.error } : { result: 'none' }
}

const fileResults = path.join(out, 'file.jsonl')
const file = await run([entry], { RESULTS: fileResults }, fileTimeout, path.join(out, 'file.log'))
const events = read(fileResults)
const registered = events.filter(x => x.event === 'registered')

const tests = registered.map(x => ({ line: x.line, name: x.name, file: outcome(events, x.line, x.name), isolated: [] }))

let n = 0
for (const t of tests.filter(x => x.file.result !== 'pass')) {
  for (let k = 0; k < isolatedRuns; k++) {
    const id = ++n
    const results = path.join(out, 'iso-' + id + '.jsonl')
    const proc = await run([entry, t.name], { RESULTS: results }, isolatedTimeout, path.join(out, 'iso-' + id + '.log'))
    const iso = read(results)
    t.isolated.push({ id, ...outcome(iso, t.line, t.name), code: proc.code, killed: proc.killed, strays: iso.filter(x => x.event === 'stray').length })
  }
}

const summary = {
  side,
  suite,
  process: file,
  exited: events.some(x => x.event === 'exit'),
  strays: events.filter(x => x.event === 'stray'),
  tests
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))

const count = k => tests.filter(x => x.file.result === k).length
console.log(side, suite, 'registered', tests.length, 'pass', count('pass'), 'fail', count('fail'), 'none', count('none'),
  'isolated pass', tests.filter(x => x.isolated.some(y => y.result === 'pass')).length, 'process', JSON.stringify(file))

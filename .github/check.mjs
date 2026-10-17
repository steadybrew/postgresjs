import { fork, spawn } from 'child_process'

const index = (issue, name) => ({ issue, name, kind: 'index' })
const kase = (issue, name, limit = 15000) => ({ issue, name, kind: 'case', limit })

const cases = [
  index('upstream 1049', 'SQL null in a smallint[] column with fetch_types=true'),
  index('upstream 1124', 'SQL null in array_agg of a text column with fetch_types=true'),
  kase('upstream 1250', 'startup:pending-write-statement'),
  kase('upstream 1255', 'lease:owned-lifetime-reserve'),
  kase('upstream 1255', 'lease:reserve-end-release'),
  kase('upstream 1252', 'report:cancel-pipelined-reserve'),
  index('#68', 'A query that fails after returning rows does not offset the rows of the next query'),
  index('upstream 1181', 'A query pipelined behind one that fails after returning rows has no empty slots'),
  index('upstream 1253', 'A query cancelled after returning rows does not offset the rows of the next query'),
  kase('#69', 'copy:out-done-paused'),
  kase('#69', 'copy:out-error-paused'),
  index('#49', 'Environment false and disable values turn options off'),
  kase('#60', 'startup:session-standby-reported'),
  kase('#60', 'startup:session-read-only-standby-reported'),
  index('#83', 'toCamel and toPascal keep a trailing underscore'),
  kase('#123', 'report:cancel-pipelined-cached-plan'),
  kase('#130', 'phase:cancel-query-unawaited'),
  kase('#130', 'report:cancel-inflight-unawaited'),
  ...(process.env.EXTRA_CASES || '').split(',').filter(Boolean).map(x => x.startsWith('index:') ? index('#130', x.slice(6)) : kase('#130', x))
]

const run = test => new Promise(resolve => {
  const start = Date.now()
  let output = ''
  let completed = false
  let timedOut = false
  const child = test.kind === 'index'
    ? spawn('node', ['tests/index.js'], { env: { ...process.env, ONLY_TEST: test.name } })
    : fork('tests-startup/case.js', [test.name, 'esm'], { execArgv: ['--unhandled-rejections=strict'], silent: true })
  child.stdout.on('data', x => output += x)
  child.stderr.on('data', x => output += x)
  child.on('message', x => completed = completed || x.completed !== undefined)
  const timer = setTimeout(() => (timedOut = true, child.kill('SIGKILL')), test.limit || 60000)
  child.on('close', code => {
    clearTimeout(timer)
    const ran = test.kind !== 'index' || output.includes('✅') || output.includes('⛔️')
    const passed = test.kind === 'index' ? code === 0 && output.includes('✅') && !output.includes('⛔️') : code === 0 && completed && !timedOut
    resolve({ issue: test.issue, name: test.name, passed, ran, timedOut, code, ms: Date.now() - start, output: output.slice(0, 1800) })
  })
})

for (const test of cases)
  console.log(JSON.stringify(await run(test)))

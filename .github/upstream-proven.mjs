import { fork, spawn } from 'child_process'

const hung = /^$/
const index = (upstream, name, expect) => ({ upstream, name, expect, kind: 'index' })
const startup = (upstream, name, expect, limit = 12000) => ({ upstream, name, expect, kind: 'case', limit })
const integration = (upstream, only, expect) => ({ upstream, name: 'integration:' + only, only, expect, kind: 'integration' })

const cases = [
  index('1082', 'an undefined value in a transaction rejects with UNDEFINED_VALUE and the pool keeps working', /hung/),
  index('729', 'an undefined value behind a running query rejects alone', /hung|1,"hung|"h","u","n","g"/),
  index('1234', 'concurrent statements in a transaction after a cached plan changes roll back and free the connection', /hung|25P02/),
  index('1217', 'sql.begin rejects when COMMIT rolls back after a caught savepoint whose rollback to failed', /"3B001",null/),
  index('1217', 'sql.begin rejects when the server rolls the transaction back at commit', /\[null,null,0/),
  index('1063', 'onnotice false ignores notices', /0 != 1/),
  index('1087', 'subscribing and unsubscribing leaves no error listeners behind', /MaxListeners|\[[1-9]/),
  index('789', 'Built-in array roundtrips with fetch_types=false', /malformed array literal/),
  index('789', 'Built-in array roundtrips with fetch_types=true', /malformed array literal/),
  startup('789', 'startup:first-types', /1009|25/),
  integration('789', 'firstTypes', /malformed array literal/),
  startup('751,1219', 'cold-reserve-no-fetch', hung, 8000),
  integration('751,1219', 'combination:1:false:true', hung),
  integration('751,1219', 'combination:3:false:true', hung),
  startup('1195', 'ownership:queued-reconnect', hung, 8000),
  integration('1195', 'combination:1:true:true', hung),
  startup('1249', 'phase:error-close-reconnect', /division by zero/),
  startup('1097', 'phase:fin-inflight', hung, 8000),
  integration('1097', 'endAfterTerminate', /hung/),
  startup('1130', 'phase:rst-inflight', hung, 8000),
  startup('1193', 'phase:cause-single-close', hung, 8000),
  startup('1193,1179', 'phase:churn', /attempts|\d{3,}/, 8000),
  startup('1192,1205', 'startup:catalog-error-query', /unhandled|catalog denied|Unhandled/),
  startup('1205', 'startup:catalog-error-reserve', /unhandled|catalog denied|Unhandled/),
  startup('1086', 'phase:fatal-catalog', /terminating|Uncaught|unhandled|Unhandled|server login/, 8000),
  startup('1174', 'phase:prefer-standby-first', hung, 8000),
  startup('1174', 'phase:prefer-standby-last', hung, 8000),
  startup('1174', 'phase:all-down', hung, 8000),
  integration('1174', 'preferStandby', hung),
  integration('1174', 'refused', /Refusal must retry|ECONNREFUSED/),
  startup('1210', 'lease:begin-pipeline-zero', /UNSAFE_TRANSACTION|'queue'/),
  integration('1210', 'owned:0', /UNSAFE_TRANSACTION|'queue'/)
]

const only = process.argv.slice(2)
const run = test => new Promise(resolve => {
  const start = Date.now()
  let output = ''
  let completed = false
  let timedOut = false
  const limit = test.limit || (test.kind === 'index' ? 60000 : 60000)
  const child = test.kind === 'index'
    ? spawn('node', ['tests/index.js'], { env: { ...process.env, ONLY_TEST: test.name } })
    : fork('tests-startup/case.js', [test.kind === 'integration' ? 'integration' : test.name, 'esm'], {
      execArgv: ['--unhandled-rejections=strict'], silent: true, env: { ...process.env, ...(test.only ? { INTEGRATION_ONLY: test.only } : {}) }
    })
  child.stdout.on('data', x => output += x)
  child.stderr.on('data', x => output += x)
  child.on('message', x => completed = completed || x.completed !== undefined)
  const timer = setTimeout(() => (timedOut = true, child.kill('SIGKILL')), limit)
  child.on('close', code => {
    clearTimeout(timer)
    const passed = test.kind === 'index' ? code === 0 && output.includes('✅') : code === 0 && completed && !timedOut
    const ran = test.kind !== 'index' || output.includes('✅') || output.includes('⛔️')
    resolve({ upstream: test.upstream, name: test.name, passed, timedOut, ran, matches: test.expect.test(output) || (test.expect === hung && timedOut),
              code, ms: Date.now() - start, output: output.slice(0, 2200) })
  })
})

for (const test of cases) {
  if (only.length && !only.includes(test.upstream.split(',')[0]))
    continue
  const result = await run(test)
  console.log(JSON.stringify(result))
}

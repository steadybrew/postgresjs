import { fork, spawn } from 'child_process'

const index = (issue, name) => ({ issue, name, kind: 'index' })
const kase = (issue, name, limit = 15000) => ({ issue, name, kind: 'case', limit })

const cases = [
  index('upstream 1227', 'Query errors keep a writable stack')
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

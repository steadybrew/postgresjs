import { fork } from 'child_process'

const name = process.argv[2]
const child = fork('tests-startup/case.js', [name, 'esm'], { execArgv: ['--unhandled-rejections=strict'], silent: true })
let output = ''
let completed = false
child.stdout.on('data', x => output += x)
child.stderr.on('data', x => output += x)
child.on('message', x => { completed = x.completed === name || completed })
const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
child.on('close', code => {
  clearTimeout(timer)
  console.log(JSON.stringify({ name, passed: code === 0 && completed, output: output.slice(0, 1500) }))
})

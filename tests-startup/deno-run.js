/* eslint no-console: 0, no-process-env: 0 */
import assert from 'assert'
import { spawn } from 'child_process'

const child = spawn(process.env.DENO_BIN || 'deno', ['test', '--no-lock', '--allow-all', 'tests-startup/deno-socket.js'], {
  env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
let timedOut = false
child.stdout.on('data', x => output += x)
child.stderr.on('data', x => output += x)
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 10000)
child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
child.once('close', (code, signal) => {
  clearTimeout(timer)
  try {
    assert(!timedOut && code === 0 && /4 passed\s*[|;]\s*0 failed/.test(output), JSON.stringify({ code, signal, timedOut, output }))
    console.log('PASS Deno pending TCP/TLS socket cleanup (4 cases)')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
})

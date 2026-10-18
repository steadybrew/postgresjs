/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, cp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'

async function blackhole() {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(resolve)
    })
  }
}

async function main() {
  const repo = path.resolve(process.argv[2] || '.')
  const pgPort = Number(process.argv[3])
  const wrangler = process.env.WRANGLER_BIN || 'wrangler'
  const version = spawnSync(wrangler, ['--version'], { encoding: 'utf8' })
  assert(version.status === 0 && /\b4\.151\.1\b/.test(version.stdout), 'Requires pinned Wrangler 4.151.1')
  assert(pgPort > 0, 'Pass the disposable PostgreSQL TCP port as second argument')
  const { peer } = await import(pathToFileURL(path.join(repo, 'tests-startup/peer.js')))
  const work = await mkdtemp(path.join(tmpdir(), 'postgresjs-workerd-'))
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function freePorts(count) {
    const servers = []
    for (let i = 0; i < count; i++) {
      const server = net.createServer()
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      servers.push(server)
    }
    const ports = servers.map((server) => server.address().port)
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    return ports
  }
  const tlsPort = Number(process.env.WORKERD_TLS_PORT) || 0
  const tlsScenarios = ['end-tls', 'tls-untrusted-ca']
  const peerScenarios = ['cold-reserve-false', 'catalog-error']
  try {
    await cp(path.join(repo, 'cf'), path.join(work, 'cf'), { recursive: true })
    await cp(new URL('./workerd-worker.js', import.meta.url), path.join(work, 'worker.js'))
    await writeFile(path.join(work, 'driver.js'), 'export { default } from \'./cf/src/index.js\'\n')
    await writeFile(
      path.join(work, 'wrangler.json'),
      JSON.stringify({
        name: 'postgresjs-startup-local-validation',
        main: 'worker.js',
        compatibility_date: process.env.WORKERD_COMPAT_DATE || '2025-01-01',
        compatibility_flags: ['nodejs_compat'],
        send_metrics: false
      })
    )
    const knownFailures = (process.env.WORKERD_KNOWN_FAILURES || '').split(',').filter(Boolean)
    const scenarios = process.argv[4]
      ? process.argv[4].split(',')
      : [
        'cold-reserve-false', 'arrays-false', 'arrays-true', 'catalog-error',
        'timers', 'connect-timeout', 'end-timeout', 'end-plain', 'end-while-connecting',
        'copy-out', 'ssl-prefer-declined', 'subscribe', 'diagnostics-channel',
        ...(tlsPort && process.env.WORKERD_TLS_CA ? tlsScenarios : [])
      ]
    for (const name of scenarios) {
      if (tlsScenarios.includes(name)) assert(tlsPort > 0 && process.env.WORKERD_TLS_CA, name + ' requires WORKERD_TLS_PORT and WORKERD_TLS_CA')
      let attempt = await run(name)
      if (attempt.failure && attempt.output.includes('Address already in use'))
        attempt = await run(name)
      const { failure, detail, output } = attempt
      const expected = knownFailures.includes(name)
      if (Boolean(failure) !== expected) process.exitCode = 1
      await writeFile(path.join(work, name + '.log'), output)
      console.log(JSON.stringify({
        name,
        passed: !failure,
        ...(expected ? { knownFailure: true } : {}),
        result: detail,
        error: failure?.message,
        log: path.join(work, name + '.log')
      }))
    }
    console.log(JSON.stringify({ artifacts: work }))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }

  async function run(name) {
    const silent = name === 'connect-timeout' ? await blackhole() : null
    const fixture = peerScenarios.includes(name) ? await peer({ catalogError: name === 'catalog-error' }) : null
    const [port, inspector] = await freePorts(2)
    const child = spawn(
      wrangler,
      [
        'dev',
        '--local',
        '--config',
        path.join(work, 'wrangler.json'),
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        String(inspector),
        '--show-interactive-dev-session=false'
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        ...(name === 'end-tls' ? { SSL_CERT_FILE: process.env.WORKERD_TLS_CA || process.env.SSL_CERT_FILE || '' } : {})
      } }
    )
    let output = ''
      , failure
      , detail
    child.stdout.on('data', (x) => (output += x))
    child.stderr.on('data', (x) => (output += x))
    const closed = new Promise((resolve) => child.once('close', resolve))
    const watchdog = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Process may have already exited or listener may not be ready. */
      }
    }, 25000)
    try {
      let ready = false
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) break
        try {
          const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(100) })
          ready = res.ok
        } catch {
          /* Process may have already exited or listener may not be ready. */
        }
        if (ready) break
        await pause(100)
      }
      assert(ready, 'workerd failed to start: ' + output)
      const target = silent?.port || fixture?.port || (tlsScenarios.includes(name) ? tlsPort : pgPort)
      const res = await fetch('http://127.0.0.1:' + port + '/?case=' + name + '&port=' + target, {
        signal: AbortSignal.timeout(15000)
      })
      const body = await res.json()
      detail = body.result
      await pause(150)
      assert(res.ok && body.passed, JSON.stringify(body))
      const fatal = /WORKER_UNHANDLED_REJECTION|Uncaught|unhandled rejection|parameter \d+ is not of type/i
      const closing = /Stream was cancelled|This socket has been closed/
      assert(!output.split('\n').some((line) => fatal.test(line) && !closing.test(line)), output)
      if (fixture && name === 'cold-reserve-false') assert.equal(fixture.events.filter((x) => x.type === 'P').length, 0)
      if (fixture && name === 'catalog-error') assert.equal(fixture.events.filter((x) => x.type === 'Q').length, 0)
    } catch (error) {
      failure = error
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Process may have already exited or listener may not be ready. */
      }
      await closed
      clearTimeout(watchdog)
      if (fixture) await fixture.close()
      if (silent) await silent.close()
    }
    return { failure, detail, output }
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

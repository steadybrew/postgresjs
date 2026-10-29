/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'

const wranglerVersion = '4.151.1'

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

function within(promise, ms, label) {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' did not settle within ' + ms + 'ms')), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

async function main() {
  const repo = path.resolve(process.argv[2] || '.')
  const pgPort = Number(process.argv[3])
  const require = createRequire(path.join(repo, 'package.json'))
  assert.equal(require('wrangler/package.json').version, wranglerVersion, 'Requires pinned Wrangler ' + wranglerVersion)
  assert(pgPort > 0, 'Pass the disposable PostgreSQL TCP port as second argument')
  const { createTestHarness } = await import(pathToFileURL(require.resolve('wrangler')))
  const { peer } = await import(pathToFileURL(path.join(repo, 'tests-startup/peer.js')))
  const work = await mkdtemp(path.join(tmpdir(), 'postgresjs-workerd-'))
  const tlsPort = Number(process.env.WORKERD_TLS_PORT) || 0
  const tlsScenarios = ['end-tls', 'tls-untrusted-ca']
  const peerScenarios = ['cold-reserve-false', 'catalog-error']
  const closeRejectionsLogged = process.env.WORKERD_CLOSE_REJECTIONS === 'logged'
  const servers = new Map()

  async function trusting(trustedCa, fn) {
    const previous = process.env.SSL_CERT_FILE
    trustedCa ? process.env.SSL_CERT_FILE = trustedCa : delete process.env.SSL_CERT_FILE
    try {
      return await fn()
    } finally {
      previous === undefined ? delete process.env.SSL_CERT_FILE : process.env.SSL_CERT_FILE = previous
    }
  }

  function server(trustedCa) {
    if (servers.has(trustedCa))
      return servers.get(trustedCa)

    const harness = createTestHarness({
      root: work,
      workers: [{
        config: {
          name: 'postgresjs-startup-local-validation',
          main: path.join(work, 'worker.js'),
          compatibility_date: process.env.WORKERD_COMPAT_DATE || '2025-01-01',
          compatibility_flags: ['nodejs_compat', ...(process.env.WORKERD_COMPAT_FLAGS || '').split(',').filter(Boolean)]
        }
      }]
    })
    servers.set(trustedCa, harness)
    return harness
  }

  try {
    await mkdir(path.join(work, 'node_modules/@steadybrew'), { recursive: true })
    await symlink(repo, path.join(work, 'node_modules/@steadybrew/postgresjs'), 'dir')
    await cp(new URL('./workerd-worker.js', import.meta.url), path.join(work, 'worker.js'))
    await writeFile(path.join(work, 'driver.js'), 'export { default } from \'@steadybrew/postgresjs\'\n')
    const scenarios = process.argv[4]
      ? process.argv[4].split(',')
      : [
        'cold-reserve-false', 'arrays-false', 'arrays-true', 'catalog-error',
        'timers', 'connect-timeout', 'end-timeout', 'end-plain', 'end-while-connecting',
        'copy-out', 'ssl-prefer-declined', 'subscribe', 'diagnostics-channel', 'no-end',
        ...(tlsPort && process.env.WORKERD_TLS_CA ? tlsScenarios : [])
      ]
    for (const name of scenarios) {
      if (tlsScenarios.includes(name)) assert(tlsPort > 0 && process.env.WORKERD_TLS_CA, name + ' requires WORKERD_TLS_PORT and WORKERD_TLS_CA')
      const { failure, detail, output, unhandled } = await run(name)
      if (failure) process.exitCode = 1
      const closeRejections = unhandled.filter((x) => /Stream was cancelled|This socket has been closed|Network connection lost/.test(x)).length
      if (closeRejections && !closeRejectionsLogged) process.exitCode = 1
      await writeFile(path.join(work, name + '.log'), output)
      console.log(JSON.stringify({
        name,
        passed: !failure,
        result: detail,
        closeRejections,
        error: failure?.message,
        log: path.join(work, name + '.log')
      }))
    }
    console.log(JSON.stringify({ artifacts: work }))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    for (const harness of servers.values()) await harness.close()
  }

  async function released(harness, port, tag) {
    const start = Date.now()
    for (;;) {
      const { result } = await (await harness.fetch('/?case=backends&port=' + port + '&tag=' + tag)).json()
      if (result?.n === 0)
        return { releasedAfterMs: Date.now() - start }
      assert(Date.now() - start < 10000, 'The connection the request left open still has a backend after 10 s')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async function run(name) {
    const silent = name === 'connect-timeout' ? await blackhole() : null
    const fixture = peerScenarios.includes(name) ? await peer({ catalogError: name === 'catalog-error' }) : null
    const trustedCa = name === 'end-tls' ? process.env.WORKERD_TLS_CA : ''
    const harness = server(trustedCa)
    let failure
      , detail
      , body
    try {
      await trusting(trustedCa, async() => {
        await harness.listen()
        await harness.reset()
        await harness.listen()
      })
      const target = silent?.port || fixture?.port || (tlsScenarios.includes(name) ? tlsPort : pgPort)
      const tag = name === 'no-end' ? 'no-end-' + Date.now().toString(36) : ''
      const res = await within(harness.fetch('/?case=' + name + '&port=' + target + (tag ? '&tag=' + tag : '')), 15000, name)
      body = await res.json()
      detail = body.result
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert(res.ok && body.passed, JSON.stringify(body))
      if (tag) detail = { ...detail, ...await released(harness, target, tag) }
      const closing = /Stream was cancelled|This socket has been closed|Network connection lost/
      const fatal = /WORKER_UNHANDLED_REJECTION|Uncaught|unhandled rejection|parameter \d+ is not of type/i
      const errors = harness.getLogs().map((x) => String(x.message)).filter((x) => fatal.test(x) && !closing.test(x))
      assert.deepEqual(errors, [], 'Worker errors: ' + errors.join('\n'))
      if (fixture && name === 'cold-reserve-false') assert.equal(fixture.events.filter((x) => x.type === 'P').length, 0)
      if (fixture && name === 'catalog-error') assert.equal(fixture.events.filter((x) => x.type === 'Q').length, 0)
    } catch (error) {
      failure = error
    } finally {
      if (fixture) await fixture.close()
      if (silent) await silent.close()
    }
    const logs = harness.getLogs().map((x) => String(x.message))
    const output = logs.join('\n')
    return { failure, detail, output, unhandled: logs.filter((x) => x.includes('WORKER_UNHANDLED_REJECTION')) }
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

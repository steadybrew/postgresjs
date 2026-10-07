/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, cp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'

async function main() {
  const repo = path.resolve(process.argv[2] || '.')
  const pgPort = Number(process.argv[3])
  const wrangler = process.env.WRANGLER_BIN || 'wrangler'
  const version = spawnSync(wrangler, ['--version'], { encoding: 'utf8' })
  assert(version.status === 0 && /\b4\.123\.0\b/.test(version.stdout), 'Requires pinned Wrangler4.123.0')
  assert(pgPort > 0, 'Pass the disposable PostgreSQL TCP port as second argument')
  const { peer } = await import(pathToFileURL(path.join(repo, 'tests-startup/peer.js')))
  const work = await mkdtemp(path.join(tmpdir(), 'postgresjs-workerd-'))
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function freePort() {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
  }
  try {
    await cp(path.join(repo, 'cf'), path.join(work, 'cf'), { recursive: true })
    await cp(new URL('./workerd-worker.js', import.meta.url), path.join(work, 'worker.js'))
    await writeFile(
      path.join(work, 'wrangler.json'),
      JSON.stringify({
        name: 'postgresjs-startup-local-validation',
        main: 'worker.js',
        compatibility_date: '2025-01-01',
        compatibility_flags: ['nodejs_compat'],
        send_metrics: false
      })
    )
    for (const name of process.argv[4]
      ? process.argv[4].split(',')
      : ['cold-reserve-false', 'arrays-false', 'arrays-true', 'catalog-error']) {
      const fixture = name.startsWith('arrays') ? null : await peer({ catalogError: name === 'catalog-error' })
      const port = await freePort()
          , inspector = await freePort()
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
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
      )
      let output = ''
        , failure
      child.stdout.on('data', (x) => (output += x))
      child.stderr.on('data', (x) => (output += x))
      const closed = new Promise((resolve) => child.once('close', resolve))
      const watchdog = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Process may have already exited or listener may not be ready. */
        }
      }, 20000)
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
        const res = await fetch('http://127.0.0.1:' + port + '/?case=' + name + '&port=' + (fixture?.port || pgPort), {
          signal: AbortSignal.timeout(5000)
        })
        const body = await res.json()
        await pause(150)
        assert(res.ok && body.passed, JSON.stringify(body))
        assert(!/WORKER_UNHANDLED_REJECTION|Uncaught|unhandled rejection/i.test(output), output)
        if (fixture && name === 'cold-reserve-false') assert.equal(fixture.events.filter((x) => x.type === 'P').length, 0)
        if (fixture && name === 'catalog-error') assert.equal(fixture.events.filter((x) => x.type === 'Q').length, 0)
      } catch (error) {
        failure = error
        process.exitCode = 1
      } finally {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Process may have already exited or listener may not be ready. */
        }
        await closed
        clearTimeout(watchdog)
        if (fixture) await fixture.close()
      }
      await writeFile(path.join(work, name + '.log'), output)
      console.log(JSON.stringify({ name, passed: !failure, error: failure?.message, log: path.join(work, name + '.log') }))
    }
    console.log(JSON.stringify({ artifacts: work }))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/* eslint no-console: 0, no-process-env: 0 */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const scenarios = [
  'arrays-false', 'arrays-true', 'timers', 'end-timeout', 'end-plain', 'end-while-connecting', 'end-tls',
  'copy-out', 'subscribe', 'diagnostics-channel', 'ssl-verify', 'pooled'
]
const hyperdrive = [
  { binding: 'HYPERDRIVE', id: '6cac003bd1af42849ca7e83e125d5a3d' },
  { binding: 'HYPERDRIVE_POOLED', id: 'ebb0176610db40e99887ede1f4fd7e66' }
]
const closing = /Stream was cancelled|This socket has been closed/

async function prepare(out, compatibilityDate) {
  const repo = path.resolve(new URL('..', import.meta.url).pathname)
  await mkdir(out, { recursive: true })
  await cp(path.join(repo, 'cf'), path.join(out, 'cf'), { recursive: true })
  await cp(path.join(repo, 'src'), path.join(out, 'src'), { recursive: true })
  await cp(path.join(repo, 'tests-startup/workerd-worker.js'), path.join(out, 'worker.js'))
  await writeFile(path.join(out, 'driver.js'), [
    'export { default } from \'./cf/src/index.js\'',
    'export { default as cf } from \'./cf/src/index.js\'',
    'export { default as src } from \'./src/index.js\'',
    ''
  ].join('\n'))
  await writeFile(path.join(out, 'wrangler.json'), JSON.stringify({
    name: 'postgresjs-edge',
    main: 'worker.js',
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    observability: { enabled: true },
    hyperdrive,
    previews: { observability: { enabled: true }, hyperdrive }
  }, null, 2))
}

function previewUrl(value) {
  if (typeof value === 'string')
    return /^https:\/\/\S+\.workers\.dev\/?$/.test(value) ? value : null
  if (value && typeof value === 'object') {
    for (const x of Object.values(value)) {
      const found = previewUrl(x)
      if (found) return found
    }
  }
  return null
}

async function run(base) {
  const token = process.env.EDGE_TOKEN
  assert(token, 'EDGE_TOKEN is required')
  const known = (process.env.EDGE_KNOWN_FAILURES || '').split(',').filter(Boolean)
  const headers = { authorization: 'Bearer ' + token }
  const deadline = Date.now() + 120000
  while ((await fetch(new URL('/health', base), { headers }).catch(() => null))?.status !== 200) {
    assert(Date.now() < deadline, 'The Preview did not serve this deployment within 120 seconds')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const rounds = Number(process.env.EDGE_HYPERDRIVE_ROUNDS) || 5
  for (const build of ['cf', 'src']) {
    for (const name of [...scenarios, ...Array(rounds).fill(['hyperdrive', 'hyperdrive-pooled']).flat()]) {
      let body
        , failure
        , platformErrors = 0
        , waitedMs = 0
      try {
        let res
        for (;;) {
          res = await fetch(new URL('/?case=' + name + '&build=' + build, base), {
            headers,
            signal: AbortSignal.timeout(30000)
          })
          const fromWorker = res.ok || (res.headers.get('content-type') || '').includes('json')
          const wait = retryAfter(res.headers.get('retry-after')) ?? Math.min(2000 * 2 ** platformErrors, 30000)
          if (fromWorker || waitedMs + wait > 180000)
            break
          platformErrors++
          waitedMs += wait
          await res.body?.cancel()
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
        assert.notEqual(res.status, 401, 'Preview rejected the token')
        assert((res.headers.get('content-type') || '').includes('json'), 'Cloudflare answered HTTP ' + res.status + ' instead of the Worker')
        body = await res.json()
        assert(res.ok && body.passed, JSON.stringify(body.error || body))
        const unexpected = body.unhandled.filter((x) => !closing.test(x))
        assert.deepEqual(unexpected, [], 'Unhandled rejections: ' + unexpected.join('\n'))
      } catch (error) {
        failure = error
      }
      const expected = known.includes(name)
      if (Boolean(failure) !== expected) process.exitCode = 1
      console.log(JSON.stringify({
        build,
        name,
        passed: !failure,
        ...(expected ? { knownFailure: true } : {}),
        result: body?.result,
        closeRejections: (body?.unhandled || []).filter((x) => closing.test(x)).length,
        ...(platformErrors ? { platformErrors, waitedMs } : {}),
        error: failure?.message
      }))
    }
  }
}

function retryAfter(value) {
  if (!value)
    return
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isNaN(ms) ? undefined : Math.max(ms, 0)
}

async function main([mode, ...args]) {
  if (mode === 'prepare')
    return prepare(path.resolve(args[0]), args[1])
  if (mode === 'url')
    return console.log(previewUrl(JSON.parse(await readFile(args[0], 'utf8')).deployment) || '')
  if (mode === 'run')
    return run(args[0])
  throw new Error('Usage: workerd-edge.mjs prepare <dir> <compatibility-date> | url <preview.json> | run <preview-url>')
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

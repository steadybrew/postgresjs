import fs from 'fs'
import net from 'net'
import path from 'path'

const [side, ws, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
await import(path.join(ws, 'tests/bootstrap.js'))
const postgres = (await import(path.join(ws, 'src/index.js'))).default

const options = { db: 'postgres_js_test', user: 'postgres_js_test', idle_timeout: 1, connect_timeout: 1, max: 1 }
const delay = ms => new Promise(r => setTimeout(r, ms))
const within = (ms, p) => Promise.race([p, delay(ms).then(() => 'TIMEOUT')])
const describe = e => e && typeof e === 'object'
  ? { code: e.code, severity: e.severity, message: e.message, cause: e.cause && { code: e.cause.code, severity: e.cause.severity, message: e.cause.message } }
  : e
const results = {}
const strays = []
process.on('unhandledRejection', e => strays.push(String(e && e.stack || e)))
process.on('uncaughtException', e => strays.push(String(e && e.stack || e)))

async function check(name, fn) {
  try {
    results[name] = await within(60000, fn())
  } catch (e) {
    results[name] = { threw: describe(e) }
  }
  console.log(name, JSON.stringify(results[name]))
}

const backendMessage = (type, body) => {
  const header = Buffer.alloc(5)
  header.write(type)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}
const errorResponse = (severity, code, localizedOnly) => backendMessage('E', Buffer.from('S' + severity + '\0' + (localizedOnly ? '' : 'V' + severity + '\0') + 'C' + code + '\0M' + code + '\0\0'))
const authenticated = Buffer.concat([backendMessage('R', Buffer.alloc(4)), backendMessage('Z', Buffer.from('I'))])

async function fatalServer(localizedOnly, warm) {
  const server = net.createServer(socket => {
    let n = 0
    socket.on('error', () => socket.destroy())
    socket.on('data', () => {
      n++
      if (n === 1)
        return socket.write(authenticated)
      if (warm && n === 2)
        return socket.write(Buffer.concat([backendMessage('C', Buffer.from('SELECT 0\0')), backendMessage('Z', Buffer.from('I'))]))
      socket.end(errorResponse('FATAL', '08P01', localizedOnly))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const sql = postgres({ ...options, host: '127.0.0.1', port: server.address().port, fetch_types: false, prepare: false })
  const outcome = {}
  if (warm)
    outcome.warmup = await sql.unsafe('select 1').simple().then(() => 'ok', describe)
  outcome.query = await within(5000, sql`select 1`.then(() => 'ok', describe))
  outcome.begin = await within(5000, sql.begin(sql => sql`select 1`).then(() => 'ok', describe))
  await within(3000, sql.end({ timeout: 0 }))
  server.close()
  return outcome
}

await check('fatal-with-V', () => fatalServer(false, false))
await check('fatal-S-only', () => fatalServer(true, false))
await check('fatal-S-only-warm', () => fatalServer(true, true))

await check('savepoint-after-connection-loss', async() => {
  const sql = postgres({ ...options, max: 1 })
      , killer = postgres({ ...options, max: 1 })
  let started, release, settled
  const pid = new Promise(r => started = r)
      , gate = new Promise(r => release = r)
      , child = new Promise(r => settled = r)
  const root = sql.begin(sql =>
    sql.savepoint(async sql => {
      const [x] = await sql`select pg_backend_pid() as pid`
      started(x.pid)
      await gate
      return 'child'
    }).then(() => 'fulfilled', e => describe(e)).then(x => (settled(x), x))
  ).then(() => 'fulfilled', describe)
  await killer`select pg_terminate_backend(${ await pid })`
  const outer = await within(5000, root)
  release()
  const inner = await within(5000, child)
  const outerAfterRelease = await within(5000, root)
  await within(3000, killer.end())
  await within(3000, sql.end())
  return { outerBeforeChildReturns: outer, child: inner, outerAfterRelease }
})

await check('terminated-between-statements', async() => {
  const sql = postgres({ ...options, max: 1 })
      , killer = postgres({ ...options, max: 1 })
  let next
  const error = await within(10000, sql.begin(async sql => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`
    await killer`select pg_terminate_backend(${ pid })`
    await delay(100)
    next = await sql`select 1`.then(() => 'ok', describe)
  }).then(() => 'fulfilled', describe))
  await within(3000, killer.end())
  await within(3000, sql.end())
  return { begin: error, next }
})

await check('terminated-mid-query', async() => {
  const sql = postgres({ ...options, max: 1 })
      , killer = postgres({ ...options, max: 1 })
  const error = await within(10000, sql.begin(async sql => {
    const [{ pid }] = await sql`select pg_backend_pid() as pid`
    const query = sql`select pg_sleep(2)`.execute()
    while (!(await killer`select wait_event = 'PgSleep' as sleeping from pg_stat_activity where pid = ${ pid }`)[0].sleeping)
      await delay(1)
    await killer`select pg_terminate_backend(${ pid })`
    await query
  }).then(() => 'fulfilled', describe))
  await within(3000, killer.end())
  await within(3000, sql.end())
  return { begin: error }
})

await check('idle-in-transaction-timeout', async() => {
  const sql = postgres({ ...options, max: 1 })
  let next
  const error = await within(10000, sql.begin(async sql => {
    await sql`set local idle_in_transaction_session_timeout = '1s'`
    await delay(1500)
    next = await sql`select 1`.then(() => 'ok', describe)
  }).then(() => 'fulfilled', describe))
  await within(3000, sql.end())
  return { begin: error, next }
})

await check('transaction-timeout', async() => {
  const sql = postgres({ ...options, max: 1 })
  const error = await within(10000, sql.begin(async sql => {
    await sql`select set_config('transaction_timeout', '200', true)`
    await sql`select pg_sleep(2)`
  }).then(() => 'fulfilled', describe))
  await within(3000, sql.end())
  return { begin: error }
})

await check('proto-column', async() => {
  const sql = postgres({ ...options, max: 1 })
  const [row] = await sql`select 'alice' as name, '{"isAdmin": true}'::json as "__proto__"`
  const result = { isAdmin: row.isAdmin, prototypeIsObject: Object.getPrototypeOf(row) === Object.prototype, keys: Object.keys(row) }
  await sql.end()
  return result
})

await check('begin-canceled-loop', async() => {
  const victim = postgres({ ...options, max: 1, connection: { application_name: 'begin_cancel' } })
      , other = postgres({ ...options, max: 1 })
  await other`drop table if exists extras_cancel`
  await other`create table extras_cancel (i int)`
  const spraying = { on: true }
  const spray = (async() => {
    while (spraying.on)
      await other`select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'begin_cancel'`
  })()
  const started = Date.now()
  let wrong = 0, canceled = 0, other_errors = {}, stalled = null, i = 0
  for (; i < 500 && Date.now() - started < 240000; i++) {
    const failed = await within(15000, victim.begin(async sql => {
      await sql`insert into extras_cancel values (${ i })`
      await sql`insert into extras_cancel values (${ i })`
    }).then(() => false, e => e.code === '57014' ? true : (other_errors[e.code] = (other_errors[e.code] || 0) + 1, true)))
    if (failed === 'TIMEOUT') {
      stalled = i
      break
    }
    const [{ n }] = await other`select count(*)::int as n from extras_cancel where i = ${ i }`
    failed && canceled++
    ;(failed ? n !== 0 : n !== 2) && wrong++
  }
  spraying.on = false
  await within(5000, spray)
  await within(3000, other`drop table extras_cancel`)
  await within(3000, victim.end({ timeout: 0 }))
  await within(3000, other.end())
  return { iterations: i, ms: Date.now() - started, wrong, canceled, other_errors, stalled }
})

fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ side, suite: 'extras', results, strays }, null, 2))
console.log('strays', strays.length)
setTimeout(() => process.exit(0), 1000).unref()

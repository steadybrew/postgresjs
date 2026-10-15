import assert from 'assert'
import net from 'net'

const scenarios = {
  'reserved-after-terminate': reservedAfterTerminate,
  'begin-terminated-midstatement:prepared': postgres => beginTerminatedMidstatement(postgres, true),
  'begin-terminated-midstatement:unprepared': postgres => beginTerminatedMidstatement(postgres, false),
  'begin-network-cut': beginNetworkCut,
  'connect-timeout-prefer-standby': postgres => connectTimeout(postgres, 'prefer-standby', false),
  'connect-timeout-primary': postgres => connectTimeout(postgres, 'primary', true),
  'connect-timeout-busy-pool': connectTimeoutBusyPool
}

export const reportNames = Object.keys(scenarios)

export async function reports(name, postgres) {
  assert(scenarios[name], 'Unknown report scenario ' + name)
  await scenarios[name](postgres)
}

const pg = { host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', fetch_types: false, onnotice: () => undefined }
const noop = () => undefined
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const turn = () => new Promise(resolve => setImmediate(resolve))

const outcome = promise => Promise.resolve(promise).then(() => 'resolved', error =>
  error.code ? error.code + (error.cause ? ':' + error.cause.code : '') : error.message)
const code = text => text.split(':')[0]

function bounded(promise, ms = 3000) {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, 'hung') })])
    .finally(() => clearTimeout(timer))
}

function capture() {
  const errors = []
  const observe = error => errors.push(error && error.message)
  process.on('uncaughtException', observe)
  return { errors, stop: () => process.off('uncaughtException', observe) }
}

async function active(admin, pid) {
  for (let i = 0; i < 250; i++) {
    const [{ n }] = await admin`
      select count(*)::int as n from pg_stat_activity
      where pid = ${ pid } and state = 'active' and query like 'select pg_sleep%'
    `
    if (n)
      return
    await sleep(20)
  }
  assert.fail('pg_sleep never became active on backend ' + pid)
}

async function proxy() {
  const pairs = []
  const server = net.createServer(client => {
    const upstream = net.connect(5432, 'localhost')
    pairs.push([client, upstream])
    client.on('error', noop)
    upstream.on('error', noop)
    client.on('data', chunk => upstream.write(chunk))
    upstream.on('data', chunk => client.write(chunk))
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const destroy = () => pairs.forEach(pair => pair.forEach(socket => socket.destroy()))
  return {
    port: server.address().port,
    destroy,
    close: async() => {
      destroy()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

async function silent() {
  const sockets = []
  const server = net.createServer(socket => {
    sockets.push(socket)
    socket.on('error', noop)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: async() => {
      sockets.forEach(socket => socket.destroy())
      await new Promise(resolve => server.close(resolve))
    }
  }
}

async function reservedAfterTerminate(postgres) {
  const fault = capture()
  let closed
  const gone = new Promise(resolve => closed = resolve)
  const sql = postgres({ ...pg, max: 2, onclose: () => closed() })
  const killer = postgres({ ...pg, max: 1 })
  try {
    const reserved = await sql.reserve()
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`
    await killer`select pg_terminate_backend(${ pid }, 5000)`
    await gone
    const first = code(await bounded(outcome(reserved`select 1`)))
    const second = code(await bounded(outcome(reserved`select 1`), 2000))
    reserved.release()
    const after = await bounded(sql`select 1 as x`.then(x => x[0].x))
    await turn()
    assert.deepStrictEqual(fault.errors, [])
    assert.strictEqual(first, 'CONNECTION_CLOSED')
    assert.strictEqual(second, 'CONNECTION_CLOSED')
    assert.strictEqual(after, 1)
  } finally {
    fault.stop()
    await sql.end({ timeout: 0 })
    await killer.end({ timeout: 0 })
  }
}

async function beginTerminatedMidstatement(postgres, prepare) {
  const fault = capture()
  const killer = postgres({ ...pg, max: 1 })
  const sql = postgres({ ...pg, max: 1, prepare })
  try {
    let pidSeen
    const pidKnown = new Promise(resolve => pidSeen = resolve)
    const result = outcome(sql.begin(async t => {
      const [{ pid }] = await t`select pg_backend_pid() as pid`
      const running = t`select pg_sleep(30)`.execute()
      pidSeen(pid)
      await running
    }))
    const pid = await pidKnown
    await active(killer, pid)
    await killer`select pg_terminate_backend(${ pid }, 5000)`
    const rejected = code(await bounded(result))
    await turn()
    const after = await bounded(sql`select 1 as x`.then(x => x[0].x))
    assert.deepStrictEqual(fault.errors, [])
    assert.strictEqual(rejected, 'CONNECTION_CLOSED')
    assert.strictEqual(after, 1)
  } finally {
    fault.stop()
    await sql.end({ timeout: 0 })
    await killer.end({ timeout: 0 })
  }
}

async function beginNetworkCut(postgres) {
  const fault = capture()
  const killer = postgres({ ...pg, max: 1 })
  const cut = await proxy()
  const application_name = 'report_network_cut_' + process.pid
  const sql = postgres({ ...pg, host: '127.0.0.1', port: cut.port, max: 1, connection: { application_name } })
  try {
    let pidSeen
    const pidKnown = new Promise(resolve => pidSeen = resolve)
    const result = outcome(sql.begin(async t => {
      const [{ pid }] = await t`select pg_backend_pid() as pid`
      const running = t`select pg_sleep(30)`.execute()
      pidSeen(pid)
      await running
    }))
    const pid = await pidKnown
    await active(killer, pid)
    cut.destroy()
    const rejected = code(await bounded(result))
    await turn()
    const after = await bounded(sql`select 1 as x`.then(x => x[0].x))
    assert.deepStrictEqual(fault.errors, [])
    assert.strictEqual(rejected, 'CONNECTION_CLOSED')
    assert.strictEqual(after, 1)
  } finally {
    fault.stop()
    await sql.end({ timeout: 0 })
    await killer`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${ application_name }`
    await killer.end({ timeout: 0 })
    await cut.close()
  }
}

async function connectTimeout(postgres, target_session_attrs, silentFirst) {
  const dead = await silent()
  const sql = postgres({
    ...pg,
    host: silentFirst ? ['127.0.0.1', 'localhost'] : ['localhost', '127.0.0.1'],
    port: silentFirst ? [dead.port, 5432] : [5432, dead.port],
    max: 1,
    connect_timeout: 1,
    target_session_attrs
  })
  try {
    const pid = await bounded(sql`select pg_backend_pid() as pid`.then(x => x[0].pid, error => error.code), 5000)
    assert(Number.isInteger(pid) && pid > 0, 'Expected a backend pid, got ' + pid)
  } finally {
    await sql.end({ timeout: 0 })
    await dead.close()
  }
}

async function connectTimeoutBusyPool(postgres) {
  const dead = await silent()
  const sql = postgres({
    ...pg,
    host: ['127.0.0.1', 'localhost', 'localhost'],
    port: [dead.port, 5432, 5433],
    max: 20,
    connect_timeout: 1,
    target_session_attrs: 'primary'
  })
  try {
    const results = await bounded(Promise.all(Array.from({ length: 20 }, () =>
      sql`select pg_backend_pid() as pid`.then(() => 'resolved', error => error.code)
    )), 8000)
    assert.deepStrictEqual(results, Array(20).fill('resolved'))
  } finally {
    await sql.end({ timeout: 0 })
    await dead.close()
  }
}

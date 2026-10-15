import assert from 'assert'
import net from 'net'
import { message } from './peer.js'

const scenarios = {
  'reserved-after-terminate': reservedAfterTerminate,
  'begin-terminated-midstatement:prepared': postgres => beginTerminatedMidstatement(postgres, true),
  'begin-terminated-midstatement:unprepared': postgres => beginTerminatedMidstatement(postgres, false),
  'begin-network-cut': beginNetworkCut,
  'connect-timeout-prefer-standby': postgres => connectTimeout(postgres, 'prefer-standby', false),
  'connect-timeout-primary': postgres => connectTimeout(postgres, 'primary', true),
  'connect-timeout-busy-pool': connectTimeoutBusyPool,
  'concurrent-begins-busy-pool': concurrentBeginsBusyPool,
  'begin-at-pipeline-limit': beginAtPipelineLimit,
  'begin-write-always-true': beginWriteAlwaysTrue,
  'type-query-fatal': typeQueryFatal,
  'reserved-inflight-terminate': reservedInflightTerminate,
  ...Object.fromEntries(['idle-timeout', 'terminate'].flatMap(ender => ['return', 'statement'].map(next =>
    ['begin-after-session-ended:' + ender + ':' + next, postgres => beginAfterSessionEnded(postgres, ender, next)])))
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

async function proxy(intercept) {
  const pairs = []
  const server = net.createServer(client => {
    const upstream = net.connect(5432, 'localhost')
    pairs.push([client, upstream])
    client.on('error', noop)
    upstream.on('error', noop)
    client.on('data', chunk => (intercept && intercept(chunk, client, upstream)) || upstream.write(chunk))
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

async function replaceItems(t, a, n) {
  await t`delete from report_items where a_id = ${ a }`
  const items = Array.from({ length: n }, (_, b) => ({ a_id: a, b_id: b }))
  items.length && await t`insert into report_items ${ t(items, 'a_id', 'b_id') }`
}

const idleInTransaction = async(admin, application_name) => (await admin`
  select count(*)::int as n from pg_stat_activity
  where application_name = ${ application_name } and state like 'idle in transaction%'
`)[0].n

async function withItems(postgres, fn) {
  const admin = postgres({ ...pg, max: 1 })
  await admin`drop table if exists report_items`
  await admin`create table report_items (a_id int, b_id int)`
  try {
    await fn(admin)
  } finally {
    await admin`drop table report_items`
    await admin.end({ timeout: 0 })
  }
}

async function concurrentBeginsBusyPool(postgres) {
  await withItems(postgres, async admin => {
    const application_name = 'report_busy_pool_' + process.pid
    const notices = []
    const sql = postgres({ ...pg, max: 3, max_pipeline: 2, connection: { application_name }, onnotice: n => notices.push(n.code) })
    const counts = [0, 1, 10, 1000, 3000]
    try {
      for (let i = 0; i < 10; i++) {
        await admin`delete from report_items`
        const others = [
          ...Array.from({ length: 3 }, () => outcome(sql`select pg_sleep(0.2)`.execute())),
          ...Array.from({ length: 6 }, () => outcome(sql`select 1 as x`.execute()))
        ]
        const begins = counts.map((n, a) => outcome(sql.begin(t => replaceItems(t, a, n))))
        const results = await bounded(Promise.all([...begins, ...others]), 8000)
        const stored = (await admin`select a_id, count(*)::int as n from report_items group by a_id order by a_id`)
          .map(x => [x.a_id, x.n])
        assert.strictEqual(JSON.stringify([i, results]), JSON.stringify([i, Array(begins.length + others.length).fill('resolved')]))
        assert.strictEqual(JSON.stringify([i, stored]), JSON.stringify([i, counts.flatMap((n, a) => n ? [[a, n]] : [])]))
        assert.strictEqual(await idleInTransaction(admin, application_name), 0)
      }
      assert.deepStrictEqual(notices.filter(x => x === '25001'), [])
    } finally {
      await sql.end({ timeout: 0 })
    }
  })
}

async function beginAtPipelineLimit(postgres) {
  await withItems(postgres, async admin => {
    const application_name = 'report_pipeline_limit_' + process.pid
    const notices = []
    const sql = postgres({ ...pg, max: 2, connection: { application_name }, onnotice: n => notices.push(n.code) })
    try {
      const held = await Promise.all([sql.reserve(), sql.reserve()])
      held.forEach(x => x.release())
      const others = [
        ...Array.from({ length: 2 }, () => outcome(sql`select pg_sleep(0.2)`.execute())),
        ...Array.from({ length: 198 }, () => outcome(sql`select 1 as x`.execute()))
      ]
      const begin = outcome(sql.begin(t => replaceItems(t, 1, 10)))
      const results = await bounded(Promise.all([begin, ...others]), 8000)
      const stored = await admin`select count(*)::int as n from report_items where a_id = 1`
      assert.deepStrictEqual(results, Array(201).fill('resolved'))
      assert.strictEqual(stored[0].n, 10)
      assert.strictEqual(await idleInTransaction(admin, application_name), 0)
      assert.deepStrictEqual(notices.filter(x => x === '25001'), [])
    } finally {
      await sql.end({ timeout: 0 })
    }
  })
}

async function beginWriteAlwaysTrue(postgres) {
  const application_name = 'report_write_true_' + process.pid
  const socket = async() => {
    const connection = net.connect(5432, 'localhost')
    await new Promise((resolve, reject) => { connection.once('connect', resolve); connection.once('error', reject) })
    const write = connection.write.bind(connection)
    connection.write = (...args) => (write(...args), true)
    return connection
  }
  const observer = postgres({ ...pg, max: 1 })
  const sql = postgres({ ...pg, max: 1, max_pipeline: 1, prepare: false, socket, connection: { application_name } })
  try {
    const sleeping = outcome(sql`select pg_sleep(0.25)`.execute())
    const transaction = outcome(sql.begin(async() => true))
    const results = await bounded(Promise.all([sleeping, transaction]), 5000)
    const idle = await idleInTransaction(observer, application_name)
    const next = await bounded(sql`select 1 as x`.then(x => x[0].x, error => error.code))
    assert.deepStrictEqual(results, ['resolved', 'resolved'])
    assert.strictEqual(idle, 0)
    assert.strictEqual(next, 1)
  } finally {
    await sql.end({ timeout: 0 })
    await observer.end({ timeout: 0 })
  }
}

async function typeQueryFatal(postgres) {
  const fault = capture()
  const fatal = message('E', Buffer.from('SFATAL\0C57P01\0Mterminating connection due to administrator command\0\0'))
  let cut = false
  const relay = await proxy((chunk, client, upstream) => {
    if (cut || !chunk.includes('typarray'))
      return false
    cut = true
    client.write(fatal)
    client.end()
    upstream.destroy()
    return true
  })
  const sql = postgres({ ...pg, host: '127.0.0.1', port: relay.port, max: 1, fetch_types: true })
  try {
    const ok = await bounded(sql`select 1 as ok`.then(x => x[0].ok, error => error.code), 5000)
    await turn()
    const ended = await bounded(sql.end({ timeout: 1 }).then(() => 'resolved'), 5000)
    assert.deepStrictEqual(fault.errors, [])
    assert(cut, 'The type query never reached the proxy')
    assert.strictEqual(ok, 1)
    assert.strictEqual(ended, 'resolved')
  } finally {
    fault.stop()
    await sql.end({ timeout: 0 })
    await relay.close()
  }
}

async function beginAfterSessionEnded(postgres, ender, next) {
  const fault = capture()
  let closed
  let finished
  const gone = new Promise(resolve => closed = resolve)
  const done = new Promise(resolve => finished = resolve)
  const killer = postgres({ ...pg, max: 1 })
  const sql = postgres({ ...pg, max: 1, onclose: () => closed() })
  let late = 'none'
  try {
    const result = outcome(sql.begin(async t => {
      try {
        const [{ pid }] = await t`select pg_backend_pid() as pid`
        ender === 'idle-timeout'
          ? await t`set idle_in_transaction_session_timeout = 50`
          : await killer`select pg_terminate_backend(${ pid }, 5000)`
        await gone
        next === 'statement' && (late = code(await bounded(outcome(t`select 2`), 2000)))
      } finally {
        finished()
      }
    }))
    const rejected = code(await bounded(result, 5000))
    await bounded(done, 3000)
    await turn()
    await turn()
    const after = await bounded(sql`select 1 as x`.then(x => x[0].x, error => error.code))
    assert.deepStrictEqual(fault.errors, [])
    assert.strictEqual(rejected, 'CONNECTION_CLOSED')
    assert.strictEqual(late, next === 'statement' ? 'CONNECTION_CLOSED' : 'none')
    assert.strictEqual(after, 1)
  } finally {
    fault.stop()
    await sql.end({ timeout: 0 })
    await killer.end({ timeout: 0 })
  }
}

async function reservedInflightTerminate(postgres) {
  const fault = capture()
  const killer = postgres({ ...pg, max: 1 })
  const sql = postgres({ ...pg, max: 1 })
  try {
    const reserved = await sql.reserve()
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`
    const held = outcome(reserved`select pg_sleep(30)`.execute())
    await active(killer, pid)
    await killer`select pg_terminate_backend(${ pid }, 5000)`
    const inflight = code(await bounded(held))
    reserved.release()
    const next = await bounded(sql`select 1 as x`.then(x => x[0].x, error => error.code))
    const ended = await bounded(sql.end().then(() => 'resolved'), 5000)
    await turn()
    assert.deepStrictEqual(fault.errors, [])
    assert.strictEqual(inflight, 'CONNECTION_CLOSED')
    assert.strictEqual(next, 1)
    assert.strictEqual(ended, 'resolved')
  } finally {
    fault.stop()
    await sql.end({ timeout: 0 })
    await killer.end({ timeout: 0 })
  }
}

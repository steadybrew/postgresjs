import assert from 'assert'
import net from 'net'
import { Duplex } from 'stream'
import { peer, message } from './peer.js'

const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
    , reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

class CutSocket extends Duplex {
  constructor() {
    super({ read() { /* No backend data before this close. */ }, write(chunk, encoding, callback) { callback() } })
    this.readyState = 'open'
  }

  on(name, callback) {
    super.on(name, callback)
    if (name === 'data')
      queueMicrotask(() => this.emit('close', false))
    return this
  }
}

export async function startup(name, postgres, onEvent) {
  const started = deferred()
  const password = deferred()
  const passwordStarted = deferred()
  const afterClose = deferred()
  const backoffs = []
  const copyDone = deferred()
  const server = await peer({ passwordAuth: name.startsWith('password-') ? 'first' : false,
                              catalogRows: name.startsWith('first-types') ? [[25, 1009]] : [],
                              catalogError: name === 'server-budget' ? true
                              : name.startsWith('catalog-error') || name === 'stale-error' || name === 'failure-drain' ? 'first' : false,
                              closeAfterError: name === 'stale-error' || name === 'server-budget',
                              closeStartup: name === 'retry-bound' || name === 'long-backoff' ? Infinity
                              : name === 'retry-zero' ? 2 : name === 'retry-stalled' ? 1 : 0,
                              closeCatalog: name === 'catalog-close' ? 2 : 0, sessionError: name === 'session-error',
                              holdCatalog: name === 'catalog-stalled', holdSession: name === 'session-stalled',
                              allowHalfOpen: name === 'half-open-end',
                              holdStartup: name === 'stalled' || name === 'retry-stalled' || name === 'half-open-end', onStartup: () => {
                                started.resolve()
                                name === 'failure-drain' && clientSocket.on('data', () => clientSocket.emit('drain'))
                              }, onEvent: event => {
                                onEvent(event)
                                event.type === 'c' && copyDone.resolve()
                              } })
  const factory = deferred()
  const factoryStarted = deferred()
  let creations = 0
  let clientSocket
  const connectedSocket = async() => {
    const socket = clientSocket = net.connect(server.port, '127.0.0.1')
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    return socket
  }
  const socket = () => {
    factoryStarted.resolve()
    creations++
    if (name === 'pending-write')
      return creations === 1 ? new CutSocket() : connectedSocket()
    if (name === 'failure-drain' || name === 'password-close' || name === 'half-open-end')
      return connectedSocket()
    if (name === 'factory-multi')
      return creations <= 2 ? Promise.reject(new Error('factory denied')) : connectedSocket()
    return creations === 1 ? factory.promise : connectedSocket()
  }
  const transform = { column: x => x.toUpperCase(), value: x => typeof x === 'number' ? x + 1 : x, row: x => ({ WRAPPED: x }) }
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false,
                         max: 1, fetch_types: name !== 'first-types-no-fetch', onclose: () => afterClose.resolve(),
                         backoff: count => { backoffs.push(count); return name === 'long-backoff' ? 2 : 0.04 },
                         connect_timeout: name === 'retry-zero' ? 0 : 0.3,
                         ...(name.startsWith('password-') ? { pass: () => { passwordStarted.resolve(); return password.promise } } : {}),
                         ...(name.startsWith('factory-') || name === 'failure-drain' || name === 'pending-write'
                             || name === 'password-close' || name === 'half-open-end' ? { socket } : {}),
                         ...(name === 'factory-multi' ? { host: ['127.0.0.1', '127.0.0.1'], port: [server.port, server.port] } : {}),
                         ...(name.startsWith('session-') ? { target_session_attrs: 'read-write' } : {}),
                         ...(name.endsWith('-transform') ? { transform } : {}),
                         ...(name.startsWith('first-types') ? { debug: (id, string, parameters, types) => {
                           name === 'first-types-no-fetch' && assert(!string.includes('pg_catalog.pg_type'))
                           if (string.includes('$1::text[]'))
                             assert.deepStrictEqual(types, [1009])
                         } } : {}) })
  const query = client => client.unsafe('select 42 as marker', [], { simple: true })
  const userQueries = () => server.events.filter(x => x.type === 'Q' && !x.sql.includes('transaction_read_only'))
  async function capacity() {
    for (let round = 0; round < 2; round++) {
      const held = await sql.reserve()
      assert.strictEqual((await query(held))[0].marker, 42)
      held.release()
    }
  }
  try {
    if (name === 'half-open-end') {
      const outcome = assert.rejects(sql.reserve(), error => error.code === 'CONNECTION_ENDED')
      await started.promise
      await sql.end({ timeout: 0 })
      await outcome
      await turn()
      assert.strictEqual(clientSocket.destroyed, true, 'Forced startup shutdown must destroy a half-open socket')
    } else if (name === 'password-close') {
      const outcome = assert.rejects(sql.reserve(), error => error.code === 'ECONNRESET')
      await passwordStarted.promise
      clientSocket.destroy(Object.assign(new Error('controlled physical close'), { code: 'ECONNRESET' }))
      await Promise.all([outcome, afterClose.promise])
      password.resolve('late password')
      await turn()
      await turn()
      assert.strictEqual(server.events.filter(x => x.type === 'p').length, 0)
    } else if (name.startsWith('copy-')) {
      const copy = name === 'copy-close'
        ? await sql.unsafe('copy fixture to stdout').readable()
        : await sql.unsafe('copy fixture from stdin').writable()
      const failed = new Promise(resolve => copy.once('error', resolve))
      if (name === 'copy-final-close') {
        copy.end('1\n')
        await copyDone.promise
      }
      server.disconnect()
      assert.strictEqual((await failed).code, 'CONNECTION_CLOSED')
      assert.strictEqual(copy.destroyed, true)
      await capacity()
    } else if (name === 'pending-write') {
      await capacity()
      assert.strictEqual(creations, 2)
      assert.strictEqual(server.events.filter(x => x.type === 'startup').length, 1)
    } else if (name === 'failure-drain') {
      const failed = sql.reserve()
      const next = sql.reserve()
      await assert.rejects(failed, error => error.code === '42501')
      const held = await next
      const result = await query(held)
      assert.strictEqual(result.state.pid, 2)
      held.release()
      assert.strictEqual(userQueries().filter(x => x.pid === 1).length, 0)
      await capacity()
    } else if (name.startsWith('first-types')) {
      await sql.unsafe('select $1::text[]', [sql.array(['a'], 25)])
      name.endsWith('-transform') && assert.deepStrictEqual((await query(sql))[0], { WRAPPED: { MARKER: 43 } })
      name === 'first-types-no-fetch' && assert.strictEqual(server.events.filter(x => x.type === 'P').length, 1)
    } else if (name.startsWith('catalog-error') || name === 'session-error') {
      await assert.rejects(name === 'catalog-error-query' ? query(sql) : sql.reserve(), error =>
        error.code === '42501' && error.message === (name === 'session-error' ? 'session denied' : 'catalog denied'))
      assert.strictEqual(userQueries().length, 0)
      name !== 'session-error' && await capacity()
    } else if (name === 'session-transform') {
      const held = await sql.reserve()
      assert.deepStrictEqual((await query(held))[0], { WRAPPED: { MARKER: 43 } })
      held.release()
    } else if (['retry-bound', 'retry-stalled', 'long-backoff', 'server-budget', 'stalled', 'catalog-stalled', 'session-stalled'].includes(name)) {
      const start = Date.now()
      const expected = name === 'server-budget' ? '42501'
        : ['retry-bound', 'retry-stalled', 'long-backoff'].includes(name) ? 'CONNECTION_CLOSED' : 'CONNECT_TIMEOUT'
      await assert.rejects(sql.reserve(), error => error.code === expected)
      assert(Date.now() - start >= 200 && Date.now() - start < 1500)
      const attempts = server.events.filter(x => x.type === 'startup').length
      assert(name === 'retry-bound' || name === 'server-budget' ? attempts >= 2 && attempts <= 9
        : name === 'retry-stalled' ? attempts === 2 : attempts === 1)
      assert.strictEqual(userQueries().length, 0)
    } else if (name.startsWith('password-')) {
      await assert.rejects(sql.reserve(), error => error.code === 'CONNECT_TIMEOUT')
      const held = await sql.reserve()
      name === 'password-reject' ? password.reject(new Error('late password rejection')) : password.resolve('late password')
      await turn()
      assert.strictEqual((await query(held))[0].marker, 42)
      assert.strictEqual(server.events.filter(x => x.type === 'p').length, 0)
      held.release()
    } else if (name === 'factory-multi') {
      const start = Date.now()
      await capacity()
      assert.strictEqual(creations, 3)
      assert(Date.now() - start >= 30)
    } else if (name.startsWith('factory-')) {
      const pending = sql.reserve()
      const outcome = assert.rejects(pending, error => error.code === (name === 'factory-end' ? 'CONNECTION_ENDED' : 'CONNECT_TIMEOUT'))
      await factoryStarted.promise
      name === 'factory-end' && await sql.end({ timeout: 0 })
      await outcome
      const replacement = name === 'factory-end' ? null : sql.reserve()
      const late = new net.Socket()
      if (name === 'factory-reject')
        factory.reject(new Error('late factory rejection'))
      else
        factory.resolve(late)
      await turn()
      name !== 'factory-reject' && assert.strictEqual(late.destroyed, true)
      if (replacement) {
        const held = await replacement
        await query(held)
        held.release()
        await capacity()
      }
    } else if (['catalog-close', 'stale-error', 'retry-zero'].includes(name)) {
      const start = Date.now()
      await capacity()
      assert(Date.now() - start >= (name === 'stale-error' ? 30 : 60), 'Retries must respect configured backoff')
      const expected = name === 'stale-error' ? 2 : 3
      assert.strictEqual(server.events.filter(x => x.type === 'startup').length, expected)
      if (name === 'retry-zero') {
        server.disconnect()
        await afterClose.promise
        assert.strictEqual(backoffs[backoffs.length - 1], 0, 'Successful startup resets user backoff history')
        await capacity()
      }
    } else {
      throw new Error('Unknown startup scenario ' + name)
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

export async function selection(name, postgres, onEvent) {
  const first = await peer({ closeStartup: name === 'failover' ? Infinity : 0,
                             readOnly: name === 'session-select', onEvent })
  const second = await peer({ onEvent })
  const sql = postgres({ host: ['127.0.0.1', '127.0.0.1'], port: [first.port, second.port],
                         user: 'fixture', database: 'fixture', max: 1, ssl: false, connect_timeout: 1, backoff: 0.04,
                         ...(name === 'session-select' ? { target_session_attrs: 'read-write' } : {}) })
  try {
    const held = await sql.reserve()
    assert.strictEqual((await held.unsafe('select 42 as marker'))[0].marker, 42)
    held.release()
    assert.strictEqual(first.events.filter(x => x.type === 'startup').length, 1)
    assert.strictEqual(second.events.filter(x => x.type === 'startup').length, 1)
    assert.strictEqual(first.events.filter(x => x.type === 'Q' && !x.sql.includes('transaction_read_only')).length, 0)
  } finally {
    await sql.end({ timeout: 0 })
    await first.close()
    await second.close()
  }
}

export async function lifecycle(name, postgres, onEvent) {
  let barrier = deferred()
  const retrying = deferred()
  const backoffCase = name.startsWith('backoff-')
  const server = await peer({ holdStartup: name === 'budget-reset' || name.startsWith('graceful-') || name.startsWith('forced-'),
                              closeStartup: name === 'end-backoff' ? Infinity : backoffCase ? 1 : 0,
                              onStartup: () => barrier.resolve(), onEvent })
  const closed = deferred()
  let closes = 0
  let reentrant
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false,
                         max: 1, fetch_types: !name.startsWith('graceful-'), connect_timeout: backoffCase ? 1 : 0.3,
                         backoff: count => { count && retrying.resolve(); return backoffCase ? 0.5 : 0.04 },
                         onclose: () => {
                           closes++
                           name === 'backoff-close' && closes === 1 && (reentrant = sql.reserve())
                           closed.resolve()
                         } })
  try {
    const pending = name === 'graceful-first-query' ? sql.unsafe('select 42 as marker').execute() : sql.reserve()
    if (backoffCase) {
      const outcome = assert.rejects(pending, error => error.code === 'CONNECTION_ENDED')
      const queued = name === 'backoff-end-query' ? sql.unsafe('select 42 as marker').execute()
        : name === 'backoff-end-reserve' ? sql.reserve() : null
      const queuedOutcome = queued && assert.rejects(queued, error => error.code === 'CONNECTION_ENDED')
      await retrying.promise
      await (name === 'backoff-close' ? sql.close() : sql.end())
      await Promise.all([outcome, queuedOutcome])
      assert.strictEqual(closes, 1)
      if (name === 'backoff-close') {
        const fromCallback = await reentrant
        assert.strictEqual((await fromCallback.unsafe('select 42 as marker'))[0].marker, 42)
        fromCallback.release()
        assert.strictEqual((await sql.unsafe('select 42 as marker'))[0].marker, 42)
        const held = await sql.reserve()
        assert.strictEqual((await held.unsafe('select 42 as marker'))[0].marker, 42)
        held.release()
      }
    } else if (name === 'graceful-first-query') {
      await barrier.promise
      const ending = sql.end()
      await turn()
      server.releaseStartup()
      assert.strictEqual((await pending)[0].marker, 42)
      await ending
    } else if (name.startsWith('forced-')) {
      const queued = name === 'forced-queued-query' ? sql.unsafe('select 42 as marker').execute() : sql.reserve()
      const outcomes = [pending, queued].map(x => assert.rejects(x, error => error.code === 'CONNECTION_ENDED'))
      await barrier.promise
      await sql.end({ timeout: 0 })
      await Promise.all(outcomes)
    } else if (name.startsWith('graceful-')) {
      const outcome = assert.rejects(pending, error => error.code === 'CONNECTION_ENDED')
      const queued = name === 'graceful-queued-query' ? sql.unsafe('select 42 as marker').execute()
        : name === 'graceful-queued-reserve' ? sql.reserve() : null
      const queuedOutcome = queued && assert.rejects(queued, error => error.code === 'CONNECTION_ENDED')
      await barrier.promise
      const ending = sql.end()
      await turn()
      server.disconnect()
      await Promise.all([outcome, queuedOutcome, ending])
      assert.strictEqual(server.events.filter(x => x.type === 'startup').length, 1)
    } else if (name === 'end-backoff') {
      const outcome = assert.rejects(pending, error => error.code === 'CONNECTION_ENDED')
      await barrier.promise
      await sql.end({ timeout: 0 })
      await outcome
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.strictEqual(server.events.filter(x => x.type === 'startup').length, 1)
    } else {
      await barrier.promise
      await new Promise(resolve => setTimeout(resolve, 180))
      server.releaseStartup()
      const first = await pending
      await first.unsafe('select 42 as marker')
      first.release()
      server.disconnect()
      await closed.promise
      barrier = deferred()
      const next = sql.reserve()
      await barrier.promise
      await new Promise(resolve => setTimeout(resolve, 180))
      server.releaseStartup()
      const second = await next
      assert.strictEqual((await second.unsafe('select 42 as marker'))[0].marker, 42)
      second.release()
      assert.strictEqual(server.events.filter(x => x.type === 'startup').length, 2)
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

const settle = (promise, ms = 3000) => {
  let timer
  return Promise.race([
    Promise.resolve(promise).then(() => 'resolved', error => 'rejected:' + (error.code || error.message)),
    new Promise(resolve => { timer = setTimeout(resolve, ms, 'hang') })
  ]).finally(() => clearTimeout(timer))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const startups = server => server.events.filter(x => x.type === 'startup').length
const until = async(check, ms = 2000) => {
  const start = Date.now()
  while (!check() && Date.now() - start < ms)
    await sleep(5)
  assert(check(), 'Condition not reached')
}
const tracked = server => {
  let current
  return {
    current: () => current,
    socket: async() => {
      current = net.connect(server.port, '127.0.0.1')
      await new Promise((resolve, reject) => { current.once('connect', resolve); current.once('error', reject) })
      return current
    }
  }
}
const marker = async client => (await client.unsafe('select 42 as marker', [], { simple: true }))[0].marker

export async function phases(name, postgres, onEvent) {
  const refused = await new Promise(resolve => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  const base = { host: '127.0.0.1', user: 'fixture', database: 'fixture', ssl: false, max: 1, fetch_types: false, onnotice: () => { /* Quiet. */ } }
  const hang = ['forced-queued', 'cancel-errors', 'gap-query'].some(x => name === x)
    || ['lifetime', 'close', 'rst', 'fin'].some(x => name.includes(x))
  const holding = ['reserve-end', 'cancel-initial', 'failover-timeout'].includes(name)
  const server = await peer({ holdQuery: hang ? 'hang' : '', holdStartup: holding,
                              sslReply: name === 'tls-throw' ? 'S' : '', failAuthentication: name === 'reentrant-onclose', onEvent })
  const hold = name === 'failover-timeout' ? server : null
  const good = name === 'failover-timeout' ? await peer({ onEvent }) : null
  const clients = []
  const make = options => clients.push(postgres({ ...base, port: server.port, ...options })) && clients[clients.length - 1]
  try {
    if (name === 'stale-ending-lifetime' || name === 'stale-ending-close') {
      const sql = make({ connect_timeout: 2, max_lifetime: name === 'stale-ending-lifetime' ? 0.3 : null })
      const hung = settle(sql.unsafe('select hang', [], { simple: true }))
      await until(() => server.events.some(x => x.sql === 'select hang'))
      name === 'stale-ending-close' ? sql.close() : await sleep(500)
      server.disconnect()
      assert.strictEqual(await hung, 'rejected:CONNECTION_CLOSED')
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(startups(server), 2)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'stale-ending-rst') {
      const factory = tracked(server)
      const sql = make({ connect_timeout: 2, backoff: 0.01, socket: factory.socket })
      await marker(sql)
      const hung = settle(sql.unsafe('select hang', [], { simple: true }))
      await until(() => server.events.some(x => x.sql === 'select hang'))
      const closing = deferred()
      factory.current().once('error', () => closing.resolve(sql.close()))
      server.reset()
      assert.strictEqual(await hung, 'rejected:ECONNRESET')
      await closing.promise
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(startups(server), 2)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'backoff-budget') {
      const sql = make({ connect_timeout: 1, backoff: () => 3 })
      await marker(sql)
      server.reset()
      await sleep(100)
      const before = startups(server)
      assert.strictEqual(await settle(marker(sql), 4500), 'resolved')
      assert.strictEqual(startups(server), before + 1)
      await sql.end()
    } else if (name === 'tls-throw') {
      const sql = make({ connect_timeout: 1, ssl: { key: 'not a pem', cert: 'not a pem' } })
      assert.notStrictEqual(await settle(marker(sql), 4000), 'hang')
      assert.notStrictEqual(await settle(marker(sql), 4000), 'hang')
      assert.strictEqual(await settle(sql.end({ timeout: 0 })), 'resolved')
    } else if (name === 'reserve-end') {
      const sql = make({ connect_timeout: 5 })
      const reserved = sql.reserve().then(() => 'reserved', error => error.code)
      await until(() => startups(server) === 1)
      const ending = settle(sql.end())
      await sleep(50)
      server.releaseStartup()
      assert.strictEqual(await reserved, 'CONNECTION_ENDED')
      assert.strictEqual(await ending, 'resolved')
    } else if (name === 'cancel-initial') {
      const sql = make({ connect_timeout: 5 })
      const query = sql.unsafe('select 42 as marker', [], { simple: true })
      const first = settle(query)
      await until(() => startups(server) === 1)
      await query.cancel()
      assert.strictEqual(await first, 'rejected:57014')
      server.releaseStartup()
      await sleep(50)
      assert.strictEqual(await settle(marker(sql), 2000), 'resolved')
      await sql.end()
    } else if (name === 'factory-backoff') {
      let calls = 0
      let broken = false
      const factory = tracked(server)
      const sql = make({ connect_timeout: 30, fetch_types: false,
                         socket: () => {
                           calls++
                           if (broken)
                             throw new Error('factory denied')
                           return factory.socket()
                         } })
      await sql.listen('fixture', () => { /* Unused. */ })
      broken = true
      const before = calls
      server.disconnect()
      await sleep(500)
      assert(calls - before < 20, 'Factory called ' + (calls - before) + ' times in 500 ms')
      await sql.end({ timeout: 0 })
    } else if (name === 'fin-inflight' || name === 'rst-inflight') {
      const sql = make({ connect_timeout: 2 })
      await marker(sql)
      const hung = settle(sql.unsafe('select hang', [], { simple: true }))
      await until(() => server.events.some(x => x.sql === 'select hang'))
      name === 'fin-inflight' ? server.disconnect() : server.reset()
      assert.strictEqual((await hung).slice(0, 8), 'rejected')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'gap-query') {
      const factory = tracked(server)
      const sql = make({ connect_timeout: 2, backoff: 0.01, socket: factory.socket })
      await marker(sql)
      const hung = settle(sql.unsafe('select hang', [], { simple: true }))
      await until(() => server.events.some(x => x.sql === 'select hang'))
      const gap = deferred()
      factory.current().once('error', () => gap.resolve(settle(sql.unsafe('select 3', [], { simple: true }))))
      server.reset()
      assert.strictEqual(await hung, 'rejected:ECONNRESET')
      assert.strictEqual(await gap.promise, 'rejected:CONNECTION_CLOSED')
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'all-down') {
      const sql = make({ host: ['127.0.0.1', '127.0.0.1'], port: [refused, refused], connect_timeout: 0.5, backoff: 0.01 })
      assert.strictEqual(await settle(marker(sql), 3000), 'rejected:ECONNREFUSED')
      assert.strictEqual(await settle(sql.end({ timeout: 0 })), 'resolved')
    } else if (name === 'churn') {
      let attempts = 0
      const closing = net.createServer(socket => {
        attempts++
        socket.on('error', () => { /* Peer reset. */ })
        socket.on('data', () => socket.end())
      })
      await new Promise(resolve => closing.listen(0, '127.0.0.1', resolve))
      const sql = make({ port: closing.address().port, max: 25, connect_timeout: 1 })
      const start = Date.now()
      const results = await Promise.all(Array.from({ length: 25 }, () => settle(sql`select 1`, 4000)))
      const elapsed = Date.now() - start
      const seen = attempts
      await sql.end({ timeout: 0 })
      await new Promise(resolve => closing.close(resolve))
      assert(!results.includes('hang') && elapsed < 2500, 'Every query must settle by connect_timeout: ' + elapsed)
      assert(seen < 200, 'Attempts must stay bounded: ' + seen)
    } else if (name === 'failover-timeout') {
      const sql = make({ host: ['127.0.0.1', '127.0.0.1'], port: [hold.port, good.port], connect_timeout: 1 })
      assert.strictEqual(await settle(marker(sql), 4000), 'resolved')
      assert.strictEqual(startups(hold), 1)
      assert.strictEqual(startups(good), 1)
      await sql.end({ timeout: 0 })
    } else if (name === 'late-error') {
      const factory = tracked(server)
      const sql = make({ connect_timeout: 2, socket: factory.socket })
      await marker(sql)
      const old = factory.current()
      server.disconnect()
      await until(() => old.destroyed)
      await turn()
      old.emit('error', new Error('late error from detached socket'))
      await turn()
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      await sql.end()
    } else if (name === 'drain-pipeline') {
      const sql = make({ max_pipeline: 1, connect_timeout: 2 })
      await marker(sql)
      const results = ['a', 'b', 'c'].map(() => settle(marker(sql)))
      await turn()
      const ending = settle(sql.end())
      assert.deepStrictEqual(await Promise.all(results), ['resolved', 'resolved', 'resolved'])
      assert.strictEqual(await ending, 'resolved')
      assert.strictEqual(startups(server), 1)
    } else if (name === 'drain-reserved' || name === 'drain-reservation-queued') {
      const sql = make({ connect_timeout: 2 })
      const held = await sql.reserve()
      const queued = settle(marker(sql))
      const reservation = name === 'drain-reservation-queued' ? settle(sql.reserve()) : null
      await sleep(20)
      const ending = settle(sql.end())
      await sleep(20)
      held.release()
      assert.strictEqual(await queued, 'resolved')
      reservation && assert.strictEqual(await reservation, 'rejected:CONNECTION_ENDED')
      assert.strictEqual(await ending, 'resolved')
      assert.strictEqual(startups(server), 1)
    } else if (name === 'release-closed') {
      const sql = make({ connect_timeout: 2, backoff: 0.01 })
      const held = await sql.reserve()
      await marker(held)
      server.disconnect()
      await sleep(100)
      held.release()
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      await sql.end({ timeout: 0 })
    } else if (name === 'prefer-standby-first' || name === 'prefer-standby-last') {
      const order = name === 'prefer-standby-first' ? [server.port, refused] : [refused, server.port]
      const sql = make({ host: ['127.0.0.1', '127.0.0.1'], port: order, target_session_attrs: 'prefer-standby', connect_timeout: 2, backoff: 0.01 })
      assert.strictEqual(await settle(marker(sql), 4000), 'resolved')
      await sql.end({ timeout: 0 })
    } else if (name === 'outage-recover') {
      const other = await new Promise(resolve => {
        const probe = net.createServer()
        probe.listen(0, '127.0.0.1', () => {
          const port = probe.address().port
          probe.close(() => resolve(port))
        })
      })
      const sql = make({ host: ['127.0.0.1', '127.0.0.1'], port: [refused, other], connect_timeout: 2, backoff: 0.05 })
      const outcome = settle(marker(sql), 4000)
      await sleep(300)
      const revived = await peer({ port: other, onEvent })
      try {
        assert.strictEqual(await outcome, 'resolved')
      } finally {
        await sql.end({ timeout: 0 })
        await revived.close()
      }
    } else if (name === 'forced-queued') {
      const sql = make({ connect_timeout: 2 })
      await marker(sql)
      const inflight = settle(sql.unsafe('select hang', [], { simple: true }))
      await until(() => server.events.some(x => x.sql === 'select hang'))
      const queued = settle(sql.reserve())
      await sleep(20)
      await sql.end({ timeout: 0.1 })
      assert.strictEqual(await queued, 'rejected:CONNECTION_DESTROYED')
      assert.strictEqual((await inflight).slice(0, 8), 'rejected')
    } else if (name === 'reentrant-onclose') {
      let reentrant
      let closes = 0
      const sql = make({ connect_timeout: 2, backoff: 0.01, onclose: () => {
        closes++ === 0 && (reentrant = settle(sql.reserve().then(x => x.release())))
      } })
      const first = settle(marker(sql))
      const second = settle(marker(sql))
      assert.strictEqual(await first, 'rejected:28P01')
      assert.strictEqual(await second, 'resolved')
      assert.strictEqual(await reentrant, 'resolved')
      await sql.end({ timeout: 0 })
    } else if (name === 'fatal-storm') {
      let attempts = 0
      const fatal = net.createServer(socket => {
        attempts++
        socket.on('error', () => { /* Peer reset. */ })
        socket.once('data', () => socket.end(message('E', Buffer.from('SFATAL\0C57P03\0Mthe database system is starting up\0\0'))))
      })
      await new Promise(resolve => fatal.listen(0, '127.0.0.1', resolve))
      const sql = make({ port: fatal.address().port, connect_timeout: 5, backoff: 0.1 })
      const start = Date.now()
      const first = await settle(marker(sql), 4000)
      const second = await settle(marker(sql), 4000)
      const burst = Promise.all(Array.from({ length: 10 }, () => settle(marker(sql), 4000)))
      await sleep(300)
      const seen = attempts
      await sql.end({ timeout: 0 })
      await burst
      await new Promise(resolve => fatal.close(resolve))
      assert.strictEqual(first, 'rejected:57P03')
      assert.strictEqual(second, 'rejected:57P03')
      assert(Date.now() - start >= 200, 'Consecutive fatal startups must be paced')
      assert(seen <= 4, 'Attempts must be paced, saw ' + seen)
    } else if (name === 'cancel-errors') {
      const created = []
      const sql = make({ connect_timeout: 2, socket: async() => {
        const socket = net.connect(server.port, '127.0.0.1')
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
        created.push(socket)
        return socket
      } })
      const query = sql.unsafe('select hang', [], { simple: true })
      const outcome = settle(query)
      await until(() => server.events.some(x => x.sql === 'select hang'))
      const canceller = query.canceller
      query.canceller = x => canceller(x).catch(() => { /* Observed through uncaught errors. */ })
      const uncaught = []
      const observe = error => uncaught.push(error.message)
      process.on('uncaughtException', observe)
      try {
        query.cancel()
        await until(() => created.length === 2)
        await sleep(20)
        created[1].emit('error', new Error('first cancel error'))
        created[1].emit('error', new Error('second cancel error'))
        await sleep(50)
      } finally {
        process.off('uncaughtException', observe)
      }
      assert.deepStrictEqual(uncaught, [])
      await sql.end({ timeout: 0 })
      assert.strictEqual((await outcome).slice(0, 8), 'rejected')
    } else if (name === 'fatal-backoff') {
      const sql = make({ connect_timeout: 3, backoff: () => 0.4 })
      await marker(sql)
      server.fatal()
      await sleep(100)
      const start = Date.now()
      assert.strictEqual(await settle(marker(sql), 4000), 'resolved')
      assert(Date.now() - start >= 250, 'Close after server FATAL must record inherited backoff')
      await sql.end({ timeout: 0 })
    } else {
      throw new Error('Unknown phase scenario ' + name)
    }
  } finally {
    await Promise.all(clients.map(x => x.end({ timeout: 0 }).catch(() => { /* Cleanup only. */ })))
    await server.close()
    good && await good.close()
  }
}

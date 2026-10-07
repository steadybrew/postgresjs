import assert from 'assert'
import net from 'net'
import { peer } from './peer.js'
import { settle, sleep, until, marker, startups } from './startup.js'

export const leaseNames = ['reserve-close', 'reserve-release-close', 'reserve-stale', 'reserve-queued', 'release-twice',
                           'begin-close', 'begin-stale', 'begin-queued', 'begin-end', 'begin-pipeline-zero',
                           'begin-backpressure', 'raw-begin-unsafe', 'begin-user-commit', 'begin-user-rollback', 'begin-after-end',
                           'reserve-after-end', 'begin-forced-end', 'begin-graceful-end', 'begin-rollbacks',
                           'reserve-released', 'release-queued', 'begin-leaked-commit', 'begin-leaked-rollback', 'begin-leaked-savepoint']

const closed = 'rejected:CONNECTION_CLOSED'
const ended = 'rejected:CONNECTION_ENDED'
const select = (client, text) => client.unsafe(text, [], { simple: true })
const sent = (server, text) => server.events.filter(x => x.type === 'Q' && x.sql === text)

export async function leases(name, postgres, onEvent) {
  const queued = ['reserve-queued', 'release-queued', 'begin-queued', 'begin-forced-end'].includes(name)
  const server = await peer({ holdQuery: queued ? 'hang' : '', onEvent })
  const base = { host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false, fetch_types: false,
                 connect_timeout: 2, backoff: 0.01, onnotice: () => { /* Quiet. */ } }
  const refusals = { count: 0 }
  const backpressure = async() => {
    const socket = net.connect(server.port, '127.0.0.1')
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const write = socket.write.bind(socket)
    socket.write = (...args) => {
      write(...args)
      args[0].length >= 1024 && refusals.count++
      return args[0].length < 1024
    }
    return socket
  }
  const wide = ['begin-pipeline-zero', 'begin-backpressure', 'raw-begin-unsafe', 'begin-user-commit', 'begin-user-rollback'].includes(name)
  const sql = postgres({ ...base, max: wide ? 2 : 1,
                         ...(name === 'begin-pipeline-zero' ? { max_pipeline: 0 } : {}),
                         ...(name === 'begin-backpressure' ? { socket: backpressure } : {}),
                         ...(queued ? { max_pipeline: 0 } : {}) })
  const uncaught = []
  const observe = error => uncaught.push(error.message)
  process.on('uncaughtException', observe)
  try {
    if (name === 'reserve-close') {
      const held = await sql.reserve()
      await marker(held)
      server.disconnect()
      await sleep(100)
      assert.strictEqual(await settle(marker(held)), closed)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'reserve-release-close') {
      const held = await sql.reserve()
      await marker(held)
      server.disconnect()
      await sleep(100)
      held.release()
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'reserve-stale') {
      const held = await sql.reserve()
      await marker(held)
      const other = settle(select(sql, 'select 43 as marker'))
      server.disconnect()
      assert.strictEqual(await other, 'resolved')
      assert.strictEqual(startups(server), 2)
      assert.strictEqual(await settle(select(held, 'select stale')), closed)
      assert.strictEqual(sent(server, 'select stale').length, 0)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'reserve-queued') {
      const held = await sql.reserve()
      const results = ['select hang 1', 'select hang 2', 'select hang 3'].map(text => settle(select(held, text)))
      await until(() => sent(server, 'select hang 1').length === 1)
      server.disconnect()
      assert.deepStrictEqual(await Promise.all(results), [closed, closed, closed])
      assert.strictEqual(sent(server, 'select hang 2').length, 0)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'release-twice') {
      const first = await sql.reserve()
      const pid = (await select(first, 'select 42 as marker')).state.pid
      first.release()
      const second = await sql.reserve()
      const pool = settle(select(sql, 'select 44 as marker'))
      first.release()
      assert.strictEqual(await settle(select(first, 'select stale')), ended)
      assert.strictEqual((await select(second, 'select 42 as marker')).state.pid, pid)
      assert.strictEqual(sent(server, 'select 44 as marker').length, 0)
      assert.strictEqual(sent(server, 'select stale').length, 0)
      second.release()
      assert.strictEqual(await pool, 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-close') {
      const outcome = settle(sql.begin(async t => {
        await marker(t)
        server.disconnect()
        await sleep(100)
        await marker(t)
      }))
      assert.strictEqual(await outcome, closed)
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-stale') {
      let late
      let savepoint
      let finished
      const done = new Promise(resolve => finished = resolve)
      const outcome = settle(sql.begin(async t => {
        try {
          await marker(t)
          const other = settle(select(sql, 'select 43 as marker'))
          server.disconnect()
          assert.strictEqual(await other, 'resolved')
          assert.strictEqual(startups(server), 2)
          late = await settle(select(t, 'select stale'))
          savepoint = await settle(t.savepoint(async() => { /* Never entered. */ }))
          await select(t, 'select stale again')
        } finally {
          finished()
        }
      }))
      assert.strictEqual(await outcome, closed)
      await done
      assert.strictEqual(late, closed)
      assert.strictEqual(savepoint, closed)
      const after = server.events.filter(x => x.pid === 2 && x.type !== 'startup')
      assert(after.every(x => x.sql === 'select 43 as marker' || x.type === 'X'), JSON.stringify(after))
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-queued') {
      const outcome = settle(sql.begin(async t => {
        const results = ['select hang 1', 'select hang 2', 'select hang 3'].map(text => settle(select(t, text)))
        await until(() => sent(server, 'select hang 1').length === 1)
        server.disconnect()
        assert.deepStrictEqual(await Promise.all(results), [closed, closed, closed])
      }))
      assert.strictEqual(await outcome, closed)
      assert.strictEqual(sent(server, 'select hang 2').length, 0)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-end') {
      const outcome = settle(sql.begin(async t => {
        await marker(t)
        server.disconnect()
        await sleep(50)
        assert.strictEqual(await settle(sql.end()), 'resolved')
      }))
      assert.strictEqual(await outcome, closed)
      assert.strictEqual(await settle(sql.end()), 'resolved')
      assert.strictEqual(sent(server, 'commit').length, 0)
      assert.strictEqual(sent(server, 'rollback').length, 0)
    } else if (name === 'begin-pipeline-zero' || name === 'begin-backpressure') {
      const result = await sql.begin(name === 'begin-backpressure' ? ' '.repeat(1100) + 'read write' : '', async t => {
        const first = await marker(t)
        const other = await select(sql, 'select 43 as marker')
        const second = await marker(t)
        return [first, second, other.state.pid]
      })
      assert.deepStrictEqual(result.slice(0, 2), [42, 42])
      const begins = server.events.filter(x => x.type === 'Q' && x.sql.startsWith('begin'))
      assert.strictEqual(begins.length, 1)
      const pid = begins[0].pid
      assert.notStrictEqual(result[2], pid)
      const own = server.events.filter(x => x.type === 'Q' && x.pid === pid).map(x => x.sql)
      assert.deepStrictEqual(own, [begins[0].sql, 'select 42 as marker', 'select 42 as marker'])
      assert.strictEqual(sent(server, 'select 43 as marker').every(x => x.pid !== pid), true)
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
      name === 'begin-backpressure' && assert(refusals.count >= 1, 'Backpressure was never applied')
    } else if (name === 'begin-user-commit' || name === 'begin-user-rollback') {
      const commit = name === 'begin-user-commit'
      const outcome = settle(sql.begin(async t => {
        const pid = (await select(t, 'select 42 as marker')).state.pid
        await (commit ? t`commit` : t`rollback`)
        assert.notStrictEqual((await select(sql, 'select 43 as marker')).state.pid, pid)
        !commit && assert.fail('mine')
      }))
      assert.strictEqual(await outcome, commit ? 'resolved' : 'rejected:ERR_ASSERTION')
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-after-end' || name === 'reserve-after-end') {
      await marker(sql)
      await sql.end()
      const before = startups(server)
      assert.strictEqual(await settle(name === 'begin-after-end' ? sql.begin(t => marker(t)) : sql.reserve()), 'rejected:CONNECTION_ENDED')
      assert.strictEqual(startups(server), before)
    } else if (name === 'begin-forced-end') {
      const outcome = settle(sql.begin(async t => {
        await marker(t)
        await select(t, 'select hang')
      }))
      await until(() => sent(server, 'select hang').length === 1)
      await sql.end({ timeout: 0 })
      assert.strictEqual(await outcome, 'rejected:CONNECTION_DESTROYED')
    } else if (name === 'begin-graceful-end') {
      const outcome = settle(sql.begin(async t => {
        await marker(t)
        await sleep(100)
        return marker(t)
      }))
      await until(() => sent(server, 'select 42 as marker').length === 1)
      const pooled = settle(select(sql, 'select 43 as marker'))
      await sleep(5)
      const ending = settle(sql.end())
      assert.strictEqual(await outcome, 'resolved')
      assert.strictEqual(await pooled, 'resolved')
      assert.strictEqual(await ending, 'resolved')
    } else if (name === 'begin-rollbacks') {
      const outcome = settle(sql.begin(async t => {
        await t.savepoint(async s => {
          await marker(s)
          throw new Error('inner')
        }).catch(() => { /* Expected. */ })
        throw new Error('outer')
      }))
      assert.strictEqual(await outcome, 'rejected:outer')
      const texts = server.events.filter(x => x.type === 'P').map(x => x.text.toLowerCase())
      const savepoint = texts.findIndex(x => x.startsWith('savepoint'))
      const rollbackTo = texts.findIndex(x => x.startsWith('rollback to'))
      const rollback = texts.findIndex(x => x === 'rollback')
      assert(savepoint >= 0 && rollbackTo > savepoint && rollback > rollbackTo, JSON.stringify(texts))
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'reserve-released') {
      const held = await sql.reserve()
      await marker(held)
      held.release()
      assert.strictEqual(await settle(select(held, 'select stale')), ended)
      assert.strictEqual(sent(server, 'select stale').length, 0)
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'release-queued') {
      const held = await sql.reserve()
      const results = ['select hang 1', 'select hang 2', 'select hang 3'].map(text => settle(select(held, text)))
      await until(() => sent(server, 'select hang 1').length === 1)
      held.release()
      assert.deepStrictEqual(await Promise.all(results.slice(1)), [ended, ended])
      assert.strictEqual(sent(server, 'select hang 2').length, 0)
      assert.strictEqual(await settle(sql.end({ timeout: 0 })), 'resolved')
    } else if (name === 'begin-leaked-commit' || name === 'begin-leaked-rollback' || name === 'begin-leaked-savepoint') {
      let leaked
      const outcome = settle(sql.begin(async t => {
        await marker(t)
        name === 'begin-leaked-savepoint' ? await t.savepoint(async s => { leaked = s; await marker(s) }) : leaked = t
        name === 'begin-leaked-rollback' && assert.fail('mine')
      }))
      assert.strictEqual(await outcome, name === 'begin-leaked-rollback' ? 'rejected:ERR_ASSERTION' : 'resolved')
      assert.strictEqual(await settle(select(leaked, 'select stale')), ended)
      assert.strictEqual(await settle(leaked.savepoint(async() => { /* Never entered. */ })), ended)
      assert.strictEqual(sent(server, 'select stale').length, 0)
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'raw-begin-unsafe') {
      assert.strictEqual(await settle(sql`begin`), 'rejected:UNSAFE_TRANSACTION')
      assert.strictEqual(await settle(sql.end({ timeout: 0 })), 'resolved')
    } else {
      throw new Error('Unknown lease scenario ' + name)
    }
    assert.deepStrictEqual(uncaught, [])
  } finally {
    process.off('uncaughtException', observe)
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

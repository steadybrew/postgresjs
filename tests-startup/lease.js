import assert from 'assert'
import net from 'net'
import { peer } from './peer.js'
import { settle, sleep, until, marker, startups } from './startup.js'

export const leaseNames = ['reserve-close', 'reserve-release-close', 'reserve-stale', 'reserve-queued', 'release-twice',
                           'begin-close', 'begin-stale', 'begin-queued', 'begin-end', 'begin-pipeline-zero',
                           'begin-backpressure', 'raw-begin-unsafe', 'begin-user-commit', 'begin-user-rollback', 'begin-after-end',
                           'reserve-after-end', 'begin-forced-end', 'begin-graceful-end', 'begin-rollbacks',
                           'reserve-released', 'release-queued', 'begin-leaked-commit', 'begin-leaked-rollback', 'begin-leaked-savepoint',
                           'reserve-handoff-gap', 'begin-handoff-gap', 'begin-settling', 'begin-commit-fails', 'begin-start-failed',
                           'reserve-raw-begin', 'begin-leaked-savepoint-late', 'reserve-cancel-before-send', 'begin-cancel-before-send',
                           'pool-cancel-before-send', 'reserve-cancel-queued', 'begin-cancel-queued',
                           'pooled-raw-begin', 'pooled-retry', 'owned-lifetime',
                           'settling-disconnect-commit', 'settling-disconnect-rollback', 'settling-disconnect-prepare',
                           'settling-end-commit', 'settling-end-rollback', 'settling-end-prepare',
                           'settling-fail-rollback', 'settling-fail-prepare',
                           'outcome-commit-released', 'outcome-release-released', 'reserve-release-after-error', 'begin-late-drain']

const closed = 'rejected:CONNECTION_CLOSED'
const ended = 'rejected:CONNECTION_ENDED'
const select = (client, text) => client.unsafe(text, [], { simple: true })
const sent = (server, text) => server.events.filter(x => x.type === 'Q' && x.sql === text)

export async function leases(name, postgres, onEvent) {
  const queued = ['reserve-queued', 'release-queued', 'begin-queued', 'begin-forced-end'].includes(name)
  const settling = name.startsWith('settling-') ? name.split('-') : []
  const holdsCommit = name === 'begin-settling' || name === 'begin-commit-fails'
  const holdStatement = holdsCommit ? 'commit'
    : settling[2] === 'commit' ? 'commit'
    : settling[2] === 'rollback' ? 'rollback'
    : settling[2] === 'prepare' ? 'prepare transaction'
    : name === 'pooled-raw-begin' ? 'begin -- stall' : ''
  const server = await peer({ holdQuery: queued ? 'hang' : name.startsWith('pooled-') ? 'hang' : '', holdStatement,
                              failQuery: name === 'begin-start-failed' ? 'begin bogus' : '', onEvent })
  const base = { host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false, fetch_types: true,
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
  const gap = async() => {
    const socket = net.connect(server.port, '127.0.0.1')
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const emit = socket.emit.bind(socket)
    socket.emit = (event, ...args) => {
      const result = emit(event, ...args)
      event === 'data' && queueMicrotask(() => emit('drain'))
      return result
    }
    return socket
  }
  const late = async() => {
    const socket = net.connect(server.port, '127.0.0.1')
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const write = socket.write.bind(socket)
    const emit = socket.emit.bind(socket)
    let blocked = false
    socket.write = (...args) => {
      write(...args)
      blocked = blocked || args[0].length >= 1024
      return args[0].length < 1024
    }
    socket.emit = (event, ...args) => {
      const result = emit(event, ...args)
      event === 'data' && blocked && (blocked = false, queueMicrotask(() => emit('drain')))
      return result
    }
    return socket
  }
  const sockets = []
  const tracked = async() => {
    const socket = await gap()
    sockets.push(socket)
    return socket
  }
  const wide = ['reserve-raw-begin', 'begin-pipeline-zero', 'begin-backpressure', 'raw-begin-unsafe', 'begin-user-commit',
                'begin-user-rollback',
                'pooled-raw-begin', 'pooled-retry'].includes(name)
  const sql = postgres({ ...base, max: wide ? 2 : 1,
                         ...(name === 'owned-lifetime' ? { max_lifetime: 0.2 } : {}),
                         ...(name === 'begin-pipeline-zero' || name.endsWith('-cancel-queued') ? { max_pipeline: 0 } : {}),
                         ...(name === 'begin-backpressure' ? { socket: backpressure } : {}),
                         ...(name.endsWith('-handoff-gap') ? { socket: gap } : {}),
                         ...(name === 'begin-late-drain' ? { socket: late } : {}),
                         ...(name === 'reserve-release-after-error' ? { socket: tracked } : {}),
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
    } else if (name === 'reserve-release-after-error') {
      const held = await sql.reserve()
      await marker(held)
      sockets[0].emit('error', new Error('socket failed'))
      held.release()
      assert.strictEqual(await settle(select(held, 'select stale')), closed)
      assert.strictEqual(sent(server, 'select stale').length, 0)
      await sleep(100)
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
      const after = server.events.filter(x => x.pid === 2 && x.type === 'Q')
      assert(after.every(x => x.sql === 'select 43 as marker'), JSON.stringify(after))
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
    } else if (name === 'reserve-handoff-gap') {
      const claim = sql.reserve()
      const pooled = settle(select(sql, 'select 43 as marker'))
      const held = await claim
      await sleep(30)
      assert.strictEqual(sent(server, 'select 43 as marker').length, 0)
      assert.strictEqual(await settle(marker(held)), 'resolved')
      assert.strictEqual(sent(server, 'select 43 as marker').length, 0)
      held.release()
      assert.strictEqual(await pooled, 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-handoff-gap') {
      const pooled = settle(select(sql, 'select 43 as marker'))
      const outcome = settle(sql.begin(async t => {
        await sleep(30)
        assert.strictEqual(sent(server, 'select 43 as marker').length, 0)
        await marker(t)
      }))
      assert.strictEqual(await outcome, 'resolved')
      assert.strictEqual(await pooled, 'resolved')
      const texts = server.events.filter(x => x.type === 'P' || x.type === 'Q').map(x => x.text || x.sql)
      assert(texts.indexOf('commit') < texts.indexOf('select 43 as marker'), JSON.stringify(texts))
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-late-drain') {
      await marker(sql)
      const first = settle(sql.begin(async t => {
        await select(t, 'select 42 as marker -- ' + 'x'.repeat(1100))
        await sleep(30)
        await marker(t)
      }))
      const second = settle(sql.begin(async t => { await marker(t) }))
      const outcomes = await Promise.all([first, second])
      const texts = server.events.filter(x => x.type === 'P' || x.type === 'Q').map(x => x.text || x.sql)
      const begins = texts.flatMap((x, i) => x.startsWith('begin') ? [i] : [])
      assert(texts.indexOf('commit') < begins[1], JSON.stringify(texts))
      assert.deepStrictEqual(outcomes, ['resolved', 'resolved'])
      assert.strictEqual(startups(server), 1)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-settling') {
      let leaked
      const outcome = settle(sql.begin(async t => {
        leaked = t
        await marker(t)
      }))
      await until(() => server.heldStatement())
      const pooled = settle(select(sql, 'select 43 as marker'))
      assert.strictEqual(await settle(select(leaked, 'select late')), ended)
      assert.strictEqual(await settle(leaked.savepoint(async() => undefined)), ended)
      await sleep(30)
      assert.strictEqual(sent(server, 'select late').length, 0)
      assert.strictEqual(sent(server, 'select 43 as marker').length, 0)
      server.releaseStatement()
      assert.strictEqual(await outcome, 'resolved')
      assert.strictEqual(await pooled, 'resolved')
      assert.strictEqual(startups(server), 1)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-commit-fails') {
      const first = (await select(sql, 'select 42 as marker')).state.pid
      const outcome = settle(sql.begin(async t => { await marker(t) }))
      await until(() => server.heldStatement())
      const pooled = settle(select(sql, 'select 43 as marker'))
      server.releaseStatement(true)
      assert.strictEqual(await outcome, 'rejected:40002')
      assert.strictEqual(await pooled, 'resolved')
      assert.strictEqual(startups(server), 2)
      assert.notStrictEqual((await select(sql, 'select 42 as marker')).state.pid, first)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-start-failed') {
      const first = (await select(sql, 'select 42 as marker')).state.pid
      assert.strictEqual(await settle(sql.begin('bogus', async() => assert.fail('never entered'))), 'rejected:42601')
      assert.strictEqual((await select(sql, 'select 42 as marker')).state.pid, first)
      assert.strictEqual(startups(server), 1)
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'reserve-raw-begin') {
      const held = await sql.reserve()
      await held`begin`
      await held`commit`
      const pid = (await select(held, 'select 42 as marker')).state.pid
      const pooled = settle(select(sql, 'select 43 as marker'))
      await sleep(30)
      assert.strictEqual(sent(server, 'select 43 as marker').filter(x => x.pid === pid).length, 0)
      held.release()
      assert.strictEqual(await pooled, 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-leaked-savepoint-late') {
      let leaked
      assert.strictEqual(await settle(sql.begin(async t => { leaked = t.savepoint(async() => { await sleep(50) }) })), 'resolved')
      assert.strictEqual(await leaked.then(() => 'resolved', e => e === null ? 'null' : e.code), 'CONNECTION_ENDED')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name.endsWith('-cancel-before-send')) {
      const cancelled = async client => {
        const q = select(client, 'select 2')
        q.execute()
        q.cancel()
        await q.catch(() => undefined)
      }
      if (name === 'reserve-cancel-before-send') {
        const held = await sql.reserve()
        await marker(held)
        await cancelled(held)
        assert.strictEqual(await settle(marker(held)), 'resolved')
        held.release()
      } else if (name === 'begin-cancel-before-send') {
        await marker(sql)
        assert.strictEqual(await settle(sql.begin(t => cancelled(t))), 'rejected:57014')
      } else {
        await marker(sql)
        await cancelled(sql)
      }
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'reserve-cancel-queued') {
      const held = await sql.reserve()
      await marker(held)
      const first = select(held, 'select 1')
      first.execute()
      const doomed = select(held, 'select 2')
      doomed.execute()
      doomed.cancel()
      const outcome = settle(doomed)
      const after = settle(select(held, 'select 3'))
      assert.strictEqual(await settle(first), 'resolved')
      assert.strictEqual(await outcome, 'rejected:57014')
      assert.strictEqual(await after, 'resolved')
      held.release()
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'begin-cancel-queued') {
      assert.strictEqual(await settle(sql.begin(async t => {
        const first = select(t, 'select 1')
        first.execute()
        const doomed = select(t, 'select 2')
        doomed.execute()
        doomed.cancel()
        doomed.catch(() => undefined)
        await first
        return select(t, 'select 3')
      })), 'rejected:57014')
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (name === 'pooled-raw-begin') {
      await Promise.all([marker(sql), marker(sql)])
      const raw = settle(select(sql, 'begin -- stall'))
      settle(select(sql, 'select hang'))
      await until(() => server.heldStatement())
      const inside = settle(sql.begin(async t => { await marker(t) }))
      server.releaseStatement()
      assert.strictEqual(await raw, 'rejected:UNSAFE_TRANSACTION')
      assert.strictEqual(await inside, 'resolved')
    } else if (name === 'pooled-retry') {
      const statement = () => sql`select 77 as marker`
      await Promise.all([statement(), statement()])
      server.hold('select 77')
      const pooled = settle(statement())
      settle(select(sql, 'select hang'))
      await until(() => server.heldStatement())
      const inside = settle(sql.begin(async t => { await marker(t) }))
      server.releaseStatement('RevalidateCachedQuery')
      assert.strictEqual(await pooled, 'rejected:40002')
      assert.strictEqual(await inside, 'resolved')
      assert.strictEqual(server.events.filter(x => x.type === 'P' && x.text === 'select 77 as marker').length, 2)
    } else if (name === 'owned-lifetime') {
      const held = await sql.reserve()
      await marker(held)
      await sleep(400)
      assert.strictEqual(await settle(marker(held)), 'resolved')
      const pooled = settle(select(sql, 'select 43 as marker'))
      held.release()
      assert.strictEqual(await pooled, 'resolved')
      assert.strictEqual(startups(server), 2)
      assert.strictEqual(await settle(marker(sql)), 'resolved')
      assert.strictEqual(await settle(sql.end()), 'resolved')
    } else if (settling.length) {
      const [, mode, statement] = settling
      const first = (await select(sql, 'select 42 as marker')).state.pid
      const outcome = settle(sql.begin(async t => {
        await marker(t)
        statement === 'prepare' && t.prepare('tx1')
        if (statement === 'rollback')
          throw Object.assign(new Error('user'), { code: 'USER' })
      }))
      await until(() => server.heldStatement())
      const pooled = settle(sql`select 43 as marker`)
      await sleep(5)
      let ending
      if (mode === 'disconnect') {
        server.disconnect()
      } else if (mode === 'end') {
        ending = settle(sql.end())
        await sleep(30)
        server.releaseStatement()
      } else {
        server.releaseStatement(true)
      }
      assert.strictEqual(await outcome, mode === 'disconnect' ? closed : mode === 'fail' ? 'rejected:40002'
        : statement === 'rollback' ? 'rejected:USER' : 'resolved')
      assert.strictEqual(await pooled, 'resolved')
      mode === 'fail' && assert.strictEqual(startups(server), 2)
      mode === 'fail' && assert.notStrictEqual((await select(sql, 'select 42 as marker')).state.pid, first)
      assert.strictEqual(await settle(ending || sql.end()), 'resolved')
    } else if (name.startsWith('outcome-')) {
      const pidOf = async() => (await select(sql, 'select 42 as marker')).state.pid
      const first = await pidOf()
      if (name === 'outcome-commit-released') {
        assert.strictEqual(await settle(sql.begin(async t => { await marker(t) })), 'resolved')
      } else if (name === 'outcome-release-released') {
        const held = await sql.reserve()
        await marker(held)
        held.release()
      }
      const second = await pidOf()
      assert.strictEqual(second, first)
      assert.strictEqual(startups(server), 1)
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

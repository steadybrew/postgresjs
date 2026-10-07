import assert from 'assert'
import net from 'net'
import { peer } from './peer.js'

const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(r => resolve = r)
  return { promise, resolve }
}

export async function ownership(name, postgres, onEvent) {
  const max = name === 'capacity' ? 3 : name.startsWith('mixed-') ? Number(name.split('-')[1]) : 1
  const fetch_types = !name.includes('no-fetch')
  const mixed = name.startsWith('mixed-')
  const started = deferred()
  const server = await peer({ holdStartup: name === 'assigned-order' || name === 'startup-drain' || name === 'startup-end' || name === 'queued-drain',
                              failAuthentication: name === 'authentication-failure', onStartup: () => started.resolve(), onEvent })
  let clientSocket
  let creations = 0
  const socket = async() => {
    if (name === 'creation-failure' && ++creations === 1)
      throw new Error('creation denied')
    clientSocket = net.connect(server.port, '127.0.0.1')
    await new Promise((resolve, reject) => {
      clientSocket.once('connect', resolve)
      clientSocket.once('error', reject)
    })
    return clientSocket
  }
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false,
                         max, fetch_types, connect_timeout: 1,
                         ...(name === 'queued-drain' ? { max_pipeline: 0 } : {}),
                         ...(name === 'startup-drain' || name === 'creation-failure' || name === 'queued-drain' ? { socket } : {}) })
  const query = client => client.unsafe('select 42 as marker', [], { simple: true })
  async function capacity(max = sql.options.max) {
    for (let round = 0; round < 2; round++) {
      const held = await Promise.all(Array.from({ length: max }, () => sql.reserve()))
      const results = await Promise.all(held.map(query))
      assert.strictEqual(new Set(results.map(x => x.state.pid)).size, max)
      results.forEach(x => assert.strictEqual(x[0].marker, 42))
      held.forEach(x => x.release())
    }
  }
  try {
    if (mixed) {
      const assigned = sql.reserve()
      const user = query(sql).execute()
      const others = Array.from({ length: max - 1 }, () => sql.reserve())
      const held = await assigned
      await query(held)
      held.release()
      await user
      const remaining = await Promise.all(others)
      const results = await Promise.all(remaining.map(query))
      assert.strictEqual(new Set(results.map(x => x.state.pid)).size, max - 1)
      remaining.forEach(x => x.release())
      await capacity()
    } else if (name === 'capacity' || name === 'no-fetch-capacity') {
      assert.strictEqual((await query(sql))[0].marker, 42)
      await capacity()
    } else if (name === 'queued-reconnect') {
      const occupied = await sql.reserve()
      await query(occupied)
      const first = sql.reserve()
      const second = sql.reserve()
      server.disconnect()
      const acquired = await first
      let secondGranted = false
      second.then(() => secondGranted = true)
      await query(acquired)
      await turn()
      assert.strictEqual(secondGranted, false)
      acquired.release()
      const next = await second
      await query(next)
      next.release()
      await capacity()
    } else if (name === 'queued-drain') {
      const initial = query(sql).execute()
      await started.promise
      clientSocket.on('data', () => clientSocket.emit('drain'))
      server.releaseStartup()
      await initial
      const first = query(sql).execute()
      await Promise.resolve()
      const assigned = sql.reserve()
      const queued = query(sql).execute()
      await first
      const held = await assigned
      await query(held)
      assert.strictEqual(server.events.filter(x => x.type === 'Q').length, 3)
      held.release()
      await queued
      await capacity()
    } else if (name === 'assigned-order' || name === 'startup-drain') {
      let granted = false
      const assigned = sql.reserve().then(x => (granted = true, x))
      const queued = query(sql).execute()
      await started.promise
      name === 'startup-drain' && clientSocket.emit('drain')
      await turn()
      assert.strictEqual(granted, false)
      assert.strictEqual(server.events.filter(x => x.type !== 'startup').length, 0)
      server.releaseStartup()
      const held = await assigned
      await query(held)
      name === 'startup-drain' && clientSocket.emit('drain')
      await turn()
      assert.strictEqual(server.events.filter(x => x.type === 'Q').length, 1)
      held.release()
      await queued
      await capacity()
    } else if (name === 'creation-failure' || name === 'authentication-failure') {
      await assert.rejects(sql.reserve(), error => name === 'creation-failure'
        ? error.message === 'creation denied'
        : error.code === '28P01')
      await capacity()
    } else if (name === 'startup-end') {
      const assigned = sql.reserve()
      const queued = sql.reserve()
      const outcomes = Promise.all([assigned, queued].map(x => assert.rejects(x, error => error.code === 'CONNECTION_ENDED')))
      await started.promise
      await sql.end({ timeout: 0 })
      await outcomes
      await turn()
      assert.strictEqual(server.events.filter(x => x.type === 'startup').length, 1)
    } else {
      throw new Error('Unknown ownership scenario ' + name)
    }
    const expectedQueries = mixed ? 1 + 3 * max
      : name === 'capacity' ? 7
      : name === 'no-fetch-capacity' ? 3
      : name === 'queued-drain' ? 6
      : name === 'queued-reconnect' ? 5
      : name === 'assigned-order' || name === 'startup-drain' ? 4
      : name === 'startup-end' ? 0 : 2
    assert.strictEqual(server.events.filter(x => x.type === 'Q').length, expectedQueries, 'Duplicate or missing user dispatch')
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

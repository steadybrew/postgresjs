import assert from 'assert'
import { peer } from './peer.js'
import { settle, until, startups } from './startup.js'
import { handovers, history, seen } from './invariants.js'

export const requestNames = ['idle', 'opens', 'sent-ahead', 'drained-at-open', 'refused-ending', 'refused-copy', 'cancelled-queued',
                             'lease-idle', 'lease-busy', 'lease-queued', 'lease-opens', 'lease-reconnect', 'close-opening']

const turn = () => new Promise(resolve => setImmediate(resolve))
const select = (client, text = 'select 42 as marker') => client.unsafe(text, [], { simple: true })
const lease = () => seen.find(x => x.reserve)
const visited = (request, stage) => (history.get(request) || []).includes(stage)

function expectSeen(request, steps, handed) {
  assert.deepStrictEqual(history.get(request), steps)
  assert.deepStrictEqual(handovers.filter(x => x.request === request).map(x => [x.fresh, x.behind]), handed)
}

export async function requests(name, postgres, onEvent) {
  const closed = Promise.withResolvers()
  const server = await peer({ holdStartup: ['drained-at-open', 'close-opening'].includes(name), onEvent })
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false,
                         max: 1, fetch_types: false, connect_timeout: 1, onclose: () => closed.resolve(),
                         ...(['cancelled-queued', 'lease-queued'].includes(name) ? { max_pipeline: 0 } : {}) })
  try {
    if (name === 'idle') {
      await select(sql)
      const query = select(sql)
      assert.strictEqual((await query)[0].marker, 42)
      expectSeen(query, ['New', 'Active', 'Settled'], [[false, 0]])
    } else if (name === 'opens') {
      const query = select(sql)
      assert.strictEqual((await query)[0].marker, 42)
      expectSeen(query, ['New', 'Opening', 'Active', 'Settled'], [[true, 0]])
    } else if (name === 'sent-ahead') {
      server.hold('stall')
      const running = settle(select(sql, 'select 1 -- stall'))
      await until(() => server.heldStatement())
      const ahead = select(sql).execute()
      await until(() => handovers.some(x => x.request === ahead))
      server.releaseStatement()
      assert.strictEqual((await ahead)[0].marker, 42)
      assert.strictEqual(await running, 'resolved')
      expectSeen(ahead, ['New', 'Sent', 'Active', 'Settled'], [[false, 1]])
    } else if (name === 'drained-at-open') {
      const first = select(sql).execute()
      const second = select(sql).execute()
      await until(() => startups(server) === 1)
      server.releaseStartup()
      assert.strictEqual((await first)[0].marker, 42)
      assert.strictEqual((await second)[0].marker, 42)
      expectSeen(first, ['New', 'Opening', 'Active', 'Settled'], [[true, 0]])
      expectSeen(second, ['New', 'Queued', 'Sent', 'Active', 'Settled'], [[false, 1]])
    } else if (name === 'refused-ending') {
      await sql.end()
      const query = select(sql)
      assert.strictEqual(await settle(query), 'rejected:CONNECTION_ENDED')
      expectSeen(query, ['New', 'Settled'], [])
    } else if (name === 'refused-copy') {
      const copy = await sql.unsafe('copy test from stdin').writable()
      copy.on('error', () => undefined)
      const query = select(sql)
      assert.strictEqual(await settle(query), 'rejected:COPY_IN_PROGRESS')
      expectSeen(query, ['New', 'Settled'], [])
    } else if (name === 'cancelled-queued') {
      server.hold('stall')
      settle(select(sql, 'select 1 -- stall'))
      await until(() => server.heldStatement())
      const query = select(sql).execute()
      await until(() => visited(query, 'Queued'))
      await query.cancel()
      assert.strictEqual(await settle(query), 'rejected:57014')
      expectSeen(query, ['New', 'Queued', 'Settled'], [])
    } else if (name === 'lease-idle') {
      await select(sql)
      const reserved = await sql.reserve()
      expectSeen(lease(), ['New', 'Settled'], [[false, 0]])
      reserved.release()
    } else if (name === 'lease-busy') {
      server.hold('stall')
      const running = settle(select(sql, 'select 1 -- stall'))
      await until(() => server.heldStatement())
      const transaction = sql.begin(async() => undefined)
      await until(() => handovers.some(x => x.request.reserve))
      expectSeen(lease(), ['New', 'Settled'], [[false, 1]])
      server.releaseStatement()
      await transaction
      assert.strictEqual(await running, 'resolved')
    } else if (name === 'lease-queued') {
      server.hold('stall')
      settle(select(sql, 'select 1 -- stall'))
      await until(() => server.heldStatement())
      const reserving = sql.reserve()
      await until(() => lease() && visited(lease(), 'Queued'))
      server.releaseStatement()
      const reserved = await reserving
      expectSeen(lease(), ['New', 'Queued', 'Settled'], [[false, 0]])
      reserved.release()
    } else if (name === 'lease-opens') {
      const reserved = await sql.reserve()
      expectSeen(lease(), ['New', 'Opening', 'Settled'], [[true, 0]])
      reserved.release()
    } else if (name === 'lease-reconnect') {
      await select(sql)
      server.disconnect()
      await closed.promise
      const reserved = await sql.reserve()
      expectSeen(lease(), ['New', 'Opening', 'Settled'], [[true, 0]])
      reserved.release()
    } else {
      assert.strictEqual(name, 'close-opening')
      const first = select(sql).execute()
      const second = select(sql).execute()
      await until(() => startups(server) === 1)
      const closing = sql.close()
      await turn()
      server.releaseStartup()
      assert.strictEqual((await first)[0].marker, 42)
      await until(() => startups(server) === 2)
      server.releaseStartup()
      assert.strictEqual((await second)[0].marker, 42)
      await closing
      assert.deepStrictEqual(handovers.map(x => [x.request === first, x.request === second, x.fresh, x.behind]),
        [[true, false, true, 0], [false, true, true, 0]])
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

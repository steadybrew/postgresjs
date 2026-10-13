import assert from 'assert'
import { peer } from './peer.js'
import { marker } from './startup.js'

export const parameterNames = ['known-types', 'known-types-prepared', 'unknown-types', 'simple-typed']

export async function parameters(name, postgres, onEvent) {
  const server = await peer({ failQuery: name === 'simple-typed' ? 'fail_me' : '', onEvent })
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false,
                         fetch_types: false, connect_timeout: 2, max: 1, prepare: name === 'known-types-prepared' })
  const frames = pid => server.events.filter(x => x.pid === pid && 'PDHBES'.includes(x.type)).map(x => x.type).join('')
  const declared = () => server.events.filter(x => x.type === 'P' && x.pid === 1).map(x => x.types)
  try {
    if (name === 'known-types') {
      await sql`select ${ true } as a, ${ new Date(0) } as b, ${ sql.typed('x', 25) } as c`
      assert.strictEqual(frames(1), 'PDBES')
      assert.deepStrictEqual(declared(), [[16, 1184, 25]])
    } else if (name === 'known-types-prepared') {
      const run = () => sql`select ${ true } as a, ${ new Date(0) } as b, ${ sql.typed('x', 25) } as c`
      await run()
      await run()
      assert.strictEqual(frames(1), 'PDBESBES')
    } else if (name === 'unknown-types') {
      await sql`select ${ 'x' } as a`
      await sql`select ${ null } as a`
      await sql`select ${ sql.typed('x') } as a`
      assert.strictEqual(frames(1), 'PDHBES'.repeat(3))
      assert.deepStrictEqual(declared(), [[0], [0], [0]])
    } else if (name === 'simple-typed') {
      await assert.rejects(sql`select ${ true } as fail_me`.simple(), error => error.code === '42601')
      assert.strictEqual(server.events.filter(x => x.pid === 1 && x.type === 'S').length, 0)
      assert.strictEqual(await marker(sql), 42)
    } else {
      throw new Error('Unknown parameters scenario ' + name)
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

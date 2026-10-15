import assert from 'assert'
import { peer } from './peer.js'
import { marker, until } from './startup.js'

export const parameterNames = ['known-types', 'known-types-prepared', 'unknown-types', 'simple-typed', 'warn-report',
                               'client-plain', 'client-array', 'client-array-prepared', 'client-prepared',
                               'pipelined-typed', 'pipelined-client', 'first-run-typed', 'first-run-client', 'first-run-plain',
                               'second-run-pipelines']

const types = {
  'warn-report': [3802, 25],
  'client-plain': [3802, 16, 25, 3802],
  'client-array': [1007, 3802],
  'client-array-prepared': [1007, 3802],
  'client-prepared': [3802]
}

export async function parameters(name, postgres, onEvent) {
  const server = await peer({ failQuery: name === 'simple-typed' ? 'fail_me' : '',
                              holdStatement: /^(pipelined|first-run|second-run)/.test(name) ? 'hang' : '',
                              parameterTypes: types[name] || [], onEvent })
  const reports = []
  const seen = []
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false,
                         fetch_types: false, connect_timeout: 2, max: 1, prepare: name.endsWith('-prepared') || /^(first|second)-run/.test(name),
                         ...name === 'warn-report' && { parameter_types: 'warn', ontypemismatch: x => reports.push(x) },
                         ...(/^client-|-client$/.test(name)) && { parameter_types: 'client' },
                         ...name === 'client-plain' && { debug: (id, query, values, described) => values.length && seen.push(described.slice()) } })
  const frames = pid => server.events.filter(x => x.pid === pid && 'PDHBES'.includes(x.type)).map(x => x.type).join('')
  const declared = () => server.events.filter(x => x.type === 'P' && x.pid === 1).map(x => x.types)
  const bound = () => server.events.filter(x => x.type === 'B').map(x => x.values)
  try {
    if (name === 'known-types') {
      await sql`select ${ true } as a, ${ new Date(0) } as b, ${ sql.typed('x', 25) } as c`
      assert.strictEqual(frames(1), 'PDBES')
      assert.deepStrictEqual(declared(), [[16, 1184, 25]])
      assert.deepStrictEqual(bound(), [['t', '1970-01-01T00:00:00.000Z', 'x']])
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
    } else if (name === 'warn-report') {
      await sql`select ${ 'x' } as a, ${ 'y' } as b`
      assert.strictEqual(frames(1), 'PDHBES')
      assert.deepStrictEqual(bound(), [['"x"', 'y']])
      assert.deepStrictEqual(reports, [{ query: 'select $1 as a, $2 as b', parameters: [{ position: 1, oid: 3802, typeof: 'string' }] }])
    } else if (name === 'client-plain') {
      await sql`select ${ '{"a":1}' } as a, ${ 1 } as b, ${ { a: 1 } } as c, ${ null } as d, ${ true } as e`
      assert.strictEqual(frames(1), 'PDBES')
      assert.deepStrictEqual(declared(), [[0, 0, 0, 0, 16]])
      assert.deepStrictEqual(bound(), [['{"a":1}', '1', '{"a":1}', null, 't']])
      assert.deepStrictEqual(seen, [[0, 0, 0, 0, 16]])
    } else if (name === 'client-array') {
      await sql`select ${ [1, 2] } as a, ${ 'x' } as b`
      await sql`select ${ [1, 2] } as a, ${ 'x' } as b`
      assert.strictEqual(frames(1), 'PDHBES'.repeat(2))
      assert.deepStrictEqual(bound(), [['{"1","2"}', 'x'], ['{"1","2"}', 'x']])
    } else if (name === 'client-array-prepared') {
      const run = () => sql`select ${ [1, 2] } as a, ${ 'x' } as b`
      await run()
      await run()
      assert.strictEqual(frames(1), 'PDHBESBES')
      assert.deepStrictEqual(bound(), [['{"1","2"}', 'x'], ['{"1","2"}', 'x']])
    } else if (name === 'pipelined-typed' || name === 'pipelined-client') {
      const typed = name === 'pipelined-typed'
      const first = (typed ? sql`select ${ true } as hang` : sql`select ${ 'x' } as hang`).execute()
      const second = (typed ? sql`select ${ true } as b` : sql`select ${ 1 } as b`).execute()
      await until(() => frames(1) === 'PDBESPDBES')
      assert(server.heldStatement())
      server.releaseStatement()
      await Promise.all([first, second])
    } else if (name === 'client-prepared') {
      const run = x => sql`select ${ x } as a`
      await run('x')
      await run('y')
      await run([1])
      assert.strictEqual(frames(1), 'PDBESBESBES')
      assert.deepStrictEqual(bound(), [['x'], ['y'], ['[1]']])
    } else if (name === 'first-run-plain') {
      const run = () => sql`select 1 as hang`.execute()
      const first = run()
      const second = run()
      await until(() => frames(1) === 'PDBESPDBES')
      assert(server.heldStatement())
      server.releaseStatement()
      await Promise.all([first, second])
    } else if (name.startsWith('first-run-')) {
      const run = () => (name === 'first-run-typed' ? sql`select ${ true } as hang` : sql`select ${ 'x' } as hang`).execute()
      const first = run()
      const second = run()
      await until(() => server.heldStatement())
      assert.strictEqual(frames(1), 'PDBES')
      server.releaseStatement()
      await Promise.all([first, second])
      const names = server.events.filter(x => x.type === 'B').map(x => x.name)
      assert.strictEqual(frames(1), 'PDBESBES')
      assert.strictEqual(names.length, 2)
      assert(names[0] && names[0] === names[1] && names[0] === server.events.find(x => x.type === 'P').name)
    } else if (name === 'second-run-pipelines') {
      const run = () => sql`select ${ true } as hang`.execute()
      const first = run()
      await until(() => server.heldStatement())
      server.releaseStatement()
      await first
      server.hold('hang')
      const held = run()
      const next = [run(), run()]
      await until(() => frames(1) === 'PDBESBESBESBES')
      assert(server.heldStatement())
      server.releaseStatement()
      await Promise.all([held, ...next])
    } else {
      throw new Error('Unknown parameters scenario ' + name)
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

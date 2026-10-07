/* eslint no-console: 0 */
/* global addEventListener */
import postgres from './cf/src/index.js'
addEventListener('unhandledrejection', (event) => console.error('WORKER_UNHANDLED_REJECTION', event.reason?.stack || String(event.reason)))
function equal(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Mismatch ' + JSON.stringify({ expected: b, actual: a }))
}
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ready: true })
    const name = url.searchParams.get('case')
        , port = Number(url.searchParams.get('port'))
    context.waitUntil(new Promise((resolve) => setTimeout(resolve, 20000)))
    const sql = postgres({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      ssl: false,
      max: 1,
      prepare: false,
      fetch_types: !name.includes('false'),
      connect_timeout: 2
    })
    let error
      , result
    try {
      if (name === 'cold-reserve-false') {
        const reserved = await sql.reserve()
        result = await reserved.unsafe('select 42 as marker', [], { simple: true })
        equal(result[0].marker, 42)
        reserved.release()
      } else if (name.startsWith('arrays-')) {
        result = await sql`select array[1,null]::int[] as ints, array['NULL',null]::text[] as texts,
          array[true,false]::boolean[] as bools, array['{"a":1}',null]::jsonb[] as jsons`
        if (result[0].ints[1] !== null) throw new Error('Numeric SQL NULL was not preserved')
        equal(result[0], { ints: [1, null], texts: ['NULL', null], bools: [true, false], jsons: [{ a: 1 }, null] })
      } else if (name === 'catalog-error') {
        try {
          await sql.reserve()
          throw new Error('Expected catalog rejection')
        } catch (e) {
          equal({ code: e.code, message: e.message }, { code: '42501', message: 'catalog denied' })
          result = { code: e.code, message: e.message }
        }
      } else { throw new Error('Unknown scenario ' + name) }
    } catch (e) {
      error = { message: e.message, code: e.code, stack: e.stack }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return Response.json({ name, passed: !error, result, error }, { status: error ? 500 : 200 })
  }
}

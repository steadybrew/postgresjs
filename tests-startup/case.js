import assert from 'assert'
import { frames, message, peer } from './peer.js'

const name = process.argv[2]
const finish = () => process.send({ completed: name })

async function main() {
  const { default: postgres } = await import(process.argv[3] === 'cjs' ? '../cjs/src/index.js' : '../src/index.js')
  if (name === 'watchdog-hang') {
    setInterval(() => { /* Keep this deliberately hung child alive. */ }, 1000)
    return
  }
  if (name === 'watchdog-unhandled') {
    Promise.reject(new Error('sentinel unhandled rejection'))
    return
  }
  if (name === 'watchdog-empty')
    return
  if (name === 'frames') {
    const observed = []
    const read = frames((type, frame) => observed.push([type, frame.toString('hex')]))
    const one = message('Q', Buffer.from('select 1\0'))
    const two = message('Z', Buffer.from('I'))
    const input = Buffer.concat([one, two])
    for (const byte of input)
      read(Buffer.from([byte]))
    assert.deepStrictEqual(observed, [['Q', one.toString('hex')], ['Z', two.toString('hex')]])
    const combined = []
    frames(type => combined.push(type))(input)
    assert.deepStrictEqual(combined, ['Q', 'Z'])
    assert.throws(() => frames(() => { /* Invalid lengths must fail before callback. */ })(Buffer.from([81, 0, 0, 0, 3])), /Invalid protocol/)
    finish()
    return
  }
  const server = await peer({ catalogError: name === 'catalog-error', onEvent: event => process.send({ event }) })
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture',
                         ssl: false, prepare: false, max: 1, fetch_types: name !== 'cold-reserve-no-fetch', connect_timeout: 1 })
  try {
    if (name === 'catalog-error') {
      await assert.rejects(sql.reserve(), error => error.code === '42501' && error.message === 'catalog denied')
      assert.strictEqual(server.events.filter(x => x.type === 'Q' && !x.sql.includes('pg_catalog.pg_type')).length, 0)
    } else {
      assert(['cold-query', 'cold-reserve', 'cold-reserve-no-fetch'].includes(name), 'Unknown scenario ' + name)
      const reserved = name === 'cold-query' ? sql : await sql.reserve()
      assert.strictEqual((await reserved.unsafe('select 42 as marker', [], { simple: true }))[0].marker, 42)
      reserved !== sql && reserved.release()
      assert.strictEqual((await sql.unsafe('select 42 as marker', [], { simple: true }))[0].marker, 42)
      assert.strictEqual(server.events.filter(x => x.type === 'P').length,
        name === 'cold-reserve-no-fetch' ? 0 : 1)
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
    process.send({ events: server.events })
  }
  finish()
}

main().catch(error => {
  console.error(error) // eslint-disable-line no-console
  process.exitCode = 1
})

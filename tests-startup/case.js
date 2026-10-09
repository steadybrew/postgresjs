import assert from 'assert'
import { frames, message, peer } from './peer.js'
import { startup, selection, lifecycle, phases } from './startup.js'
import { integration } from './integration.js'
import { ownership } from './ownership.js'
import { leases } from './lease.js'
import { compat } from './compat.js'
import { cf } from './cf.js'
import { install, verify, violations } from './invariants.js'

install()

const name = process.argv[2]
const finish = () => (verify(), process.send({ completed: name }))

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
  if (name.startsWith('startup:')) {
    const scenario = name.slice(8)
    const run = ['failover', 'session-select'].includes(scenario) ? selection
      : scenario === 'budget-reset' || scenario === 'end-backoff' || scenario.startsWith('graceful-') || scenario.startsWith('forced-')
          || scenario.startsWith('backoff-')
        ? lifecycle : startup
    await run(scenario, postgres, event => process.send({ event }))
    finish()
    return
  }
  if (name.startsWith('phase:')) {
    await phases(name.slice(6), postgres, event => process.send({ event }))
    finish()
    return
  }
  if (name === 'integration') {
    await integration(postgres)
    finish()
    return
  }
  if (name.startsWith('compat:')) {
    await compat(name.slice(7), postgres)
    finish()
    return
  }
  if (name.startsWith('cf:')) {
    await cf(name.slice(3))
    finish()
    return
  }
  if (name.startsWith('lease:')) {
    await leases(name.slice(6), postgres, event => process.send({ event }))
    finish()
    return
  }
  if (name.startsWith('ownership:')) {
    await ownership(name.slice(10), postgres, event => process.send({ event }))
    finish()
    return
  }
  const server = await peer({ catalogError: name === 'catalog-error', onEvent: event => process.send({ event }) })
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture',
                         ssl: false, prepare: false, max: 1, fetch_types: !name.includes('no-fetch'), connect_timeout: 1 })
  try {
    if (name === 'catalog-error') {
      await assert.rejects(sql.reserve(), error => error.code === '42501' && error.message === 'catalog denied')
      assert.strictEqual(server.events.filter(x => x.type === 'Q' && !x.sql.includes('pg_catalog.pg_type')).length, 0)
    } else {
      assert(['cold-query', 'cold-query-no-fetch', 'cold-reserve', 'cold-reserve-no-fetch'].includes(name), 'Unknown scenario ' + name)
      const reserved = name.startsWith('cold-query') ? sql : await sql.reserve()
      assert.strictEqual((await reserved.unsafe('select 42 as marker', [], { simple: true }))[0].marker, 42)
      reserved !== sql && reserved.release()
      assert.strictEqual((await sql.unsafe('select 42 as marker', [], { simple: true }))[0].marker, 42)
      assert.strictEqual(server.events.filter(x => x.type === 'P').length,
        name.includes('no-fetch') ? 0 : 1)
    }
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
    process.send({ events: server.events })
  }
  finish()
}

main().catch(error => {
  console.error(error, violations) // eslint-disable-line no-console
  process.exitCode = 1
})

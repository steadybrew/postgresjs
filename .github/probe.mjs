import postgres from '../src/index.js'
import { peer } from '../tests-startup/peer.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const noop = () => undefined
const options = { db: 'postgres_js_test', user: 'postgres_js_test', idle_timeout: 1, connect_timeout: 1, max: 1 }
const within = (promise, ms = 2000) => Promise.race([promise, delay(ms).then(() => 'hung')])
const name = process.argv[2]
const log = (...x) => console.log(name, ...x)

const inflight = async close => {
  const server = await peer({ holdQuery: 'hang' })
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: false, prepare: false, max: 1, fetch_types: false, connect_timeout: 2 })
  await sql.unsafe('select 42 as marker', [], { simple: true })
  const hung = within(sql.unsafe('select hang', [], { simple: true }).then(() => 'resolved', e => 'rejected:' + (e.code || e.message)), 3000)
  while (!server.events.some(x => x.sql === 'select hang'))
    await delay(5)
  close(server)
  log('query', await hung)
  log('end', await within(sql.end().then(() => 'resolved'), 3000))
}

const probes = {
  1097: () => inflight(server => server.disconnect()),
  1130: () => inflight(server => server.reset()),
  async 729() {
    const sql = postgres(options)
    await sql`select 2`
    const first = within(sql`select 1 as x`.then(x => 'ok:' + x[0].x, e => 'rejected:' + e.code))
    const second = within(sql`select ${ undefined } as x`.then(x => 'ok:' + x[0].x, e => 'rejected:' + e.code))
    log('first', await first, 'second', await second)
    log('end', await within(sql.end({ timeout: 1 }).then(() => 'resolved'), 3000))
  },
  async 1082() {
    const sql = postgres(options)
    log('begin', await within(sql.begin(sql => [sql`select 1`, sql`select ${ undefined }`]).then(() => 'resolved', e => e.code)))
    log('next', await within(sql`select 5 as x`.then(x => x[0].x, e => e.code)))
    log('end', await within(sql.end({ timeout: 1 }).then(() => 'resolved'), 3000))
  },
  async 1234() {
    const admin = postgres({ ...options, onnotice: noop })
    const sql = postgres(options)
    await admin`drop table if exists probe_1234`
    await admin`create table probe_1234 (id int primary key, a int)`
    await admin`insert into probe_1234 values (1, 1)`
    const [{ pid }] = await sql`select pg_backend_pid() as pid`
    await sql`select * from probe_1234 where id = ${ 1 }`
    await sql`select id from probe_1234 where id = ${ 1 } and a > ${ 0 }`
    await admin`alter table probe_1234 add column b int`
    log('begin', await within(sql.begin(sql => [
      sql`select * from probe_1234 where id = ${ 1 }`,
      sql`select id from probe_1234 where id = ${ 1 } and a > ${ 0 }`
    ]).then(() => 'resolved', e => e.code)))
    log('next', await within(sql`select 5 as x`.then(x => x[0].x, e => e.code)))
    log('server state', JSON.stringify(await admin`select state, query from pg_stat_activity where pid = ${ pid }`))
    await admin`select pg_terminate_backend(${ pid })`
    await admin`drop table probe_1234`
    await within(sql.end({ timeout: 1 }), 3000)
    await admin.end({ timeout: 1 })
  },
  async 1087() {
    const warnings = []
    process.on('warning', w => warnings.push(w.name))
    const sql = postgres({ database: 'postgres_js_test', publications: 'alltables', fetch_types: false })
    await sql.unsafe('drop publication if exists alltables')
    await sql.unsafe('create publication alltables for all tables')
    await sql`create table probe_1087 (id serial primary key, name text)`
    const stale = []
    const live = []
    console.error = noop
    for (let i = 0; i < 20; i++) {
      const sub = await within(sql.subscribe('insert:probe_1087', noop, noop, e => stale.push(e)), 5000)
      if (sub === 'hung') { log('subscribe', i, 'hung'); break }
      sub.unsubscribe()
    }
    log('after 20 subscribe/unsubscribe, warnings', JSON.stringify(warnings))
    const { state } = await within(sql.subscribe('insert:probe_1087', noop, noop, e => live.push(e)), 5000)
    await delay(100)
    const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
    await admin`select pg_terminate_backend(${ state.pid })`
    await delay(3000)
    log('stale onerror calls', stale.length, 'live onerror calls', live.length, 'warnings', JSON.stringify(warnings))
    await within(sql.end({ timeout: 1 }), 3000)
    await admin.unsafe('drop publication alltables').catch(noop)
    await admin`drop table probe_1087`
    await admin.end({ timeout: 1 })
  }
}

await probes[name]()
process.exit(0)

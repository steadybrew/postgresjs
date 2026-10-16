import { exec } from './bootstrap.js'

import { t, nt, ot } from './test.js' // eslint-disable-line
import net from 'net'
import fs from 'fs'
import crypto from 'crypto'

import postgres from '../src/index.js'
import { vercelPool } from '../src/vercel.js'
const delay = ms => new Promise(r => setTimeout(r, ms))

const rel = x => new URL(x, import.meta.url)
const idle_timeout = 1

const login = {
  user: 'postgres_js_test'
}

const login_md5 = {
  user: 'postgres_js_test_md5',
  pass: 'postgres_js_test_md5'
}

const login_scram = {
  user: 'postgres_js_test_scram',
  pass: 'postgres_js_test_scram'
}

const options = {
  db: 'postgres_js_test',
  user: login.user,
  pass: login.pass,
  idle_timeout,
  connect_timeout: 1,
  max: 1
}

const sql = postgres(options)

t('Connects with no options', async() => {
  const sql = postgres({ max: 1 })

  const result = (await sql`select 1 as x`)[0].x
  await sql.end()

  return [1, result]
})

t('Uses default database without slash', async() => {
  const sql = postgres('postgres://localhost')
  return [sql.options.user, sql.options.database]
})

t('Uses default database with slash', async() => {
  const sql = postgres('postgres://localhost/')
  return [sql.options.user, sql.options.database]
})

t('Result is array', async() =>
  [true, Array.isArray(await sql`select 1`)]
)

t('Result has count', async() =>
  [1, (await sql`select 1`).count]
)

t('Result has command', async() =>
  ['SELECT', (await sql`select 1`).command]
)

t('Create table', async() =>
  ['CREATE TABLE', (await sql`create table test(int int)`).command, await sql`drop table test`]
)

t('Drop table', { timeout: 2 }, async() => {
  await sql`create table test(int int)`
  return ['DROP TABLE', (await sql`drop table test`).command]
})

t('null', async() =>
  [null, (await sql`select ${ null } as x`)[0].x]
)

t('Integer', async() =>
  ['1', (await sql`select ${ 1 } as x`)[0].x]
)

t('String', async() =>
  ['hello', (await sql`select ${ 'hello' } as x`)[0].x]
)

t('Boolean false', async() =>
  [false, (await sql`select ${ false } as x`)[0].x]
)

t('Boolean true', async() =>
  [true, (await sql`select ${ true } as x`)[0].x]
)

t('Date', async() => {
  const now = new Date()
  return [0, now - (await sql`select ${ now } as x`)[0].x]
})

t('Json', async() => {
  const x = (await sql`select ${ sql.json({ a: 'hello', b: 42 }) } as x`)[0].x
  return ['hello,42', [x.a, x.b].join()]
})

t('implicit json', async() => {
  const x = (await sql`select ${ { a: 'hello', b: 42 } }::json as x`)[0].x
  return ['hello,42', [x.a, x.b].join()]
})

t('implicit jsonb', async() => {
  const x = (await sql`select ${ { a: 'hello', b: 42 } }::jsonb as x`)[0].x
  return ['hello,42', [x.a, x.b].join()]
})

const builtInArrays = [[16, 1000], [17, 1001], [18, 1002], [19, 1003], [20, 1016], [21, 1005], [23, 1007], [25, 1009],
                       [26, 1028], [114, 199], [700, 1021], [701, 1022], [1042, 1014], [1043, 1015], [1082, 1182],
                       [1083, 1183], [1114, 1115], [1184, 1185], [1186, 1187], [1700, 1231], [2950, 2951], [3802, 3807]]

for (const fetch_types of [false, true]) {
  t('Built-in array mappings match PostgreSQL with fetch_types=' + fetch_types, async() => {
    const client = postgres({ ...options, fetch_types })
    try {
      const catalog = await client`select oid, typarray from pg_catalog.pg_type where oid = any(${ client.array(builtInArrays.map(x => x[0]), 26) })`
      return [JSON.stringify(builtInArrays), JSON.stringify(builtInArrays.map(([oid]) => {
        const row = catalog.find(x => x.oid === oid)
        if (!row || row.typarray !== client.options.shared.typeArrayMap.get(oid))
          throw new Error('Missing or incorrect built-in array mapping for ' + oid)
        return [oid, row.typarray]
      }))]
    } finally { await client.end() }
  })

  t('Built-in array roundtrips with fetch_types=' + fetch_types, async() => {
    const client = postgres({ ...options, fetch_types })
    const text = [['quote"', 'slash\\'], ['NULL', null]]
    const date = new Date('2020-01-02T03:04:05.000Z')
    const uuid = '00000000-0000-0000-0000-000000000001'
    try {
      const [row] = await client`select ${ client.array(text, 25) } as texts, ${ client.array([], 25) } as empty,
        ${ client.array([1, 2, 3], 23) } as ints, ${ client.array([true, false], 16) } as bools,
        ${ client.array([{ a: 1 }, null], 3802) } as jsons, ${ client.array([date], 1184) } as dates,
        ${ client.array([uuid], 2950) } as uuids, ${ client.array([Buffer.from([0, 255])], 17) } as bytes`
      return [JSON.stringify({ text, empty: [], ints: [1, 2, 3], bools: [true, false], jsons: [{ a: 1 }, null],
                               dates: [date.toISOString()], uuids: [uuid], bytes: [0, 255] }),
              JSON.stringify({ text: row.texts, empty: row.empty, ints: row.ints, bools: row.bools, jsons: row.jsons,
                               dates: row.dates.map(x => x.toISOString()), uuids: row.uuids, bytes: Array.from(row.bytes[0]) })]
    } finally { await client.end() }
  })

  t('Array SQL null values with fetch_types=' + fetch_types, async() => {
    const client = postgres({ ...options, fetch_types })
    try {
      const [row] = await client`select array[null, 'a', null, 'NULL', null]::text[] as texts,
        array[null, 1, null, 3, null]::int[] as ints, array[null, true, null, false, null]::bool[] as bools,
        array[null, '{"a":1}', null, '{"b":2}', null]::jsonb[] as jsons, array[null]::text[] as only,
        array[array[null, 1], array[2, null]]::int[] as nested`
      for (const key of ['texts', 'ints', 'bools', 'jsons']) {
        if ([0, 2, 4].some(index => row[key][index] !== null))
          throw new Error('SQL NULL was not preserved in ' + key)
      }
      return [JSON.stringify({ texts: [null, 'a', null, 'NULL', null], ints: [null, 1, null, 3, null],
                               bools: [null, true, null, false, null], jsons: [null, { a: 1 }, null, { b: 2 }, null],
                               only: [null], nested: [[null, 1], [2, null]] }), JSON.stringify(row)]
    } finally { await client.end() }
  })

  t('Array transforms with fetch_types=' + fetch_types, async() => {
    const transform = { undefined: null,
                        column: { from(x) {
                          if (this !== client.options.transform.column) throw new Error('Column transform receiver changed')
                          return x.toUpperCase()
                        } },
                        value: { from(x) {
                          if (this !== client.options.transform.value) throw new Error('Value transform receiver changed')
                          return Array.isArray(x) ? x.concat('transformed') : typeof x === 'number' ? x + 1 : x
                        } },
                        row: { from(x) {
                          if (this !== client.options.transform.row) throw new Error('Row transform receiver changed')
                          return { value: x.VALUES }
                        } }
    }
    const client = postgres({ ...options, fetch_types, transform })
    try {
      const [row] = await client`select ${ client.array(['a', undefined], 25) } as values`
      return [JSON.stringify(['a', null, 'transformed']), JSON.stringify(row.value)]
    } finally { await client.end() }
  })

  for (const mode of ['parse', 'serialize', 'both']) {
    t('Explicit array ' + mode + ' handler with fetch_types=' + fetch_types, async() => {
      const parse = x => 'parsed:' + x
      const serialize = () => '{override}'
      const client = postgres({ ...options, fetch_types, types: { custom: {
        ...(mode !== 'serialize' ? { from: 1009, parse } : {}),
        ...(mode !== 'parse' ? { to: 1009, serialize } : {})
      } } })
      try {
        const [row] = await client`select ${ client.array(['a', 'b'], 25) } as value`
        if (client.options.shared.typeArrayMap.get(25) !== 1009
            || (mode !== 'serialize' && (client.options.parsers[1009] !== parse || parse.array))
            || (mode !== 'parse' && client.options.serializers[1009] !== serialize))
          throw new Error('Explicit handlers or element-to-array map were overwritten')
        return [JSON.stringify(mode === 'parse' ? 'parsed:{a,b}' : mode === 'both' ? 'parsed:{override}' : ['override']),
                JSON.stringify(row.value)]
      } finally { await client.end() }
    })
  }
}

t('User-defined arrays require discovery or explicit handlers', async() => {
  await sql`create type startup_array_enum as enum ('a', 'b')`
  const clients = []
  try {
    const [{ oid, typarray }] = await sql`select oid, typarray from pg_catalog.pg_type where typname = 'startup_array_enum'`
    const disabled = postgres({ ...options, fetch_types: false })
    const enabled = postgres({ ...options })
    const explicit = postgres({ ...options, fetch_types: false, types: { enumArray: {
      to: typarray, from: typarray, serialize: xs => '{' + xs.join(',') + '}', parse: x => x.slice(1, -1).split(',')
    } } })
    clients.push(disabled, enabled, explicit)
    const raw = (await disabled`select array['a','b']::startup_array_enum[] as value`)[0].value
    const parsed = (await enabled`select ${ enabled.array(['a', 'b'], oid) } as value`)[0].value
    const supplied = (await explicit`select ${ explicit.typed(['a', 'b'], typarray) } as value`)[0].value
    return [JSON.stringify(['{a,b}', ['a', 'b'], ['a', 'b'], undefined]),
            JSON.stringify([raw, parsed, supplied, disabled.options.shared.typeArrayMap.get(oid)])]
  } finally {
    await Promise.all(clients.map(client => client.end()))
    await sql`drop type startup_array_enum`
  }
})

t('Empty array', async() =>
  [true, Array.isArray((await sql`select ${ sql.array([], 1009) } as x`)[0].x)]
)

t('String array', async() =>
  ['123', (await sql`select ${ '{1,2,3}' }::int[] as x`)[0].x.join('')]
)

t('Array of Integer', async() =>
  ['3', (await sql`select ${ sql.array([1, 2, 3]) } as x`)[0].x[2]]
)

t('Array of String', async() =>
  ['c', (await sql`select ${ sql.array(['a', 'b', 'c']) } as x`)[0].x[2]]
)

t('Array of Date', async() => {
  const now = new Date()
  return [now.getTime(), (await sql`select ${ sql.array([now, now, now]) } as x`)[0].x[2].getTime()]
})

t('Array of Box', async() => [
  '(3,4),(1,2);(6,7),(4,5)',
  (await sql`select ${ '{(1,2),(3,4);(4,5),(6,7)}' }::box[] as x`)[0].x.join(';')
])

t('Nested array n2', async() =>
  ['4', (await sql`select ${ sql.array([[1, 2], [3, 4]]) } as x`)[0].x[1][1]]
)

t('Nested array n3', async() =>
  ['6', (await sql`select ${ sql.array([[[1, 2]], [[3, 4]], [[5, 6]]]) } as x`)[0].x[2][0][1]]
)

t('Escape in arrays', async() =>
  ['Hello "you",c:\\windows', (await sql`select ${ sql.array(['Hello "you"', 'c:\\windows']) } as x`)[0].x.join(',')]
)

t('Escapes', async() => {
  return ['hej"hej', Object.keys((await sql`select 1 as ${ sql('hej"hej') }`)[0])[0]]
})

t('null for int', async() => {
  await sql`create table test (x int)`
  return [1, (await sql`insert into test values(${ null })`).count, await sql`drop table test`]
})

t('Throws on illegal transactions', async() => {
  const sql = postgres({ ...options, max: 2, fetch_types: false })
  const error = await sql`begin`.catch(e => e)
  return [
    error.code,
    'UNSAFE_TRANSACTION'
  ]
})

t('Transaction throws', async() => {
  await sql`create table test (a int)`
  return ['22P02', await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql`insert into test values('hej')`
  }).catch(x => x.code), await sql`drop table test`]
})

t('Transaction rolls back', async() => {
  await sql`create table test (a int)`
  await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql`insert into test values('hej')`
  }).catch(() => { /* ignore */ })
  return [0, (await sql`select a from test`).count, await sql`drop table test`]
})

t('Transaction throws on uncaught savepoint', async() => {
  await sql`create table test (a int)`

  return ['fail', (await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql.savepoint(async sql => {
      await sql`insert into test values(2)`
      throw new Error('fail')
    })
  }).catch((err) => err.message)), await sql`drop table test`]
})

t('Transaction throws on uncaught named savepoint', async() => {
  await sql`create table test (a int)`

  return ['fail', (await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql.savepoit('watpoint', async sql => {
      await sql`insert into test values(2)`
      throw new Error('fail')
    })
  }).catch(() => 'fail')), await sql`drop table test`]
})

t('Transaction succeeds on caught savepoint', async() => {
  await sql`create table test (a int)`
  await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql.savepoint(async sql => {
      await sql`insert into test values(2)`
      throw new Error('please rollback')
    }).catch(() => { /* ignore */ })
    await sql`insert into test values(3)`
  })

  return ['2', (await sql`select count(1) from test`)[0].count, await sql`drop table test`]
})

t('Savepoint returns Result', async() => {
  let result
  await sql.begin(async sql => {
    result = await sql.savepoint(sql =>
      sql`select 1 as x`
    )
  })

  return [1, result[0].x]
})

t('Prepared transaction', async() => {
  await sql`create table test (a int)`

  await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql.prepare('tx1')
  })

  await sql`commit prepared 'tx1'`

  return ['1', (await sql`select count(1) from test`)[0].count, await sql`drop table test`]
})

t('Transaction requests are executed implicitly', async() => {
  const sql = postgres({ debug: true, idle_timeout: 1, fetch_types: false })
  return [
    'testing',
    (await sql.begin(sql => [
      sql`select set_config('postgres_js.test', 'testing', true)`,
      sql`select current_setting('postgres_js.test') as x`
    ]))[1][0].x
  ]
})

t('Uncaught transaction request errors bubbles to transaction', async() => [
  '42703',
  (await sql.begin(sql => [
    sql`select wat`,
    sql`select current_setting('postgres_js.test') as x, ${ 1 } as a`
  ]).catch(e => e.code))
])

t('Fragments in transactions', async() => [
  true,
  (await sql.begin(sql => sql`select true as x where ${ sql`1=1` }`))[0].x
])

t('Transaction rejects with rethrown error', async() => [
  'WAT',
  await sql.begin(async sql => {
    try {
      await sql`select exception`
    } catch (ex) {
      throw new Error('WAT')
    }
  }).catch(e => e.message)
])

t('Parallel transactions', async() => {
  await sql`create table test (a int)`
  return ['11', (await Promise.all([
    sql.begin(sql => sql`select 1`),
    sql.begin(sql => sql`select 1`)
  ])).map(x => x.count).join(''), await sql`drop table test`]
})

t('Many transactions at beginning of connection', async() => {
  const sql = postgres(options)
  const xs = await Promise.all(Array.from({ length: 100 }, () => sql.begin(sql => sql`select 1`)))
  return [100, xs.length]
})

t('Transactions array', async() => {
  await sql`create table test (a int)`

  return ['11', (await sql.begin(sql => [
    sql`select 1`.then(x => x),
    sql`select 1`
  ])).map(x => x.count).join(''), await sql`drop table test`]
})

t('Transaction waits', async() => {
  await sql`create table test (a int)`
  await sql.begin(async sql => {
    await sql`insert into test values(1)`
    await sql.savepoint(async sql => {
      await sql`insert into test values(2)`
      throw new Error('please rollback')
    }).catch(() => { /* ignore */ })
    await sql`insert into test values(3)`
  })

  return ['11', (await Promise.all([
    sql.begin(sql => sql`select 1`),
    sql.begin(sql => sql`select 1`)
  ])).map(x => x.count).join(''), await sql`drop table test`]
})

t('Helpers in Transaction', async() => {
  return ['1', (await sql.begin(async sql =>
    await sql`select ${ sql({ x: 1 }) }`
  ))[0].x]
})

t('Undefined values throws', async() => {
  let error

  await sql`
    select ${ undefined } as x
  `.catch(x => error = x.code)

  return ['UNDEFINED_VALUE', error]
})

t('Transform undefined', async() => {
  const sql = postgres({ ...options, transform: { undefined: null } })
  return [null, (await sql`select ${ undefined } as x`)[0].x]
})

t('Transform undefined in array', async() => {
  const sql = postgres({ ...options, transform: { undefined: null } })
  return [null, (await sql`select * from (values ${ sql([undefined, undefined]) }) as x(x, y)`)[0].y]
})

t('Null sets to null', async() =>
  [null, (await sql`select ${ null } as x`)[0].x]
)

t('Throw syntax error', async() =>
  ['42601', (await sql`wat 1`.catch(x => x)).code]
)

t('Connect using uri', async() =>
  [true, await new Promise((resolve, reject) => {
    const sql = postgres('postgres://' + login.user + ':' + (login.pass || '') + '@localhost:5432/' + options.db, {
      idle_timeout
    })
    sql`select 1`.then(() => resolve(true), reject)
  })]
)

t('Options from uri with special characters in user and pass', async() => {
  const opt = postgres({ user: 'öla', pass: 'pass^word' }).options
  return [[opt.user, opt.pass].toString(), 'öla,pass^word']
})

t('Fail with proper error on no host', async() =>
  ['ECONNREFUSED', (await new Promise((resolve, reject) => {
    const sql = postgres('postgres://localhost:33333/' + options.db, {
      idle_timeout
    })
    sql`select 1`.then(reject, resolve)
  })).code]
)

t('Connect using SSL', async() =>
  [true, (await new Promise((resolve, reject) => {
    postgres({
      ssl: { rejectUnauthorized: false },
      idle_timeout
    })`select 1`.then(() => resolve(true), reject)
  }))]
)

t('Connect using SSL require', async() =>
  [true, (await new Promise((resolve, reject) => {
    postgres({
      ssl: 'require',
      idle_timeout
    })`select 1`.then(() => resolve(true), reject)
  }))]
)

t('Connect using SSL direct', async() => {
  const [{ supported }] = await sql`select current_setting('server_version_num')::int >= 180000 as supported`
  return [true, !supported || (await new Promise((resolve, reject) => {
    postgres({
      ssl: 'require',
      sslnegotiation: 'direct',
      idle_timeout
    })`select 1`.then(() => resolve(true), reject)
  }))]
})

t('Connect using SSL prefer', async() => {
  await exec('psql', ['-c', 'alter system set ssl=off'])
  await exec('psql', ['-c', 'select pg_reload_conf()'])

  const sql = postgres({
    ssl: 'prefer',
    idle_timeout
  })

  return [
    1, (await sql`select 1 as x`)[0].x,
    await exec('psql', ['-c', 'alter system set ssl=on']),
    await exec('psql', ['-c', 'select pg_reload_conf()'])
  ]
})

t('Reconnect using SSL', { timeout: 2 }, async() => {
  const sql = postgres({
    ssl: 'require',
    idle_timeout: 0.1
  })

  await sql`select 1`
  await delay(200)

  return [1, (await sql`select 1 as x`)[0].x]
})

t('Proper handling of non object Errors', async() => {
  const sql = postgres({ socket: () => { throw 'wat' } }) // eslint-disable-line

  return [
    'wat', await sql`select 1 as x`.catch(e => e.message)
  ]
})

t('Proper handling of null Errors', async() => {
  const sql = postgres({ socket: () => { throw null } }) // eslint-disable-line

  return [
    'null', await sql`select 1 as x`.catch(e => e.message)
  ]
})

t('Ensure reserve on connection throws proper error', async() => {
  const sql = postgres({ socket: () => { throw 'wat' }, idle_timeout }) // eslint-disable-line

  return [
    'wat', await sql.reserve().catch(e => e)
  ]
})

t('Login without password', async() => {
  return [true, (await postgres({ ...options, ...login })`select true as x`)[0].x]
})

t('Login using MD5', async() => {
  return [true, (await postgres({ ...options, ...login_md5 })`select true as x`)[0].x]
})

t('Login using scram-sha-256', async() => {
  return [true, (await postgres({ ...options, ...login_scram })`select true as x`)[0].x]
})

t('Parallel connections using scram-sha-256', {
  timeout: 2
}, async() => {
  const sql = postgres({ ...options, ...login_scram })
  return [true, (await Promise.all([
    sql`select true as x, pg_sleep(0.01)`,
    sql`select true as x, pg_sleep(0.01)`,
    sql`select true as x, pg_sleep(0.01)`
  ]))[0][0].x]
})

t('Support dynamic password function', async() => {
  return [true, (await postgres({
    ...options,
    ...login_scram,
    pass: () => 'postgres_js_test_scram'
  })`select true as x`)[0].x]
})

t('Support dynamic async password function', async() => {
  return [true, (await postgres({
    ...options,
    ...login_scram,
    pass: () => Promise.resolve('postgres_js_test_scram')
  })`select true as x`)[0].x]
})

t('Point type', async() => {
  const sql = postgres({
    ...options,
    types: {
      point: {
        to: 600,
        from: [600],
        serialize: ([x, y]) => '(' + x + ',' + y + ')',
        parse: (x) => x.slice(1, -1).split(',').map(x => +x)
      }
    }
  })

  await sql`create table test (x point)`
  await sql`insert into test (x) values (${ sql.types.point([10, 20]) })`
  return [20, (await sql`select x from test`)[0].x[1], await sql`drop table test`]
})

t('Point type array', async() => {
  const sql = postgres({
    ...options,
    types: {
      point: {
        to: 600,
        from: [600],
        serialize: ([x, y]) => '(' + x + ',' + y + ')',
        parse: (x) => x.slice(1, -1).split(',').map(x => +x)
      }
    }
  })

  await sql`create table test (x point[])`
  await sql`insert into test (x) values (${ sql.array([sql.types.point([10, 20]), sql.types.point([20, 30])]) })`
  return [30, (await sql`select x from test`)[0].x[1][1], await sql`drop table test`]
})

t('sql file', async() =>
  [1, (await sql.file(rel('select.sql')))[0].x]
)

t('sql file has forEach', async() => {
  let result
  await sql
    .file(rel('select.sql'), { cache: false })
    .forEach(({ x }) => result = x)

  return [1, result]
})

t('sql file throws', async() =>
  ['ENOENT', (await sql.file(rel('selectomondo.sql')).catch(x => x.code))]
)

t('sql file cached', async() => {
  await sql.file(rel('select.sql'))
  await delay(20)

  return [1, (await sql.file(rel('select.sql')))[0].x]
})

t('Parameters in file', async() => {
  const result = await sql.file(
    rel('select-param.sql'),
    ['hello']
  )
  return ['hello', result[0].x]
})

t('Connection ended promise', async() => {
  const sql = postgres(options)

  await sql.end()

  return [undefined, await sql.end()]
})

t('Connection ended timeout', async() => {
  const sql = postgres(options)

  await sql.end({ timeout: 10 })

  return [undefined, await sql.end()]
})

t('Connection ended error', async() => {
  const sql = postgres(options)
  await sql.end()
  return ['CONNECTION_ENDED', (await sql``.catch(x => x.code))]
})

t('Connection end does not cancel query', async() => {
  const sql = postgres(options)

  const promise = sql`select 1 as x`.execute()

  await sql.end()

  return [1, (await promise)[0].x]
})

t('Connection destroyed', async() => {
  const sql = postgres(options)
  process.nextTick(() => sql.end({ timeout: 0 }))
  return ['CONNECTION_DESTROYED', await sql``.catch(x => x.code)]
})

t('Connection destroyed with query before', async() => {
  const sql = postgres(options)
      , error = sql`select pg_sleep(0.2)`.catch(err => err.code)

  sql.end({ timeout: 0 })
  return ['CONNECTION_DESTROYED', await error]
})

t('transform column', async() => {
  const sql = postgres({
    ...options,
    transform: { column: x => x.split('').reverse().join('') }
  })

  await sql`create table test (hello_world int)`
  await sql`insert into test values (1)`
  return ['dlrow_olleh', Object.keys((await sql`select * from test`)[0])[0], await sql`drop table test`]
})

t('column toPascal', async() => {
  const sql = postgres({
    ...options,
    transform: { column: postgres.toPascal }
  })

  await sql`create table test (hello_world int)`
  await sql`insert into test values (1)`
  return ['HelloWorld', Object.keys((await sql`select * from test`)[0])[0], await sql`drop table test`]
})

t('column toCamel', async() => {
  const sql = postgres({
    ...options,
    transform: { column: postgres.toCamel }
  })

  await sql`create table test (hello_world int)`
  await sql`insert into test values (1)`
  return ['helloWorld', Object.keys((await sql`select * from test`)[0])[0], await sql`drop table test`]
})

t('toCamel and toPascal keep a trailing underscore', async() => [
  'foo_,fooBar_,foo_,_foo,foo_bar,Foo_,FooBar_,Foo_,_foo,Foo_bar',
  [
    postgres.toCamel('foo_'), postgres.toCamel('foo_bar_'), postgres.toCamel('foo__'),
    postgres.toCamel('_foo'), postgres.toCamel('foo__bar'),
    postgres.toPascal('foo_'), postgres.toPascal('foo_bar_'), postgres.toPascal('foo__'),
    postgres.toPascal('_foo'), postgres.toPascal('foo__bar')
  ].join()
])

t('column toKebab', async() => {
  const sql = postgres({
    ...options,
    transform: { column: postgres.toKebab }
  })

  await sql`create table test (hello_world int)`
  await sql`insert into test values (1)`
  return ['hello-world', Object.keys((await sql`select * from test`)[0])[0], await sql`drop table test`]
})

t('Transform nested json in arrays', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.camel
  })
  return ['aBcD', (await sql`select '[{"a_b":1},{"c_d":2}]'::jsonb as x`)[0].x.map(Object.keys).join('')]
})

t('Transform deeply nested json object in arrays', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.camel
  })
  return [
    'childObj_deeplyNestedObj_grandchildObj',
    (await sql`
      select '[{"nested_obj": {"child_obj": 2, "deeply_nested_obj": {"grandchild_obj": 3}}}]'::jsonb as x
    `)[0].x.map(x => {
      let result
      for (const key in x)
        result = [...Object.keys(x[key]), ...Object.keys(x[key].deeplyNestedObj)]
      return result
    })[0]
    .join('_')
  ]
})

t('Transform deeply nested json array in arrays', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.camel
  })
  return [
    'childArray_deeplyNestedArray_grandchildArray',
    (await sql`
      select '[{"nested_array": [{"child_array": 2, "deeply_nested_array": [{"grandchild_array":3}]}]}]'::jsonb AS x
    `)[0].x.map((x) => {
      let result
      for (const key in x)
        result = [...Object.keys(x[key][0]), ...Object.keys(x[key][0].deeplyNestedArray[0])]
      return result
    })[0]
    .join('_')
  ]
})

t('Bypass transform for json primitive', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.camel
  })

  const x = (
    await sql`select 'null'::json as a, 'false'::json as b, '"a"'::json as c, '1'::json as d`
  )[0]

  return [
    JSON.stringify({ a: null, b: false, c: 'a', d: 1 }),
    JSON.stringify(x)
  ]
})

t('Bypass transform for jsonb primitive', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.camel
  })

  const x = (
    await sql`select 'null'::jsonb as a, 'false'::jsonb as b, '"a"'::jsonb as c, '1'::jsonb as d`
  )[0]

  return [
    JSON.stringify({ a: null, b: false, c: 'a', d: 1 }),
    JSON.stringify(x)
  ]
})

t('unsafe', async() => {
  await sql`create table test (x int)`
  return [1, (await sql.unsafe('insert into test values ($1) returning *', [1]))[0].x, await sql`drop table test`]
})

t('unsafe simple', async() => {
  return [1, (await sql.unsafe('select 1 as x'))[0].x]
})

t('unsafe simple includes columns', async() => {
  return ['x', (await sql.unsafe('select 1 as x').values()).columns[0].name]
})

t('unsafe describe', async() => {
  const q = 'insert into test values (1)'
  await sql`create table test(a int unique)`
  await sql.unsafe(q).describe()
  const x = await sql.unsafe(q).describe()
  return [
    q,
    x.string,
    await sql`drop table test`
  ]
})

t('simple query using unsafe with multiple statements', async() => {
  return [
    '1,2',
    (await sql.unsafe('select 1 as x;select 2 as x')).map(x => x[0].x).join()
  ]
})

t('simple query using simple() with multiple statements', async() => {
  return [
    '1,2',
    (await sql`select 1 as x;select 2 as x`.simple()).map(x => x[0].x).join()
  ]
})

t('listen and notify', async() => {
  const sql = postgres(options)
  const channel = 'hello'
  const result = await new Promise(async r => {
    await sql.listen(channel, r)
    sql.notify(channel, 'works')
  })

  return [
    'works',
    result,
    sql.end()
  ]
})

t('double listen', async() => {
  const sql = postgres(options)
      , channel = 'hello'

  let count = 0

  await new Promise((resolve, reject) =>
    sql.listen(channel, resolve)
    .then(() => sql.notify(channel, 'world'))
    .catch(reject)
  ).then(() => count++)

  await new Promise((resolve, reject) =>
    sql.listen(channel, resolve)
    .then(() => sql.notify(channel, 'world'))
    .catch(reject)
  ).then(() => count++)

  // for coverage
  sql.listen('weee', () => { /* noop */ }).then(sql.end)

  return [2, count]
})

t('multiple listeners work after a reconnect', async() => {
  const sql = postgres(options)
      , xs = []

  const s1 = await sql.listen('test', x => xs.push('1', x))
  await sql.listen('test', x => xs.push('2', x))
  await sql.notify('test', 'a')
  await delay(50)
  await sql`select pg_terminate_backend(${ s1.state.pid })`
  await delay(200)
  await sql.notify('test', 'b')
  await delay(50)
  sql.end()

  return ['1a2a1b2b', xs.join('')]
})

t('listen and notify with weird name', async() => {
  const sql = postgres(options)
  const channel = 'wat-;.ø.§'
  const result = await new Promise(async r => {
    const { unlisten } = await sql.listen(channel, r)
    sql.notify(channel, 'works')
    await delay(50)
    await unlisten()
  })

  return [
    'works',
    result,
    sql.end()
  ]
})

t('listen and notify with upper case', async() => {
  const sql = postgres(options)
  const channel = 'withUpperChar'
  const result = await new Promise(async r => {
    await sql.listen(channel, r)
    sql.notify(channel, 'works')
  })

  return [
    'works',
    result,
    sql.end()
  ]
})

t('listen reconnects', { timeout: 2 }, async() => {
  const sql = postgres(options)
      , resolvers = {}
      , a = new Promise(r => resolvers.a = r)
      , b = new Promise(r => resolvers.b = r)

  let connects = 0

  const { state: { pid } } = await sql.listen(
    'test',
    x => x in resolvers && resolvers[x](),
    () => connects++
  )
  await sql.notify('test', 'a')
  await a
  await sql`select pg_terminate_backend(${ pid })`
  await delay(100)
  await sql.notify('test', 'b')
  await b
  sql.end()
  return [connects, 2]
})

t('listen result reports correct connection state after reconnection', async() => {
  const sql = postgres(options)
      , xs = []

  const result = await sql.listen('test', x => xs.push(x))
  const initialPid = result.state.pid
  await sql.notify('test', 'a')
  await sql`select pg_terminate_backend(${ initialPid })`
  await delay(50)
  sql.end()

  return [result.state.pid !== initialPid, true]
})

t('unlisten removes subscription', async() => {
  const sql = postgres(options)
      , xs = []

  const { unlisten } = await sql.listen('test', x => xs.push(x))
  await sql.notify('test', 'a')
  await delay(50)
  await unlisten()
  await sql.notify('test', 'b')
  await delay(50)
  sql.end()

  return ['a', xs.join('')]
})

t('listen after unlisten', async() => {
  const sql = postgres(options)
      , xs = []

  const { unlisten } = await sql.listen('test', x => xs.push(x))
  await sql.notify('test', 'a')
  await delay(50)
  await unlisten()
  await sql.notify('test', 'b')
  await delay(50)
  await sql.listen('test', x => xs.push(x))
  await sql.notify('test', 'c')
  await delay(50)
  sql.end()

  return ['ac', xs.join('')]
})

t('multiple listeners and unlisten one', async() => {
  const sql = postgres(options)
      , xs = []

  await sql.listen('test', x => xs.push('1', x))
  const s2 = await sql.listen('test', x => xs.push('2', x))
  await sql.notify('test', 'a')
  await delay(50)
  await s2.unlisten()
  await sql.notify('test', 'b')
  await delay(50)
  sql.end()

  return ['1a2a1b', xs.join('')]
})

t('responds with server parameters (application_name)', async() =>
  ['postgres.js', await new Promise((resolve, reject) => postgres({
    ...options,
    onparameter: (k, v) => k === 'application_name' && resolve(v)
  })`select 1`.catch(reject))]
)

t('has server parameters', async() => {
  return ['postgres.js', (await sql`select 1`.then(() => sql.parameters.application_name))]
})

t('onidle fires once for each connection that goes idle', async() => {
  const ids = []
  const sql = postgres({ ...options, max: 2, onidle: id => ids.push(id) })
  await Promise.all([sql`select pg_sleep(0.05)`, sql`select pg_sleep(0.05)`])
  await sql.end()
  return ['2 2', ids.length + ' ' + new Set(ids).size]
})

t('onidle fires once after queued queries drain', async() => {
  let count = 0
  const sql = postgres({ ...options, max: 1, onidle: () => count++ })
  await Promise.all([sql`select pg_sleep(0.05)`, sql`select 1`])
  await sql.end()
  return [1, count]
})

t('onidle fires when a reserved connection is released', async() => {
  let count = 0
  const sql = postgres({ ...options, max: 1, onidle: () => count++ })
  const reserved = await sql.reserve()
  await reserved`select 1`
  const before = count
  reserved.release()
  await sql.end()
  return ['0 1', before + ' ' + count]
})

t('onidle fires when a transaction completes', async() => {
  let count = 0
  const sql = postgres({ ...options, max: 1, onidle: () => count++ })
  await sql.begin(sql => sql`select 1`)
  await sql.end()
  return [1, count]
})

t('onidle can be set after creation', async() => {
  let count = 0
  const sql = postgres({ ...options, max: 1 })
  sql.options.onidle = () => count++
  await sql`select 1`
  await sql.end()
  return [1, count]
})

t('onidle is not called for the listen connection', async() => {
  let count = 0
  const sql = postgres({ ...options, onidle: () => count++ })
  const { unlisten } = await sql.listen('onidle_listen', () => undefined)
  await unlisten()
  await sql.end()
  return [0, count]
})

t('vercelPool has the pool shape attachDatabasePool detects', async() => {
  const sql = postgres({ ...options, idle_timeout: 5 })
  const pool = vercelPool(sql)
  await sql.end()
  return ['true 5000', ('on' in pool && 'idleTimeoutMillis' in pool.options) + ' ' + pool.options.idleTimeoutMillis]
})

t('vercelPool release listener runs before an existing onidle', async() => {
  const seen = []
  const sql = postgres({ ...options, onidle: () => seen.push('own') })
  vercelPool(sql).on('release', () => seen.push('release'))
  await sql`select 1`
  await sql.end()
  return ['release,own', seen.join()]
})

t('vercelPool requires idle_timeout', async() => {
  const sql = postgres({ ...options, idle_timeout: null })
  let error
  try {
    vercelPool(sql)
  } catch (e) {
    error = e
  }
  await sql.end()
  return [true, error instanceof Error]
})

const want = (max, x) => ({
  max,
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
  activeCount: 0,
  availableCount: max,
  busyCount: 0,
  reservedCount: 0,
  connectingCount: 0,
  closingCount: 0,
  executingCount: 0,
  listenCount: 0,
  subscribeCount: 0,
  ...x
})

t('stats of a fresh pool', async() => {
  const sql = postgres({ ...options, max: 3 })
  const seen = sql.stats()
  await sql.end()
  return [JSON.stringify(want(3)), JSON.stringify(seen)]
})

t('stats count a connecting connection and then an idle one', async() => {
  const sql = postgres({ ...options, max: 3 })
  const query = sql`select 1`.execute()
  await 1
  const connecting = sql.stats()
  await query
  const idle = sql.stats()
  await sql.end()
  return [
    JSON.stringify([
      want(3, { totalCount: 1, connectingCount: 1, waitingCount: 1, availableCount: 2 }),
      want(3, { totalCount: 1, idleCount: 1, availableCount: 3 })
    ]),
    JSON.stringify([connecting, idle])
  ]
})

t('stats count a running query and a query waiting in the pool queue', async() => {
  const sql = postgres({ ...options, max: 1, max_pipeline: 0 })
  await sql`select 1`
  const running = sql`select pg_sleep(0.1)`.execute()
  const waiting = sql`select 1`.execute()
  await 1
  const seen = sql.stats()
  await Promise.all([running, waiting])
  const after = sql.stats()
  await sql.end()
  return [
    JSON.stringify([
      want(1, { totalCount: 1, busyCount: 1, activeCount: 1, waitingCount: 1, executingCount: 1, availableCount: 0 }),
      want(1, { totalCount: 1, idleCount: 1, availableCount: 1 })
    ]),
    JSON.stringify([seen, after])
  ]
})

t('stats count pipelined queries as waiting', async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`select 1`
  const queries = [1, 2, 3, 4, 5].map(() => sql`select 1`.execute())
  await 1
  const seen = sql.stats()
  await Promise.all(queries)
  const after = sql.stats()
  await sql.end()
  return [
    JSON.stringify([
      want(1, { totalCount: 1, busyCount: 1, activeCount: 1, executingCount: 1, waitingCount: 4, availableCount: 0 }),
      want(1, { totalCount: 1, idleCount: 1, availableCount: 1 })
    ]),
    JSON.stringify([seen, after])
  ]
})

t('stats count a saturated pool as having waiting queries and no available connections', async() => {
  const sql = postgres({ ...options, max: 2 })
  await Promise.all([sql`select 1`, sql`select 1`])
  const queries = [1, 2, 3, 4, 5, 6].map(() => sql`select pg_sleep(0.1)`.execute())
  await 1
  const seen = sql.stats()
  await Promise.all(queries)
  const after = sql.stats()
  await sql.end()
  return [
    JSON.stringify([
      want(2, { totalCount: 2, busyCount: 2, activeCount: 2, executingCount: 2, waitingCount: 4, availableCount: 0 }),
      want(2, { totalCount: 2, idleCount: 2, availableCount: 2 })
    ]),
    JSON.stringify([seen, after])
  ]
})

t('stats count every call issued on a cold pool as waiting', async() => {
  const sql = postgres({ ...options, max: 2 })
  const queries = [1, 2, 3].map(() => sql`select pg_sleep(0.05)`.execute())
  const reserving = sql.reserve()
  await 1
  const seen = sql.stats()
  await Promise.all(queries)
  const reserved = await reserving
  reserved.release()
  await sql.end()
  return [
    JSON.stringify(want(2, { totalCount: 2, connectingCount: 2, waitingCount: 4, availableCount: 0 })),
    JSON.stringify(seen)
  ]
})

t('stats count a reserved connection', async() => {
  const sql = postgres({ ...options, max: 2 })
  const reserved = await sql.reserve()
  const seen = sql.stats()
  const handle = reserved.stats()
  reserved.release()
  await 1
  const released = sql.stats()
  await sql.end()
  return [
    JSON.stringify([
      want(2, { totalCount: 1, reservedCount: 1, activeCount: 1, availableCount: 1 }),
      want(2, { totalCount: 1, reservedCount: 1, activeCount: 1, availableCount: 1 }),
      want(2, { totalCount: 1, idleCount: 1, availableCount: 2 })
    ]),
    JSON.stringify([seen, handle, released])
  ]
})

t('stats count a transaction as reserved', async() => {
  const sql = postgres({ ...options, max: 2 })
  const seen = await sql.begin(async tx => (await tx`select 1`, sql.stats()))
  await sql.end()
  return [
    JSON.stringify(want(2, { totalCount: 1, reservedCount: 1, activeCount: 1, availableCount: 1 })),
    JSON.stringify(seen)
  ]
})

t('stats count queries pipelined on a reserved connection as waiting', async() => {
  const sql = postgres({ ...options, max: 1 })
  const reserved = await sql.reserve()
  const queries = [1, 2, 3].map(() => reserved`select pg_sleep(0.05)`.execute())
  await 1
  const seen = sql.stats()
  await Promise.all(queries)
  reserved.release()
  await sql.end()
  return [
    JSON.stringify(want(1, { totalCount: 1, reservedCount: 1, activeCount: 1, executingCount: 1, waitingCount: 2, availableCount: 0 })),
    JSON.stringify(seen)
  ]
})

t('stats count a reserved connection at the pipeline limit as reserved with queued queries waiting', async() => {
  const sql = postgres({ ...options, max: 1, max_pipeline: 1 })
  const reserved = await sql.reserve()
  const queries = [1, 2, 3].map(() => reserved`select pg_sleep(0.05)`.execute())
  await 1
  const seen = sql.stats()
  await Promise.all(queries)
  reserved.release()
  await sql.end()
  return [
    JSON.stringify(want(1, { totalCount: 1, reservedCount: 1, activeCount: 1, executingCount: 1, waitingCount: 2, availableCount: 0 })),
    JSON.stringify(seen)
  ]
})

t('stats drop a query cancelled in a reserved connection queue', async() => {
  const sql = postgres({ ...options, max: 1, max_pipeline: 1 })
  const reserved = await sql.reserve()
  const queries = [1, 2, 3].map(() => reserved`select pg_sleep(0.05)`.execute())
  const cancelled = queries[2].catch(e => e.code)
  await 1
  const before = sql.stats().waitingCount
  await queries[2].cancel()
  const after = sql.stats().waitingCount
  await Promise.all(queries.slice(0, 2))
  reserved.release()
  await sql.end()
  return [
    JSON.stringify(['57014', 2, 1]),
    JSON.stringify([await cancelled, before, after])
  ]
})

t('stats count a connection that finished its query while ending as closing', async() => {
  const sql = postgres({ ...options, max: 2 })
  const running = sql`select pg_sleep(0.1)`.execute()
  await delay(50)
  const ending = sql.end()
  await running
  const seen = sql.stats()
  await ending
  return [
    JSON.stringify(want(2, { closingCount: 1, availableCount: 1 })),
    JSON.stringify(seen)
  ]
})

t('stats after end have no connections', async() => {
  const sql = postgres({ ...options, max: 3 })
  await Promise.all([sql`select 1`, sql`select 1`, sql`select pg_sleep(0.05)`])
  await sql.end()
  return [JSON.stringify(want(3)), JSON.stringify(sql.stats())]
})

t('stats count the listen connection outside the pool', async() => {
  const sql = postgres({ ...options, max: 2 })
  await sql.listen('stats_listen', () => undefined)
  const listening = sql.stats()
  await sql.end()
  const ended = sql.stats()
  return [
    JSON.stringify([want(2, { listenCount: 1 }), want(2)]),
    JSON.stringify([listening, ended])
  ]
})

t('big query body', { timeout: 2 }, async() => {
  await sql`create table test (x int)`
  return [50000, (await sql`insert into test ${
    sql([...Array(50000).keys()].map(x => ({ x })))
  }`).count, await sql`drop table test`]
})

t('Throws if more than 65534 parameters', async() => {
  await sql`create table test (x int)`
  return ['MAX_PARAMETERS_EXCEEDED', (await sql`insert into test ${
    sql([...Array(65535).keys()].map(x => ({ x })))
  }`.catch(e => e.code)), await sql`drop table test`]
})

t('let postgres do implicit cast of unknown types', async() => {
  await sql`create table test (x timestamp with time zone)`
  const [{ x }] = await sql`insert into test values (${ new Date().toISOString() }) returning *`
  return [true, x instanceof Date, await sql`drop table test`]
})

t('only allows one statement', async() =>
  ['42601', await sql`select 1; select 2`.catch(e => e.code)]
)

t('await sql() throws not tagged error', async() => {
  let error
  try {
    await sql('select 1')
  } catch (e) {
    error = e.code
  }
  return ['NOT_TAGGED_CALL', error]
})

t('sql().then throws not tagged error', async() => {
  let error
  try {
    sql('select 1').then(() => { /* noop */ })
  } catch (e) {
    error = e.code
  }
  return ['NOT_TAGGED_CALL', error]
})

t('sql().catch throws not tagged error', async() => {
  let error
  try {
    await sql('select 1')
  } catch (e) {
    error = e.code
  }
  return ['NOT_TAGGED_CALL', error]
})

t('sql().finally throws not tagged error', async() => {
  let error
  try {
    sql('select 1').finally(() => { /* noop */ })
  } catch (e) {
    error = e.code
  }
  return ['NOT_TAGGED_CALL', error]
})

t('little bobby tables', async() => {
  const name = 'Robert\'); DROP TABLE students;--'

  await sql`create table students (name text, age int)`
  await sql`insert into students (name) values (${ name })`

  return [
    name, (await sql`select name from students`)[0].name,
    await sql`drop table students`
  ]
})

t('Connection errors are caught using begin()', {
  timeout: 2
}, async() => {
  let error
  try {
    const sql = postgres({ host: 'localhost', port: 1 })

    await sql.begin(async(sql) => {
      await sql`insert into test (label, value) values (${1}, ${2})`
    })
  } catch (err) {
    error = err
  }

  return [
    true,
    error.code === 'ECONNREFUSED' ||
    error.message === 'Connection refused (os error 61)'
  ]
})

t('dynamic table name', async() => {
  await sql`create table test(a int)`
  return [
    0, (await sql`select * from ${ sql('test') }`).count,
    await sql`drop table test`
  ]
})

t('dynamic schema name', async() => {
  await sql`create table test(a int)`
  return [
    0, (await sql`select * from ${ sql('public') }.test`).count,
    await sql`drop table test`
  ]
})

t('dynamic schema and table name', async() => {
  await sql`create table test(a int)`
  return [
    0, (await sql`select * from ${ sql('public.test') }`).count,
    await sql`drop table test`
  ]
})

t('dynamic column name', async() => {
  return ['!not_valid', Object.keys((await sql`select 1 as ${ sql('!not_valid') }`)[0])[0]]
})

t('dynamic select as', async() => {
  return ['2', (await sql`select ${ sql({ a: 1, b: 2 }) }`)[0].b]
})

t('dynamic select as pluck', async() => {
  return [undefined, (await sql`select ${ sql({ a: 1, b: 2 }, 'a') }`)[0].b]
})

t('dynamic insert', async() => {
  await sql`create table test (a int, b text)`
  const x = { a: 42, b: 'the answer' }

  return ['the answer', (await sql`insert into test ${ sql(x) } returning *`)[0].b, await sql`drop table test`]
})

t('dynamic insert pluck', async() => {
  await sql`create table test (a int, b text)`
  const x = { a: 42, b: 'the answer' }

  return [null, (await sql`insert into test ${ sql(x, 'a') } returning *`)[0].b, await sql`drop table test`]
})

t('dynamic in with empty array', async() => {
  await sql`create table test (a int)`
  await sql`insert into test values (1)`
  return [
    (await sql`select * from test where null in ${ sql([]) }`).count,
    0,
    await sql`drop table test`
  ]
})

t('dynamic in after insert', async() => {
  await sql`create table test (a int, b text)`
  const [{ x }] = await sql`
    with x as (
      insert into test values (1, 'hej')
      returning *
    )
    select 1 in ${ sql([1, 2, 3]) } as x from x
  `
  return [
    true, x,
    await sql`drop table test`
  ]
})

t('array insert', async() => {
  await sql`create table test (a int, b int)`
  return [2, (await sql`insert into test (a, b) values ${ sql([1, 2]) } returning *`)[0].b, await sql`drop table test`]
})

t('where parameters in()', async() => {
  await sql`create table test (x text)`
  await sql`insert into test values ('a')`
  return [
    (await sql`select * from test where x in ${ sql(['a', 'b', 'c']) }`)[0].x,
    'a',
    await sql`drop table test`
  ]
})

t('where parameters in() values before', async() => {
  return [2, (await sql`
    with rows as (
      select * from (values (1), (2), (3), (4)) as x(a)
    )
    select * from rows where a in ${ sql([3, 4]) }
  `).count]
})

t('dynamic multi row insert', async() => {
  await sql`create table test (a int, b text)`
  const x = { a: 42, b: 'the answer' }

  return [
    'the answer',
    (await sql`insert into test ${ sql([x, x]) } returning *`)[1].b, await sql`drop table test`
  ]
})

t('dynamic update', async() => {
  await sql`create table test (a int, b text)`
  await sql`insert into test (a, b) values (17, 'wrong')`

  return [
    'the answer',
    (await sql`update test set ${ sql({ a: 42, b: 'the answer' }) } returning *`)[0].b, await sql`drop table test`
  ]
})

t('dynamic update pluck', async() => {
  await sql`create table test (a int, b text)`
  await sql`insert into test (a, b) values (17, 'wrong')`

  return [
    'wrong',
    (await sql`update test set ${ sql({ a: 42, b: 'the answer' }, 'a') } returning *`)[0].b, await sql`drop table test`
  ]
})

t('dynamic select array', async() => {
  await sql`create table test (a int, b text)`
  await sql`insert into test (a, b) values (42, 'yay')`
  return ['yay', (await sql`select ${ sql(['a', 'b']) } from test`)[0].b, await sql`drop table test`]
})

t('dynamic returning array', async() => {
  await sql`create table test (a int, b text)`
  return [
    'yay',
    (await sql`insert into test (a, b) values (42, 'yay') returning ${ sql(['a', 'b']) }`)[0].b,
    await sql`drop table test`
  ]
})

t('dynamic select args', async() => {
  await sql`create table test (a int, b text)`
  await sql`insert into test (a, b) values (42, 'yay')`
  return ['yay', (await sql`select ${ sql('a', 'b') } from test`)[0].b, await sql`drop table test`]
})

t('dynamic values single row', async() => {
  const [{ b }] = await sql`
    select * from (values ${ sql(['a', 'b', 'c']) }) as x(a, b, c)
  `

  return ['b', b]
})

t('dynamic values multi row', async() => {
  const [, { b }] = await sql`
    select * from (values ${ sql([['a', 'b', 'c'], ['a', 'b', 'c']]) }) as x(a, b, c)
  `

  return ['b', b]
})

t('connection parameters', async() => {
  const sql = postgres({
    ...options,
    connection: {
      'some.var': 'yay'
    }
  })

  return ['yay', (await sql`select current_setting('some.var') as x`)[0].x]
})

t('Multiple queries', async() => {
  const sql = postgres(options)

  return [4, (await Promise.all([
    sql`select 1`,
    sql`select 2`,
    sql`select 3`,
    sql`select 4`
  ])).length]
})

t('Multiple statements', async() =>
  [2, await sql.unsafe(`
    select 1 as x;
    select 2 as a;
  `).then(([, [x]]) => x.a)]
)

t('throws correct error when authentication fails', async() => {
  const sql = postgres({
    ...options,
    ...login_md5,
    pass: 'wrong'
  })
  return ['28P01', await sql`select 1`.catch(e => e.code)]
})

t('notice', async() => {
  let notice
  const log = console.log // eslint-disable-line
  console.log = function(x) { // eslint-disable-line
    notice = x
  }

  const sql = postgres(options)

  await sql`create table if not exists users()`
  await sql`create table if not exists users()`

  console.log = log // eslint-disable-line

  return ['NOTICE', notice.severity]
})

t('onnotice false ignores notices', async() => {
  const logged = []
  const log = globalThis.console.log
  globalThis.console.log = x => logged.push(x)
  try {
    const sql = postgres({ ...options, onnotice: false })
    await sql`do $$ begin raise notice 'silenced'; end $$`
    await sql.end()
  } finally {
    globalThis.console.log = log
  }

  return [0, logged.length]
})

t('notice hook', async() => {
  let notice
  const sql = postgres({
    ...options,
    onnotice: x => notice = x
  })

  await sql`create table if not exists users()`
  await sql`create table if not exists users()`

  return ['NOTICE', notice.severity]
})

t('bytea serializes and parses', async() => {
  const buf = Buffer.from('wat')

  await sql`create table test (x bytea)`
  await sql`insert into test values (${ buf })`

  return [
    buf.toString(),
    (await sql`select x from test`)[0].x.toString(),
    await sql`drop table test`
  ]
})

t('forEach', async() => {
  let result
  await sql`select 1 as x`.forEach(({ x }) => result = x)
  return [1, result]
})

t('forEach returns empty array', async() => {
  return [0, (await sql`select 1 as x`.forEach(() => { /* noop */ })).length]
})

t('Cursor', async() => {
  const order = []
  await sql`select 1 as x union select 2 as x`.cursor(async([x]) => {
    order.push(x.x + 'a')
    await delay(100)
    order.push(x.x + 'b')
  })
  return ['1a1b2a2b', order.join('')]
})

t('Unsafe cursor', async() => {
  const order = []
  await sql.unsafe('select 1 as x union select 2 as x').cursor(async([x]) => {
    order.push(x.x + 'a')
    await delay(100)
    order.push(x.x + 'b')
  })
  return ['1a1b2a2b', order.join('')]
})

t('Cursor custom n', async() => {
  const order = []
  await sql`select * from generate_series(1,20)`.cursor(10, async(x) => {
    order.push(x.length)
  })
  return ['10,10', order.join(',')]
})

t('Cursor custom with rest n', async() => {
  const order = []
  await sql`select * from generate_series(1,20)`.cursor(11, async(x) => {
    order.push(x.length)
  })
  return ['11,9', order.join(',')]
})

t('Cursor custom with less results than batch size', async() => {
  const order = []
  await sql`select * from generate_series(1,20)`.cursor(21, async(x) => {
    order.push(x.length)
  })
  return ['20', order.join(',')]
})

t('Cursor cancel', async() => {
  let result
  await sql`select * from generate_series(1,10) as x`.cursor(async([{ x }]) => {
    result = x
    return sql.CLOSE
  })
  return [1, result]
})

t('Cursor throw', async() => {
  const order = []
  await sql`select 1 as x union select 2 as x`.cursor(async([x]) => {
    order.push(x.x + 'a')
    await delay(100)
    throw new Error('watty')
  }).catch(() => order.push('err'))
  return ['1aerr', order.join('')]
})

t('Cursor error', async() => [
  '42601',
  await sql`wat`.cursor(() => { /* noop */ }).catch((err) => err.code)
])

t('Multiple Cursors', { timeout: 2 }, async() => {
  const result = []
  await sql.begin(async sql => [
    await sql`select 1 as cursor, x from generate_series(1,4) as x`.cursor(async([row]) => {
      result.push(row.x)
      await new Promise(r => setTimeout(r, 20))
    }),
    await sql`select 2 as cursor, x from generate_series(101,104) as x`.cursor(async([row]) => {
      result.push(row.x)
      await new Promise(r => setTimeout(r, 10))
    })
  ])

  return ['1,2,3,4,101,102,103,104', result.join(',')]
})

t('Cursor as async iterator', async() => {
  const order = []
  for await (const [x] of sql`select generate_series(1,2) as x;`.cursor()) {
    order.push(x.x + 'a')
    await delay(10)
    order.push(x.x + 'b')
  }

  return ['1a1b2a2b', order.join('')]
})

t('Cursor as async iterator with break', async() => {
  const order = []
  for await (const xs of sql`select generate_series(1,2) as x;`.cursor()) {
    order.push(xs[0].x + 'a')
    await delay(10)
    order.push(xs[0].x + 'b')
    break
  }

  return ['1a1b', order.join('')]
})

t('Async Iterator Unsafe cursor', async() => {
  const order = []
  for await (const [x] of sql.unsafe('select 1 as x union select 2 as x').cursor()) {
    order.push(x.x + 'a')
    await delay(10)
    order.push(x.x + 'b')
  }
  return ['1a1b2a2b', order.join('')]
})

t('Async Iterator Cursor custom n', async() => {
  const order = []
  for await (const x of sql`select * from generate_series(1,20)`.cursor(10))
    order.push(x.length)

  return ['10,10', order.join(',')]
})

t('Async Iterator Cursor custom with rest n', async() => {
  const order = []
  for await (const x of sql`select * from generate_series(1,20)`.cursor(11))
    order.push(x.length)

  return ['11,9', order.join(',')]
})

t('Async Iterator Cursor custom with less results than batch size', async() => {
  const order = []
  for await (const x of sql`select * from generate_series(1,20)`.cursor(21))
    order.push(x.length)
  return ['20', order.join(',')]
})

t('Transform row', async() => {
  const sql = postgres({
    ...options,
    transform: { row: () => 1 }
  })

  return [1, (await sql`select 'wat'`)[0]]
})

t('Transform row forEach', async() => {
  let result
  const sql = postgres({
    ...options,
    transform: { row: () => 1 }
  })

  await sql`select 1`.forEach(x => result = x)

  return [1, result]
})

t('Transform value', async() => {
  const sql = postgres({
    ...options,
    transform: { value: () => 1 }
  })

  return [1, (await sql`select 'wat' as x`)[0].x]
})

t('Transform columns from', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.fromCamel
  })
  await sql`create table test (a_test int, b_test text)`
  await sql`insert into test ${ sql([{ aTest: 1, bTest: 1 }]) }`
  await sql`update test set ${ sql({ aTest: 2, bTest: 2 }) }`
  return [
    2,
    (await sql`select ${ sql('aTest', 'bTest') } from test`)[0].a_test,
    await sql`drop table test`
  ]
})

t('Transform columns to', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.toCamel
  })
  await sql`create table test (a_test int, b_test text)`
  await sql`insert into test ${ sql([{ a_test: 1, b_test: 1 }]) }`
  await sql`update test set ${ sql({ a_test: 2, b_test: 2 }) }`
  return [
    2,
    (await sql`select a_test, b_test from test`)[0].aTest,
    await sql`drop table test`
  ]
})

t('Transform columns from and to', async() => {
  const sql = postgres({
    ...options,
    transform: postgres.camel
  })
  await sql`create table test (a_test int, b_test text)`
  await sql`insert into test ${ sql([{ aTest: 1, bTest: 1 }]) }`
  await sql`update test set ${ sql({ aTest: 2, bTest: 2 }) }`
  return [
    2,
    (await sql`select ${ sql('aTest', 'bTest') } from test`)[0].aTest,
    await sql`drop table test`
  ]
})

t('Transform columns from and to (legacy)', async() => {
  const sql = postgres({
    ...options,
    transform: {
      column: {
        to: postgres.fromCamel,
        from: postgres.toCamel
      }
    }
  })
  await sql`create table test (a_test int, b_test text)`
  await sql`insert into test ${ sql([{ aTest: 1, bTest: 1 }]) }`
  await sql`update test set ${ sql({ aTest: 2, bTest: 2 }) }`
  return [
    2,
    (await sql`select ${ sql('aTest', 'bTest') } from test`)[0].aTest,
    await sql`drop table test`
  ]
})

t('Unix socket', async() => {
  const sql = postgres({
    ...options,
    host: process.env.PGSOCKET || '/tmp' // eslint-disable-line
  })

  return [1, (await sql`select 1 as x`)[0].x]
})

t('Big result', async() => {
  return [100000, (await sql`select * from generate_series(1, 100000)`).count]
})

t('Debug', async() => {
  let result
  const sql = postgres({
    ...options,
    debug: (connection_id, str) => result = str
  })

  await sql`select 1`

  return ['select 1', result]
})

t('bigint is returned as String', async() => [
  'string',
  typeof (await sql`select 9223372036854777 as x`)[0].x
])

t('int is returned as Number', async() => [
  'number',
  typeof (await sql`select 123 as x`)[0].x
])

t('numeric is returned as string', async() => [
  'string',
  typeof (await sql`select 1.2 as x`)[0].x
])

t('Async stack trace', async() => {
  const sql = postgres({ ...options, debug: false })
  return [
    parseInt(new Error().stack.split('\n')[1].match(':([0-9]+):')[1]) + 1,
    parseInt(await sql`error`.catch(x => x.stack.split('\n').pop().match(':([0-9]+):')[1]))
  ]
})

t('Debug has long async stack trace', async() => {
  const sql = postgres({ ...options, debug: true })

  return [
    'watyo',
    await yo().catch(x => x.stack.match(/wat|yo/g).join(''))
  ]

  function yo() {
    return wat()
  }

  function wat() {
    return sql`error`
  }
})

t('Query errors keep a writable stack', async() => {
  const error = await sql`error`.catch(x => x)
  error.stack = 'replaced'
  return ['replaced', error.stack]
})

t('Error contains query string', async() => [
  'selec 1',
  (await sql`selec 1`.catch(err => err.query))
])

t('Error contains query serialized parameters', async() => [
  1,
  (await sql`selec ${ 1 }`.catch(err => err.parameters[0]))
])

t('Error contains query raw parameters', async() => [
  1,
  (await sql`selec ${ 1 }`.catch(err => err.args[0]))
])

t('Query and parameters on errorare not enumerable if debug is not set', async() => {
  const sql = postgres({ ...options, debug: false })

  return [
    false,
    (await sql`selec ${ 1 }`.catch(err => err.propertyIsEnumerable('parameters') || err.propertyIsEnumerable('query')))
  ]
})

t('Query and parameters are enumerable if debug is set', async() => {
  const sql = postgres({ ...options, debug: true })

  return [
    true,
    (await sql`selec ${ 1 }`.catch(err => err.propertyIsEnumerable('parameters') && err.propertyIsEnumerable('query')))
  ]
})

t('connect_timeout', { timeout: 20 }, async() => {
  const connect_timeout = 0.2
  const server = net.createServer()
  server.listen()
  const sql = postgres({ port: server.address().port, host: '127.0.0.1', connect_timeout })
  const start = Date.now()
  let end
  await sql`select 1`.catch((e) => {
    if (e.code !== 'CONNECT_TIMEOUT')
      throw e
    end = Date.now()
  })
  server.close()
  const elapsed = end - start
  return ['within window', elapsed >= connect_timeout * 900 && elapsed < 1000 ? 'within window' : elapsed + 'ms']
})

t('connect_timeout throws proper error', async() => {
  let passwordRequested = false
  const sql = postgres({ ...options, ...login_scram, connect_timeout: 0.5,
                         pass: () => {
                           passwordRequested = true
                           return new Promise(() => { /* Deliberately unresolved authentication. */ })
                         } })
  try {
    const code = await sql`select 1`.catch(e => e.code)
    if (!passwordRequested)
      throw new Error('Timeout occurred before the controlled authentication stall')
    return ['CONNECT_TIMEOUT', code]
  } finally {
    await sql.end({ timeout: 0 })
  }
})

t('connect_timeout error message includes host:port', { timeout: 20 }, async() => {
  const connect_timeout = 0.2
  const server = net.createServer()
  server.listen()
  const sql = postgres({ port: server.address().port, host: '127.0.0.1', connect_timeout })
  const port = server.address().port
  let err
  await sql`select 1`.catch((e) => {
    if (e.code !== 'CONNECT_TIMEOUT')
      throw e
    err = e.message
  })
  server.close()
  return [['write CONNECT_TIMEOUT 127.0.0.1:', port].join(''), err]
})

t('requests works after single connect_timeout', async() => {
  let first = true

  const sql = postgres({
    ...options,
    ...login_scram,
    connect_timeout: { valueOf() { return first ? (first = false, 0.0001) : 1 } }
  })

  return [
    'CONNECT_TIMEOUT,,1',
    [
      await sql`select 1 as x`.then(() => 'success', x => x.code),
      await delay(10),
      (await sql`select 1 as x`)[0].x
    ].join(',')
  ]
})

t('Postgres errors are of type PostgresError', async() =>
  [true, (await sql`bad keyword`.catch(e => e)) instanceof sql.PostgresError]
)

t('Result has columns spec', async() =>
  ['x', (await sql`select 1 as x`).columns[0].name]
)

t('forEach has result as second argument', async() => {
  let x
  await sql`select 1 as x`.forEach((_, result) => x = result)
  return ['x', x.columns[0].name]
})

t('Result as arrays', async() => {
  const sql = postgres({
    ...options,
    transform: {
      row: x => Object.values(x)
    }
  })

  return ['1,2', (await sql`select 1 as a, 2 as b`)[0].join(',')]
})

t('Insert empty array', async() => {
  await sql`create table tester (ints int[])`
  return [
    Array.isArray((await sql`insert into tester (ints) values (${ sql.array([]) }) returning *`)[0].ints),
    true,
    await sql`drop table tester`
  ]
})

t('Insert array in sql()', async() => {
  await sql`create table tester (ints int[])`
  return [
    Array.isArray((await sql`insert into tester ${ sql({ ints: sql.array([]) }) } returning *`)[0].ints),
    true,
    await sql`drop table tester`
  ]
})

t('Automatically creates prepared statements', async() => {
  const sql = postgres(options)
  const result = await sql`select * from pg_prepared_statements`
  return [true, result.some(x => x.name = result.statement.name)]
})

t('no_prepare: true disables prepared statements (deprecated)', async() => {
  const sql = postgres({ ...options, no_prepare: true })
  const result = await sql`select * from pg_prepared_statements`
  return [false, result.some(x => x.name = result.statement.name)]
})

t('prepare: false disables prepared statements', async() => {
  const sql = postgres({ ...options, prepare: false })
  const result = await sql`select * from pg_prepared_statements`
  return [false, result.some(x => x.name = result.statement.name)]
})

t('prepare: true enables prepared statements', async() => {
  const sql = postgres({ ...options, prepare: true })
  const result = await sql`select * from pg_prepared_statements`
  return [true, result.some(x => x.name = result.statement.name)]
})

t('prepares unsafe query when "prepare" option is true', async() => {
  const sql = postgres({ ...options, prepare: true })
  const result = await sql.unsafe('select * from pg_prepared_statements where name <> $1', ['bla'], { prepare: true })
  return [true, result.some(x => x.name = result.statement.name)]
})

t('does not prepare unsafe query by default', async() => {
  const sql = postgres({ ...options, prepare: true })
  const result = await sql.unsafe('select * from pg_prepared_statements where name <> $1', ['bla'])
  return [false, result.some(x => x.name = result.statement.name)]
})

t('Recreate prepared statements on transformAssignedExpr error', { timeout: 1 }, async() => {
  const insert = () => sql`insert into test (name) values (${ '1' }) returning name`
  await sql`create table test (name text)`
  await insert()
  await sql`alter table test alter column name type int using name::integer`
  return [
    1,
    (await insert())[0].name,
    await sql`drop table test`
  ]
})

t('Throws correct error when retrying in transactions', async() => {
  await sql`create table test(x int)`
  const error = await sql.begin(sql => sql`insert into test (x) values (${ false })`).catch(e => e)
  return [
    error.code,
    '42804',
    sql`drop table test`
  ]
})

t('transaction control statements are sent unprepared and survive deallocate all', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  await sql.begin(s => s`insert into test values (1)`)
  await sql.begin(s => s`select 1/0`).catch(noop)
  const before = (await sql`select pg_backend_pid() as pid`)[0].pid
  await sql`deallocate all`
  const committed = await sql.begin(s => s`insert into test values (2)`).then(() => 'resolved', e => e.code)
  const rows = (await sql`select count(*)::int as n from test`)[0].n
  const failed = await sql.begin(s => s`select 2/0`).then(() => 'resolved', e => e.code)
  const after = (await sql`select pg_backend_pid() as pid`)[0].pid
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['resolved', 2, '22012', true]),
    JSON.stringify([committed, rows, failed, before === after])
  ]
})

t('sql.begin rejects when the server rolls the transaction back at commit', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  const error = await sql.begin(s => {
    s`insert into test values (1)`.execute()
    s`select 1/0`.execute().catch(noop)
    return 'done'
  }).then(x => x, e => e)
  const rows = (await sql`select count(*)::int as n from test`)[0].n
  const next = (await sql`select 4 as x`)[0].x
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['TRANSACTION_ROLLED_BACK', '22012', 0, 4]),
    JSON.stringify([error.code, error.cause && error.cause.code, rows, next])
  ]
})

t('sql.begin rejects when COMMIT rolls back after a caught savepoint whose rollback to failed', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  let childCode
  const error = await sql.begin(async tx => {
    await tx`insert into test values (1)`
    await tx`savepoint parent_marker`
    try {
      await tx.savepoint(async sp => {
        await sp`rollback to savepoint parent_marker`
        throw new Error('rollback to the removed child savepoint')
      })
    } catch (e) {
      childCode = e.code
    }
    return 'success'
  }).then(x => x, e => e)
  const rows = (await sql`select count(*)::int as n from test`)[0].n
  const next = (await sql`select 4 as x`)[0].x
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['3B001', 'TRANSACTION_ROLLED_BACK', 0, 4]),
    JSON.stringify([childCode, error.code, rows, next])
  ]
})

t('Recreate prepared statements on RevalidateCachedQuery error', async() => {
  const select = () => sql`select name from test`
  await sql`create table test (name text)`
  await sql`insert into test values ('1')`
  await select()
  await sql`alter table test alter column name type int using name::integer`
  return [
    1,
    (await select())[0].name,
    await sql`drop table test`
  ]
})

t('Does not re-serialize json parameters when retrying on RevalidateCachedQuery error', async() => {
  const update = () => sql`update test set config = ${ sql.json({ warmup: 2100000000, ticksLimit: 5000 }) } returning *`
  await sql`create table test (id int, config jsonb)`
  await sql`insert into test values (1, '{}')`
  await update()
  await sql`alter table test add column extra int`
  await update()
  return [
    'object',
    (await sql`select jsonb_typeof(config) as type from test`)[0].type,
    await sql`drop table test`
  ]
})

t('Does not re-serialize json parameters when retrying on FetchPreparedStatement error', async() => {
  const sql = postgres(options)
  const insert = () => sql`insert into test (config) values (${ sql.json({ warmup: 2100000000 }) })`
  await sql`create table test (config jsonb)`
  await insert()
  await sql`deallocate all`
  await insert()
  const actual = (await sql`select jsonb_typeof(config) as type from test`).map(x => x.type).join()
  await sql`drop table test`
  await sql.end()

  return [
    'object,object',
    actual
  ]
})

t('Does not re-serialize boolean parameters when retrying on RevalidateCachedQuery error', async() => {
  const update = () => sql`update test set enabled = ${ true } returning *`
  await sql`create table test (id int, enabled bool)`
  await sql`insert into test values (1, false)`
  await update()
  await sql`alter table test add column extra int`
  await update()
  return [
    true,
    (await sql`select enabled from test`)[0].enabled,
    await sql`drop table test`
  ]
})

t('Does not re-serialize boolean parameters when retrying on FetchPreparedStatement error', async() => {
  const sql = postgres(options)
  const insert = () => sql`insert into test (enabled) values (${ true })`
  await sql`create table test (enabled bool)`
  await insert()
  await sql`deallocate all`
  await insert()
  const actual = (await sql`select enabled from test`).map(x => x.enabled).join()
  await sql`drop table test`
  await sql.end()

  return [
    'true,true',
    actual
  ]
})

t('Does not re-serialize bytea parameters when retrying on RevalidateCachedQuery error', async() => {
  const update = () => sql`update test set data = ${ Buffer.from('hello') } returning *`
  await sql`create table test (id int, data bytea)`
  await sql`insert into test values (1, null)`
  await update()
  await sql`alter table test add column extra int`
  await update()
  return [
    'hello',
    (await sql`select data from test`)[0].data.toString(),
    await sql`drop table test`
  ]
})

t('Does not re-serialize bytea parameters when retrying on FetchPreparedStatement error', async() => {
  const sql = postgres(options)
  const insert = () => sql`insert into test (data) values (${ Buffer.from('hello') })`
  await sql`create table test (data bytea)`
  await insert()
  await sql`deallocate all`
  await insert()
  const actual = (await sql`select data from test`).map(x => x.data.toString()).join()
  await sql`drop table test`
  await sql.end()

  return [
    'hello,hello',
    actual
  ]
})

t('a prepared rollback to savepoint is retried inside a failed transaction after deallocate all', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql.begin(async s => {
    await s`savepoint a`
    await s`rollback to a`
  })
  await sql`deallocate all`
  const code = await sql.begin(async s => {
    await s.unsafe('savepoint a')
    await s`select 1/0`.catch(noop)
    await s`rollback to a`
    return await s`select 5 as x`
  }).then(() => 'resolved', e => e.code)
  const next = (await sql`select 6 as x`)[0].x
  await sql.end()

  return [
    JSON.stringify(['22012', 6]),
    JSON.stringify([code, next])
  ]
})

t('Properly throws routine error on not prepared statements', async() => {
  await sql`create table x (x text[])`
  const { routine } = await sql.unsafe(`
    insert into x(x) values (('a', 'b'))
  `).catch(e => e)

  return ['transformAssignedExpr', routine, await sql`drop table x`]
})

t('Properly throws routine error on not prepared statements in transaction', async() => {
  const { routine } = await sql.begin(sql => [
    sql`create table x (x text[])`,
    sql`insert into x(x) values (('a', 'b'))`
  ]).catch(e => e)

  return ['transformAssignedExpr', routine]
})

t('Properly throws routine error on not prepared statements using file', async() => {
  const { routine } = await sql.unsafe(`
    create table x (x text[]);
    insert into x(x) values (('a', 'b'));
  `, { prepare: true }).catch(e => e)

  return ['transformAssignedExpr', routine]
})

t('Catches connection config errors', async() => {
  const sql = postgres({ ...options, user: { toString: () => { throw new Error('wat') } }, database: 'prut' })

  return [
    'wat',
    await sql`select 1`.catch((e) => e.message)
  ]
})

t('Catches connection config errors with end', async() => {
  const sql = postgres({ ...options, user: { toString: () => { throw new Error('wat') } }, database: 'prut' })

  return [
    'wat',
    await sql`select 1`.catch((e) => e.message),
    await sql.end()
  ]
})

t('Catches query format errors', async() => [
  'wat',
  await sql.unsafe({ toString: () => { throw new Error('wat') } }).catch((e) => e.message)
])

t('Multiple hosts', {
  timeout: 1
}, async() => {
  const s1 = postgres({ idle_timeout })
      , s2 = postgres({ idle_timeout, port: 5433 })
      , sql = postgres('postgres://localhost:5432,localhost:5433', { idle_timeout, max: 1 })
      , result = []

  const id1 = (await s1`select system_identifier as x from pg_control_system()`)[0].x
  const id2 = (await s2`select system_identifier as x from pg_control_system()`)[0].x

  const x1 = await sql`select 1`
  result.push((await sql`select system_identifier as x from pg_control_system()`)[0].x)
  await s1`select pg_terminate_backend(${ x1.state.pid }::int)`
  await delay(50)

  const x2 = await sql`select 1`
  result.push((await sql`select system_identifier as x from pg_control_system()`)[0].x)
  await s2`select pg_terminate_backend(${ x2.state.pid }::int)`
  await delay(50)

  result.push((await sql`select system_identifier as x from pg_control_system()`)[0].x)

  return [[id1, id2, id1].join(','), result.join(',')]
})

t('Escaping supports schemas and tables', async() => {
  await sql`create schema a`
  await sql`create table a.b (c int)`
  await sql`insert into a.b (c) values (1)`
  return [
    1,
    (await sql`select ${ sql('a.b.c') } from a.b`)[0].c,
    await sql`drop table a.b`,
    await sql`drop schema a`
  ]
})

t('Raw method returns rows as arrays', async() => {
  const [x] = await sql`select 1`.raw()
  return [
    Array.isArray(x),
    true
  ]
})

t('Raw method returns values unparsed as Buffer', async() => {
  const [[x]] = await sql`select 1`.raw()
  return [
    x instanceof Uint8Array,
    true
  ]
})

t('Array returns rows as arrays of columns', async() => {
  return [(await sql`select 1`.values())[0][0], 1]
})

t('Copy read', async() => {
  const result = []

  await sql`create table test (x int)`
  await sql`insert into test select * from generate_series(1,10)`
  const readable = await sql`copy test to stdout`.readable()
  readable.on('data', x => result.push(x))
  await new Promise(r => readable.on('end', r))

  return [
    result.length,
    10,
    await sql`drop table test`
  ]
})

t('Copy write', { timeout: 2 }, async() => {
  await sql`create table test (x int)`
  const writable = await sql`copy test from stdin`.writable()

  writable.write('1\n')
  writable.write('1\n')
  writable.end()

  await new Promise(r => writable.on('finish', r))

  return [
    (await sql`select 1 from test`).length,
    2,
    await sql`drop table test`
  ]
})

t('Copy write as first', async() => {
  await sql`create table test (x int)`
  const first = postgres(options)
  const writable = await first`COPY test FROM STDIN WITH(FORMAT csv, HEADER false, DELIMITER ',')`.writable()
  writable.write('1\n')
  writable.write('1\n')
  writable.end()

  await new Promise(r => writable.on('finish', r))

  return [
    (await sql`select 1 from test`).length,
    2,
    await sql`drop table test`
  ]
})

t('Copy from file', async() => {
  await sql`create table test (x int, y int, z int)`
  await new Promise(async r => fs
    .createReadStream(rel('copy.csv'))
    .pipe(await sql`copy test from stdin`.writable())
    .on('finish', r)
  )

  return [
    JSON.stringify(await sql`select * from test`),
    '[{"x":1,"y":2,"z":3},{"x":4,"y":5,"z":6}]',
    await sql`drop table test`
  ]
})

t('Copy from works in transaction', async() => {
  await sql`create table test(x int)`
  const xs = await sql.begin(async sql => {
    (await sql`copy test from stdin`.writable()).end('1\n2')
    await delay(20)
    return sql`select 1 from test`
  })

  return [
    xs.length,
    2,
    await sql`drop table test`
  ]
})

t('Copy from abort', async() => {
  const sql = postgres(options)
  const readable = fs.createReadStream(rel('copy.csv'))

  await sql`create table test (x int, y int, z int)`
  await sql`TRUNCATE TABLE test`

  const writable = await sql`COPY test FROM STDIN`.writable()

  let aborted

  readable
    .pipe(writable)
    .on('error', (err) => aborted = err)

  writable.destroy(new Error('abort'))
  await sql.end()

  return [
    'abort',
    aborted.message,
    await postgres(options)`drop table test`
  ]
})

t('multiple queries before connect', async() => {
  const sql = postgres({ ...options, max: 2 })
  const xs = await Promise.all([
    sql`select 1 as x`,
    sql`select 2 as x`,
    sql`select 3 as x`,
    sql`select 4 as x`
  ])

  return [
    '1,2,3,4',
    xs.map(x => x[0].x).join()
  ]
})

t('subscribe', { timeout: 13 }, async() => {
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables'
  })

  await sql.unsafe('create publication alltables for all tables')

  const result = []
  let last = false

  const { unsubscribe } = await sql.subscribe('*', (row, { command, old }) => {
    result.push(command, row.name, row.id, old && old.name, old && old.id)
  })
  const { unsubscribe: unsubscribeLast } = await sql.subscribe('*', row => {
    last = last || row.name === 'Oh noes'
  })

  await sql`
    create table test (
      id serial primary key,
      name text
    )
  `

  await sql`alter table test replica identity default`
  await sql`insert into test (name) values ('Murray')`
  await sql`update test set name = 'Rothbard'`
  await sql`update test set id = 2`
  await sql`delete from test`
  await sql`alter table test replica identity full`
  await sql`insert into test (name) values ('Murray')`
  await sql`update test set name = 'Rothbard'`
  await sql`delete from test`
  await until(() => result.length >= 45)
  await unsubscribe()
  await sql`insert into test (name) values ('Oh noes')`
  await until(() => last)
  await unsubscribeLast()
  return [
    'insert,Murray,1,,,update,Rothbard,1,,,update,Rothbard,2,,1,delete,,2,,,insert,Murray,2,,,update,Rothbard,2,Murray,2,delete,Rothbard,2,,', // eslint-disable-line
    result.join(','),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('subscribe with transform', { timeout: 13 }, async() => {
  const sql = postgres({
    transform: {
      column: {
        from: postgres.toCamel,
        to: postgres.fromCamel
      }
    },
    database: 'postgres_js_test',
    publications: 'alltables'
  })

  await sql.unsafe('create publication alltables for all tables')

  const result = []
  let last = false

  const { unsubscribe } = await sql.subscribe('*', (row, { command, old }) =>
    result.push(command, row.nameInCamel || row.id, old && old.nameInCamel)
  )
  const { unsubscribe: unsubscribeLast } = await sql.subscribe('*', row => {
    last = last || row.nameInCamel === 'Oh noes'
  })

  await sql`
    create table test (
      id serial primary key,
      name_in_camel text
    )
  `

  await sql`insert into test (name_in_camel) values ('Murray')`
  await sql`update test set name_in_camel = 'Rothbard'`
  await sql`delete from test`
  await sql`alter table test replica identity full`
  await sql`insert into test (name_in_camel) values ('Murray')`
  await sql`update test set name_in_camel = 'Rothbard'`
  await sql`delete from test`
  await until(() => result.length >= 18)
  await unsubscribe()
  await sql`insert into test (name_in_camel) values ('Oh noes')`
  await until(() => last)
  await unsubscribeLast()
  return [
    'insert,Murray,,update,Rothbard,,delete,1,,insert,Murray,,update,Rothbard,Murray,delete,Rothbard,',
    result.join(','),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('subscribe reconnects and calls onsubscribe', { timeout: 18 }, async() => {
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false
  })

  await sql.unsafe('create publication alltables for all tables')

  const result = []
  let onsubscribes = 0

  const { unsubscribe, sql: subscribeSql } = await sql.subscribe(
    '*',
    (row, { command, old }) => result.push(command, row.name || row.id, old && old.name),
    () => onsubscribes++
  )

  await sql`
    create table test (
      id serial primary key,
      name text
    )
  `

  await sql`insert into test (name) values ('Murray')`
  await until(() => result.includes('insert'))
  await subscribeSql.close()
  await until(() => onsubscribes >= 2)
  await sql`delete from test`
  await until(() => result.includes('delete'))
  await unsubscribe()
  return [
    '2insert,Murray,,delete,1,',
    onsubscribes + result.join(','),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('Execute', async() => {
  const result = await new Promise((resolve) => {
    const sql = postgres({ ...options, fetch_types: false, debug:(id, query) => resolve(query) })
    sql`select 1`.execute()
  })

  return [result, 'select 1']
})

t('Cancel running query', async() => {
  const query = sql`select pg_sleep(2)`
  setTimeout(() => query.cancel(), 500)
  const error = await query.catch(x => x)
  return ['57014', error.code]
})

t('Cancel piped query', { timeout: 5 }, async() => {
  await sql`select 1`
  const last = sql`select pg_sleep(1)`.execute()
  const query = sql`select pg_sleep(2) as dig`
  setTimeout(() => query.cancel(), 500)
  const error = await query.catch(x => x)
  await last
  return ['57014', error.code]
})

t('Cancel queued query', async() => {
  const query = sql`select pg_sleep(2) as nej`
  const tx = sql.begin(sql => (
    query.cancel(),
    sql`select pg_sleep(0.5) as hej, 'hejsa'`
  ))
  const error = await query.catch(x => x)
  await tx
  return ['57014', error.code]
})

t('Fragments', async() => [
  1,
  (await sql`
    ${ sql`select` } 1 as x
  `)[0].x
])

t('Result becomes array', async() => [
  true,
  (await sql`select 1`).slice() instanceof Array
])

t('Describe', async() => {
  const type = (await sql`select ${ 1 }::int as x`.describe()).types[0]
  return [23, type]
})

t('Describe a statement', async() => {
  await sql`create table tester (name text, age int)`
  const r = await sql`select name, age from tester where name like $1 and age > $2`.describe()
  return [
    '25,23/name:25,age:23',
    `${ r.types.join(',') }/${ r.columns.map(c => `${c.name}:${c.type}`).join(',') }`,
    await sql`drop table tester`
  ]
})

t('Include table oid and column number in column details', async() => {
  await sql`create table tester (name text, age int)`
  const r = await sql`select name, age from tester where name like $1 and age > $2`.describe()
  const [{ oid }] = await sql`select oid from pg_class where relname = 'tester'`

  return [
    `table:${oid},number:1|table:${oid},number:2`,
    `${ r.columns.map(c => `table:${c.table},number:${c.number}`).join('|') }`,
    await sql`drop table tester`
  ]
})

t('Describe a statement without parameters', async() => {
  await sql`create table tester (name text, age int)`
  const r = await sql`select name, age from tester`.describe()
  return [
    '0,2',
    `${ r.types.length },${ r.columns.length }`,
    await sql`drop table tester`
  ]
})

t('Describe a statement without columns', async() => {
  await sql`create table tester (name text, age int)`
  const r = await sql`insert into tester (name, age) values ($1, $2)`.describe()
  return [
    '2,0',
    `${ r.types.length },${ r.columns.length }`,
    await sql`drop table tester`
  ]
})

t('Large object', async() => {
  const file = rel('index.js')
      , md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')

  const lo = await sql.largeObject()
  await new Promise(async r => fs.createReadStream(file).pipe(await lo.writable()).on('finish', r))
  await lo.seek(0)

  const out = crypto.createHash('md5')
  await new Promise(r => lo.readable().then(x => x.on('data', x => out.update(x)).on('end', r)))

  return [
    md5,
    out.digest('hex'),
    await lo.close()
  ]
})

t('Catches type serialize errors', async() => {
  const sql = postgres({
    idle_timeout,
    types: {
      text: {
        from: 25,
        to: 25,
        parse: x => x,
        serialize: () => { throw new Error('watSerialize') }
      }
    }
  })

  return [
    'watSerialize',
    (await sql`select ${ 'wat' }`.catch(e => e.message))
  ]
})

t('Catches type parse errors', async() => {
  const sql = postgres({
    idle_timeout,
    types: {
      text: {
        from: 25,
        to: 25,
        parse: () => { throw new Error('watParse') },
        serialize: x => x
      }
    }
  })

  return [
    'watParse',
    (await sql`select 'wat'`.catch(e => e.message))
  ]
})

t('Catches type serialize errors in transactions', async() => {
  const sql = postgres({
    idle_timeout,
    types: {
      text: {
        from: 25,
        to: 25,
        parse: x => x,
        serialize: () => { throw new Error('watSerialize') }
      }
    }
  })

  return [
    'watSerialize',
    (await sql.begin(sql => (
      sql`select 1`,
      sql`select ${ 'wat' }`
    )).catch(e => e.message))
  ]
})

t('Catches type parse errors in transactions', async() => {
  const sql = postgres({
    idle_timeout,
    types: {
      text: {
        from: 25,
        to: 25,
        parse: () => { throw new Error('watParse') },
        serialize: x => x
      }
    }
  })

  return [
    'watParse',
    (await sql.begin(sql => (
      sql`select 1`,
      sql`select 'wat'`
    )).catch(e => e.message))
  ]
})

t('Prevent premature end of connection in transaction', async() => {
  const sql = postgres({ max_lifetime: 0.01, idle_timeout })
  const result = await sql.begin(async sql => {
    await sql`select 1`
    await delay(20)
    await sql`select 1`
    return 'yay'
  })


  return [
    'yay',
    result
  ]
})

t('Ensure reconnect after max_lifetime with transactions', { timeout: 5 }, async() => {
  const sql = postgres({
    max_lifetime: 0.01,
    idle_timeout,
    max: 1
  })

  let x = 0
  while (x++ < 10) await sql.begin(sql => sql`select 1 as x`)

  return [true, true]
})


t('Ensure transactions throw if connection is closed dwhile there is no query', async() => {
  const sql = postgres(options)
  const x = await sql.begin(async() => {
    setTimeout(() => sql.end({ timeout: 0 }), 10)
    await new Promise(r => setTimeout(r, 200))
    return sql`select 1`
  }).catch(x => x)
  return ['CONNECTION_CLOSED', x.code]
})

t('Custom socket', {}, async() => {
  let result
  const sql = postgres({
    socket: () => new Promise((resolve, reject) => {
      const socket = new net.Socket()
      socket.connect(5432)
      socket.once('data', x => result = x[0])
      socket.on('error', reject)
      socket.on('connect', () => resolve(socket))
    }),
    idle_timeout
  })

  await sql`select 1`

  return [
    result,
    82
  ]
})

t('Ensure drain only dequeues if ready', async() => {
  const sql = postgres(options)

  const res = await Promise.all([
    sql.unsafe('SELECT 0+$1 --' + '.'.repeat(100000), [1]),
    sql.unsafe('SELECT 0+$1+$2+$3', [1, 2, 3])
  ])

  return [res.length, 2]
})

t('Supports fragments as dynamic parameters', async() => {
  await sql`create table test (a int, b bool)`
  await sql`insert into test values(1, true)`
  await sql`insert into test ${
    sql({
      a: 2,
      b: sql`exists(select 1 from test where b = ${ true })`
    })
  }`

  return [
    '1,t2,t',
    (await sql`select * from test`.raw()).join(''),
    await sql`drop table test`
  ]
})

t('Supports nested fragments with parameters', async() => {
  await sql`create table test ${
    sql`(${ sql('a') } ${ sql`int` })`
  }`
  await sql`insert into test values(1)`
  return [
    1,
    (await sql`select a from test`)[0].a,
    await sql`drop table test`
  ]
})

t('Supports multiple nested fragments with parameters', async() => {
  const [{ b }] = await sql`select * ${
    sql`from ${
      sql`(values (2, ${ 1 }::int)) as x(${ sql(['a', 'b']) })`
    }`
  }`
  return [
    1,
    b
  ]
})

t('Supports arrays of fragments', async() => {
  const [{ x }] = await sql`
    ${ [sql`select`, sql`1`, sql`as`, sql`x`] }
  `

  return [
    1,
    x
  ]
})

t('Does not try rollback when commit errors', async() => {
  let notice = null
  const sql = postgres({ ...options, onnotice: x => notice = x })
  await sql`create table test(x int constraint test_constraint unique deferrable initially deferred)`

  await sql.begin('isolation level serializable', async sql => {
    await sql`insert into test values(1)`
    await sql`insert into test values(1)`
  }).catch(e => e)

  return [
    notice,
    null,
    await sql`drop table test`
  ]
})

t('Last keyword used even with duplicate keywords', async() => {
  await sql`create table test (x int)`
  await sql`insert into test values(1)`
  const [{ x }] = await sql`
    select
      1 in (1) as x
    from test
    where x in ${ sql([1, 2]) }
  `

  return [x, true, await sql`drop table test`]
})

t('Insert array with null', async() => {
  await sql`create table test (x int[])`
  await sql`insert into test ${ sql({ x: [1, null, 3] }) }`
  return [
    1,
    (await sql`select x from test`)[0].x[0],
    await sql`drop table test`
  ]
})

t('Insert array with undefined throws', async() => {
  await sql`create table test (x int[])`
  return [
    'UNDEFINED_VALUE',
    await sql`insert into test ${ sql({ x: [1, undefined, 3] }) }`.catch(e => e.code),
    await sql`drop table test`
  ]
})

t('Insert array with undefined transform', async() => {
  const sql = postgres({ ...options, transform: { undefined: null } })
  await sql`create table test (x int[])`
  await sql`insert into test ${ sql({ x: [1, undefined, 3] }) }`
  return [
    1,
    (await sql`select x from test`)[0].x[0],
    await sql`drop table test`
  ]
})

t('concurrent cursors', async() => {
  const xs = []

  await Promise.all([...Array(7)].map((x, i) => [
    sql`select ${ i }::int as a, generate_series(1, 2) as x`.cursor(([x]) => xs.push(x.a + x.x))
  ]).flat())

  return ['12233445566778', xs.join('')]
})

t('concurrent cursors multiple connections', async() => {
  const sql = postgres({ ...options, max: 2 })
  const xs = []

  await Promise.all([...Array(7)].map((x, i) => [
    sql`select ${ i }::int as a, generate_series(1, 2) as x`.cursor(([x]) => xs.push(x.a + x.x))
  ]).flat())

  return ['12233445566778', xs.sort().join('')]
})

t('reserve connection', async() => {
  const reserved = await sql.reserve()

  setTimeout(() => reserved.release(), 510)

  const xs = await Promise.all([
    reserved`select 1 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
    sql`select 2 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
    reserved`select 3 as x`.then(([{ x }]) => ({ time: Date.now(), x }))
  ])

  if (xs[1].time - xs[2].time < 500)
    throw new Error('Wrong time')

  return [
    '123',
    xs.map(x => x.x).join('')
  ]
})

t('arrays in reserved connection', async() => {
  const reserved = await sql.reserve()
  const [{ x }] = await reserved`select array[1, 2, 3] as x`
  reserved.release()

  return [
    '123',
    x.join('')
  ]
})

t('Ensure reserve on query throws proper error', async() => {
  const sql = postgres({ idle_timeout }) // eslint-disable-line
  const reserved = await sql.reserve()
  const [{ x }] = await reserved`select 'wat' as x`

  return [
    'wat', x, reserved.release()
  ]
})

t('a query awaited before ending its own copy from stdin with max: 1 rejects with COPY_IN_PROGRESS', { timeout: 10 }, async() => {
  const sql = postgres(options) // eslint-disable-line
  await sql`create table test (id serial primary key, name text)`
  const copy = await sql`copy test (name) from stdin`.writable()
  const next = await Promise.race([
    sql`select 1 as x`.then(x => x[0].x, e => e.code),
    delay(2000).then(() => 'hung')
  ])
  await new Promise(r => copy.end('a\n', r))
  const count = await sql`select count(*)::int as n from test`.then(x => x[0].n)
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['COPY_IN_PROGRESS', 1]),
    JSON.stringify([next, count])
  ]
})

t('sql.reserve() and sql.begin() reject with COPY_IN_PROGRESS while every connection runs a copy that was not ended', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  const copy = await sql`copy test from stdin`.writable()
  const results = await Promise.race([
    Promise.all([
      sql.reserve().then(() => 'reserved', e => e.code),
      sql.begin(tx => tx`select 1`).then(() => 'committed', e => e.code)
    ]),
    delay(2000).then(() => 'hung')
  ])
  await new Promise(r => copy.end('1\n', r))
  const count = await sql`select count(*)::int as n from test`.then(x => x[0].n)
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify([['COPY_IN_PROGRESS', 'COPY_IN_PROGRESS'], 1]),
    JSON.stringify([results, count])
  ]
})

t('a query awaited before reading its own copy to stdout with max: 1 rejects with COPY_IN_PROGRESS', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  const readable = await sql`copy (select generate_series(1, 1000000)) to stdout`.readable()
  await delay(100)
  const next = await Promise.race([
    sql`select 1 as x`.then(x => x[0].x, e => e.code),
    delay(2000).then(() => 'hung')
  ])
  let lines = 0
  for await (const chunk of readable)
    lines += chunk.toString().split('\n').length - 1
  const after = await sql`select 2 as x`.then(x => x[0].x)
  await sql.end()

  return [
    JSON.stringify(['COPY_IN_PROGRESS', 1000000, 2]),
    JSON.stringify([next, lines, after])
  ]
})

t('a query sent after copy from stdin was ended waits for the copy', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  const copy = await sql`copy test from stdin`.writable()
  const finished = new Promise(r => copy.on('finish', r))
  copy.end('1\n')
  const next = await Promise.race([
    sql`select count(*)::int as n from test`.then(x => x[0].n, e => e.code),
    delay(2000).then(() => 'hung')
  ])
  await finished
  await sql`drop table test`
  await sql.end()

  return [1, next]
})

t('a query sent while one connection runs a copy and the other is reserved waits for the reserved one', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 2 })
  await sql`create table test (x int)`
  const reserved = await sql.reserve()
  const copy = await sql`copy test from stdin`.writable()
  let settled = false
  const next = sql`select 7 as x`.then(x => (settled = true, x[0].x), e => (settled = true, e.code))
  await delay(100)
  const waited = !settled
  reserved.release()
  const result = await Promise.race([next, delay(2000).then(() => 'hung')])
  await new Promise(r => copy.end('1\n', r))
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify([true, 7]),
    JSON.stringify([waited, result])
  ]
})

const idleStats = { executingCount: 0, waitingCount: 0 }
const pick = ({ executingCount, waitingCount }) => ({ executingCount, waitingCount })

const noop = () => undefined
const within = (promise, label, ms = 2000) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, label) })]).finally(() => clearTimeout(timer))
}

async function until(done, ms = 5000) {
  for (const end = Date.now() + ms; !done() && Date.now() < end;)
    await delay(10)
}

async function backendsLeft(application_name) {
  let left = -1
  for (const end = Date.now() + 5000; left !== 0 && Date.now() < end;) {
    left = (await sql`select count(*)::int as n from pg_stat_activity where application_name = ${ application_name }`)[0].n
    left && await delay(20)
  }
  return left
}

async function uncaught(fn) {
  const errors = []
  const capture = e => errors.push(e)
  const dispatched = e => (e.preventDefault(), errors.push(e.error))
  globalThis.addEventListener
    ? globalThis.addEventListener('error', dispatched)
    : process.on('uncaughtException', capture)
  try {
    const result = await fn(errors)
    await delay(50)
    return [result, errors]
  } finally {
    globalThis.addEventListener
      ? globalThis.removeEventListener('error', dispatched)
      : process.off('uncaughtException', capture)
  }
}

t('a query that fails to build rejects alone and does not shift pipelined responses', async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`select 1`
  const a = sql`select pg_sleep(0.2) as a`.execute().catch(e => e.code)
  const b = sql.unsafe('select 1', Array(70000).fill(1)).execute().catch(e => e.code)
  await delay(500)
  const c = sql`select 2 as c`.execute().catch(e => e.code)
  const results = await Promise.all([a, b, c])
  await delay(50)
  const stats = pick(sql.stats())
  await sql.end()

  return [
    JSON.stringify([[{ a: '' }], 'MAX_PARAMETERS_EXCEEDED', [{ c: 2 }], idleStats]),
    JSON.stringify([...results, stats])
  ]
})

t('a query that fails to build in the middle of pipelined queries leaves the others intact', async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`select 1`
  const results = await Promise.all([
    sql`select pg_sleep(0.1), 1 as x`.then(x => x[0].x, e => e.code),
    sql.unsafe('select 1', Array(70000).fill(1)).then(x => x, e => e.code),
    sql`select 3 as x`.then(x => x[0].x, e => e.code),
    sql`select 4 as x`.then(x => x[0].x, e => e.code)
  ])
  await delay(50)
  const stats = pick(sql.stats())
  await sql.end()

  return [
    JSON.stringify([1, 'MAX_PARAMETERS_EXCEEDED', 3, 4, idleStats]),
    JSON.stringify([...results, stats])
  ]
})

t('a query that fails to build on a reserved connection leaves the others intact', async() => {
  const sql = postgres({ ...options, max: 1 })
  const reserved = await sql.reserve()
  const results = await Promise.all([
    reserved`select pg_sleep(0.1), 1 as x`.then(x => x[0].x, e => e.code),
    reserved.unsafe('select 1', Array(70000).fill(1)).then(x => x, e => e.code),
    reserved`select 3 as x`.then(x => x[0].x, e => e.code),
    reserved`select 4 as x`.then(x => x[0].x, e => e.code)
  ])
  const held = pick(reserved.stats())
  reserved.release()
  await delay(50)
  const stats = pick(sql.stats())
  await sql.end()

  return [
    JSON.stringify([1, 'MAX_PARAMETERS_EXCEEDED', 3, 4, idleStats, idleStats]),
    JSON.stringify([...results, held, stats])
  ]
})

t('a throwing debug callback is rethrown as an uncaught exception and its query runs', async() => {
  const sentinel = new Error('debug sentinel')
  const sql = postgres({ ...options, max: 1, fetch_types: false, debug: () => { throw sentinel } })
  const [results, errors] = await uncaught(async() => {
    const first = await sql`select 1 as x`.then(x => x[0].x, e => e.message)
    const second = await sql`select 2 as x`.then(x => x[0].x, e => e.message)
    await delay(50)
    const stats = pick(sql.stats())
    await sql.end()
    return [first, second, stats]
  })

  return [
    JSON.stringify([1, 2, idleStats, 2, true]),
    JSON.stringify([...results, errors.length, errors.every(e => e === sentinel)])
  ]
})

t('stats return to idle after a query fails to build on an idle connection', async() => {
  const sql = postgres({ ...options, max: 1 })
  const code = await sql.unsafe('select 1', Array(70000).fill(1)).catch(e => e.code)
  await delay(50)
  const stats = pick(sql.stats())
  const next = await sql`select 5 as x`
  await sql.end()

  return [
    JSON.stringify(['MAX_PARAMETERS_EXCEEDED', idleStats, [{ x: 5 }]]),
    JSON.stringify([code, stats, next])
  ]
})

t('a throwing debug callback behind a running query leaves every query its own result', async() => {
  const sentinel = new Error('debug sentinel')
  const sql = postgres({
    ...options,
    max: 1,
    fetch_types: false,
    debug: (id, string) => {
      if (string.includes('throw_me'))
        throw sentinel
    }
  })
  await sql`select 1`
  const [results, errors] = await uncaught(async() => {
    const results = await Promise.all([
      sql`select pg_sleep(0.1), 1 as x`.then(x => x[0].x, e => e.message),
      sql`select 2 as throw_me`.then(x => x[0].throw_me, e => e.message),
      sql`select 3 as x`.then(x => x[0].x, e => e.message)
    ])
    await delay(50)
    const stats = pick(sql.stats())
    await sql.end()
    return [...results, stats]
  })

  return [
    JSON.stringify([1, 2, 3, idleStats, 1, true]),
    JSON.stringify([...results, errors.length, errors.every(e => e === sentinel)])
  ]
})

t('a query that fails to build behind copy from stdin leaves copy and later queries intact', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  const copy = sql`copy test from stdin`.simple()
  copy.streaming = true
  copy.execute()
  const failed = sql.unsafe('select 1', Array(70000).fill(1)).then(x => x, e => e.code)
  const writable = await copy
  writable.write('1\n')
  writable.end('2\n')
  await new Promise(r => writable.on('finish', r))
  const results = await Promise.race([
    Promise.all([failed, sql`select 7 as x`.then(x => x[0].x, e => e), sql`select count(*)::int as n from test`.then(x => x[0].n, e => e)]),
    delay(2000).then(() => 'hung')
  ])
  await delay(50)
  const stats = pick(sql.stats())
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['MAX_PARAMETERS_EXCEEDED', 7, 2, idleStats]),
    JSON.stringify([...results, stats])
  ]
})

t('an undefined value in a transaction rejects with UNDEFINED_VALUE and the pool keeps working', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  const error = await within(sql.begin(sql => [sql`select 1`, sql`select ${ undefined }`]).catch(e => e.code), 'begin hung')
  const next = await within(sql`select 5 as x`.then(x => x[0].x, e => e.code), 'next query hung')
  const ended = await within(sql.end().then(() => 'ended'), 'end hung')

  return [
    JSON.stringify(['UNDEFINED_VALUE', 5, 'ended']),
    JSON.stringify([error, next, ended])
  ]
})

t('an undefined value behind a running query rejects alone', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`select 1`
  const results = await Promise.all([
    within(sql`select pg_sleep(0.1), 1 as x`.then(x => x[0].x, e => e.code), 'first query hung'),
    within(sql`select ${ undefined } as x`.then(x => x[0].x, e => e.code), 'second query hung'),
    within(sql`select 3 as x`.then(x => x[0].x, e => e.code), 'third query hung')
  ])
  const ended = await within(sql.end().then(() => 'ended'), 'end hung')

  return [
    JSON.stringify([1, 'UNDEFINED_VALUE', 3, 'ended']),
    JSON.stringify([...results, ended])
  ]
})

t('an undefined value behind a running query leaves the pool idle', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`select 1`
  const results = await Promise.all([
    within(sql`select pg_sleep(0.1), 1 as x`.then(x => x[0].x, e => e.code), 'first query hung'),
    within(sql`select ${ undefined } as x`.then(x => x[0].x, e => e.code), 'second query hung'),
    within(sql`select 3 as x`.then(x => x[0].x, e => e.code), 'third query hung')
  ])
  await delay(50)
  const stats = pick(sql.stats())
  await sql.end()

  return [
    JSON.stringify([1, 'UNDEFINED_VALUE', 3, idleStats]),
    JSON.stringify([...results, stats])
  ]
})

t('a retried query whose rebuild throws rejects alone', { timeout: 10 }, async() => {
  let reads = 0
  const row = { get x() { return ++reads === 3 ? undefined : 1 } }
  const sql = postgres({ ...options, max: 1, fetch_types: false })
  const select = () => sql`select name as retry_me, ${ sql(row, 'x') } from test`
  await sql`create table test (name text)`
  await sql`insert into test values ('1')`
  await select()
  await sql`alter table test alter column name type int using name::integer`
  const error = await Promise.race([select().catch(e => e), delay(2000).then(() => 'hung')])
  const next = await Promise.race([sql`select 5 as x`.then(x => x[0].x, e => e.code), delay(2000).then(() => 'hung')])
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['UNDEFINED_VALUE', 5]),
    JSON.stringify([error.code, next])
  ]
})

t('a throwing debug callback during type discovery still registers array types', async() => {
  const sentinel = new Error('debug sentinel')
  const sql = postgres({
    ...options,
    max: 1,
    debug: (id, string) => {
      if (string.includes('pg_catalog.pg_type'))
        throw sentinel
    }
  })
  const [value, errors] = await uncaught(async() => {
    const [row] = await sql`select array[1, 2]::int[] as x`
    await sql.end()
    return row.x
  })

  return [
    JSON.stringify([[1, 2], 1, true]),
    JSON.stringify([value, errors.length, errors.every(e => e === sentinel)])
  ]
})

t('a throwing backoff function is rethrown as an uncaught exception and the connection still closes', { timeout: 10 }, async() => {
  const sentinel = new Error('backoff sentinel')
  const sql = postgres({ ...options, max: 1, backoff: () => { throw sentinel } })
  const [results, errors] = await uncaught(async() => {
    const reserved = await sql.reserve()
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`
    const queued = sql`select 3 as x`.then(x => x[0].x, e => e.code)
    const other = postgres(options)
    await other`select pg_terminate_backend(${ pid })`
    await other.end()
    const result = await Promise.race([queued, delay(3000).then(() => 'hung')])
    reserved.release()
    await sql.end({ timeout: 1 })
    return result
  })

  return [
    JSON.stringify([3, true]),
    JSON.stringify([results, errors.length === 1 && errors[0] === sentinel])
  ]
})

t('a throwing onnotice callback is rethrown as an uncaught exception and its query succeeds', async() => {
  const sentinel = new Error('onnotice sentinel')
  const sql = postgres({ ...options, max: 1, fetch_types: false, onnotice: () => { throw sentinel } })
  await sql`select 1`
  const [results, errors] = await uncaught(async() => {
    const results = await Promise.all([
      sql`select pg_sleep(0.05), 1 as x`.then(x => x[0].x, e => e.message),
      sql`do $$ begin raise notice 'onnotice'; end $$`.then(x => x.command, e => e.message),
      sql`select 3 as x`.then(x => x[0].x, e => e.message)
    ])
    await sql.end()
    return results
  })

  return [
    JSON.stringify([1, 'DO', 3, 1, true]),
    JSON.stringify([...results, errors.length, errors.every(e => e === sentinel)])
  ]
})

t('a throwing onparameter callback is rethrown as an uncaught exception and sessions start', async() => {
  const sentinel = new Error('onparameter sentinel')
  const sql = postgres({ ...options, max: 1, fetch_types: false, onparameter: () => { throw sentinel } })
  const [results, errors] = await uncaught(async() => {
    const first = await sql`select 1 as x`.then(x => x[0].x, e => e.message)
    const set = await sql`set application_name = 'onparameter_throw'`.then(x => x.command, e => e.message)
    const next = await sql`select 3 as x`.then(x => x[0].x, e => e.message)
    const name = sql.parameters.application_name
    await sql.end()
    return [first, set, next, name]
  })

  return [
    JSON.stringify([1, 'SET', 3, 'onparameter_throw', true, true]),
    JSON.stringify([...results, errors.length > 1, errors.every(e => e === sentinel)])
  ]
})

t('a throwing onnotify callback is rethrown as an uncaught exception and its query succeeds', async() => {
  const sentinel = new Error('onnotify sentinel')
  const sql = postgres({ ...options, max: 1, fetch_types: false, onnotify: () => { throw sentinel } })
  const [results, errors] = await uncaught(async() => {
    await sql`listen onnotify_throw`
    const notify = await sql`notify onnotify_throw, 'x'`.then(x => x.command, e => e.message)
    const next = await sql`select 2 as x`.then(x => x[0].x, e => e.message)
    await sql.end()
    return [notify, next]
  })

  return [
    JSON.stringify(['NOTIFY', 2, 1, true]),
    JSON.stringify([...results, errors.length, errors.every(e => e === sentinel)])
  ]
})

t('a throwing onclose callback does not strand a query queued for the closed connection', { timeout: 5 }, async() => {
  const sentinel = new Error('onclose sentinel')
  const sql = postgres(options)
  const pool = postgres({ ...options, max: 1, fetch_types: false, onclose: () => { throw sentinel } })
  const [result, errors] = await uncaught(async() => {
    const reserved = await pool.reserve()
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`
    const queued = pool`select 7 as x`.then(x => x[0].x, e => e.code)
    await sql`select pg_terminate_backend(${ pid })`
    const x = await Promise.race([queued, delay(1000).then(() => 'hung')])
    await pool.end()
    return x
  })
  await sql.end()

  return [
    JSON.stringify([7, 2, true]),
    JSON.stringify([result, errors.length, errors.every(e => e === sentinel)])
  ]
})

t('a throwing listen callback does not stop the other listeners on its channel', async() => {
  const sentinel = new Error('listen sentinel')
  const pool = postgres({ ...options, max: 1, fetch_types: false })
  const xs = []
  const [, errors] = await uncaught(async() => {
    await pool.listen('listen_throw', () => { throw sentinel })
    await pool.listen('listen_throw', x => xs.push(x))
    await pool.notify('listen_throw', 'a')
    await delay(50)
    await pool.end()
  })

  return [
    'a 1 true',
    [xs.join(''), errors.length, errors.every(e => e === sentinel)].join(' ')
  ]
})

t('a throwing onlisten callback is rethrown as an uncaught exception on listen and on reconnect', { timeout: 4 }, async() => {
  const sentinel = new Error('onlisten sentinel')
  const sql = postgres(options)
  const pool = postgres({ ...options, max: 1, fetch_types: false })
  const xs = []
  const [result, errors] = await uncaught(async captured => {
    const first = await pool.listen('onlisten_throw', x => xs.push(x), () => { throw sentinel }).catch(e => e)
    const second = await pool.listen('onlisten_throw', noop, () => { throw sentinel }).catch(e => e)
    await pool.notify('onlisten_throw', 'a')
    await delay(50)
    first.state && await sql`select pg_terminate_backend(${ first.state.pid })`
    for (let i = 0; i < 200 && captured.length < 4; i++)
      await delay(10)
    await pool.notify('onlisten_throw', 'b')
    await delay(50)
    await pool.end()
    return typeof first.unlisten + ' ' + typeof second.unlisten
  })
  await sql.end()

  return [
    'function function ab 4 true',
    [result, xs.join(''), errors.length, errors.every(e => e === sentinel)].join(' ')
  ]
})

t('a throwing subscribe callback does not stop other subscribers or the replication stream', { timeout: 13 }, async() => {
  const sentinel = new Error('subscribe sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`

  const xs = []
  const [, errors] = await uncaught(async() => {
    await sql.subscribe('insert:test', () => { throw sentinel })
    await sql.subscribe('insert:test', row => xs.push(row.name))
    await sql`insert into test (name) values ('a')`
    await until(() => xs.length > 0)
    await sql`insert into test (name) values ('b')`
    await until(() => xs.length >= 2)
  })

  return [
    'ab 2 true',
    [xs.join(''), errors.length, errors.every(e => e === sentinel)].join(' '),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a throwing onsubscribe callback is rethrown as an uncaught exception on subscribe and on reconnect', { timeout: 8 }, async() => {
  const sentinel = new Error('onsubscribe sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false
  })

  await sql.unsafe('create publication alltables for all tables')

  const subscribes = []
  const [result, errors] = await uncaught(async() => {
    const subscription = await sql.subscribe('*', noop, () => { throw sentinel }).catch(e => e)
    const { sql: subscribeSql } = await sql.subscribe('*', noop, () => subscribes.push(1))
    await subscribeSql.close()
    await until(() => subscribes.length >= 2)
    return typeof subscription.unsubscribe
  })

  return [
    'function 2 2 true',
    [result, subscribes.length, errors.length, errors.every(e => e === sentinel)].join(' '),
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a throwing transform skips the change and calls onerror without restarting the replication stream', { timeout: 8 }, async() => {
  const sentinel = new Error('transform sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      row: {
        from: row => {
          if (row.name === 'bad')
            throw sentinel
          return row
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`

  const xs = []
  const errors = []
  const { state } = await sql.subscribe('insert:test', row => xs.push(row.name), noop, e => errors.push(e))
  const pid = state.pid
  await sql`insert into test (name) values ('bad')`
  await sql`insert into test (name) values ('good')`
  await until(() => xs.length > 0)

  return [
    'good 1 true true',
    [xs.join(), errors.length, errors[0] === sentinel, state.pid === pid].join(' '),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a throwing transform is rethrown once as an uncaught exception when a subscriber of the change has no onerror', { timeout: 8 }, async() => {
  const sentinel = new Error('transform sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      row: {
        from: row => {
          if (row.name === 'bad')
            throw sentinel
          return row
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`

  const xs = []
  const errors = []
  const [same, thrown] = await uncaught(async() => {
    const { state } = await sql.subscribe('insert:test', row => xs.push(row.name))
    await sql.subscribe('*', noop)
    await sql.subscribe('*:test', noop, noop, e => errors.push(e))
    const pid = state.pid
    await sql`insert into test (name) values ('bad')`
    await sql`insert into test (name) values ('good')`
    await until(() => xs.length > 0)
    return state.pid === pid
  })

  return [
    'good 1 true 1 true',
    [xs.join(), thrown.length, thrown.every(e => e === sentinel), errors.length, same].join(' '),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a transform error does not reach subscribers of another table, another operation or that unsubscribed', { timeout: 8 }, async() => {
  const sentinel = new Error('transform sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      row: {
        from: row => {
          if (row.name === 'bad')
            throw sentinel
          return row
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`
  await sql`create table other (id serial primary key, name text)`

  const xs = []
  const errors = []
  const [, thrown] = await uncaught(async() => {
    await sql.subscribe('*:other', row => xs.push(row.name))
    await sql.subscribe('delete:test', noop)
    await sql.subscribe('update', noop, noop, () => errors.push('update'))
    await sql.subscribe('insert:other', noop, noop, () => errors.push('other'))
    const { unsubscribe } = await sql.subscribe('insert:test', noop, noop, () => errors.push('unsubscribed'))
    await sql.subscribe('insert:test', noop, noop, () => errors.push('test'))
    unsubscribe()
    await sql`insert into test (name) values ('bad')`
    await sql`insert into other (name) values ('good')`
    await until(() => xs.length > 0)
  })

  return [
    'good test 0',
    [xs.join(), errors.join(), thrown.length].join(' '),
    await sql`drop table test`,
    await sql`drop table other`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('subscribers filtered by key get the transform errors of their table', { timeout: 8 }, async() => {
  const sentinel = new Error('transform sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      value: {
        from: x => {
          if (x === 'bad')
            throw sentinel
          return x
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`
  await sql`insert into test (name) values ('a'), ('b')`

  const xs = []
  const errors = []
  const { state } = await sql.subscribe('update:test=1', row => xs.push(row.name), noop, e => errors.push(e === sentinel && 1))
  await sql.subscribe('update:test=2', noop, noop, e => errors.push(e === sentinel && 2))
  const pid = state.pid
  await sql`update test set name = 'bad' where id = 1`
  await sql`update test set name = 'good' where id = 1`
  await until(() => xs.length > 0)

  return [
    'good 1,2 true',
    [xs.join(), errors.join(), state.pid === pid].join(' '),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('onerror gets transform and connection errors after the replication stream reconnects', { timeout: 18 }, async() => {
  const sentinel = new Error('transform sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      row: {
        from: row => {
          if (row.name === 'bad')
            throw sentinel
          return row
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`

  const xs = []
  const errors = []
  const logged = []
  const error = globalThis.console.error
  globalThis.console.error = x => logged.push(x)
  const subscribes = []
  try {
    const { state } = await sql.subscribe(
      'insert:test',
      row => xs.push(row.name),
      () => subscribes.push(1),
      e => errors.push(e === sentinel ? 'sentinel' : e.code)
    )
    await sql`select pg_terminate_backend(${ state.pid })`
    await until(() => subscribes.length >= 2)
    await sql`insert into test (name) values ('bad')`
    await sql`insert into test (name) values ('good')`
    await until(() => xs.length > 0)
    await sql`select pg_terminate_backend(${ state.pid })`
    await until(() => subscribes.length >= 3)
  } finally {
    globalThis.console.error = error
  }

  return [
    'good 3 CONNECTION_CLOSED,sentinel,CONNECTION_CLOSED 2',
    [xs.join(), subscribes.length, errors.join(), logged.length].join(' '),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('subscribing and unsubscribing leaves no error listeners behind', { timeout: 20 }, async() => {
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false
  })
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })

  await admin.unsafe('create publication alltables for all tables')
  await admin`create table test (id serial primary key, name text)`

  const warnings = []
  const onwarning = w => warnings.push(w.name)
  process.on('warning', onwarning)
  const stale = []
  const live = []
  const error = globalThis.console.error
  globalThis.console.error = noop
  let cycles = 0
  let liveCalled
  let ended
  try {
    for (let i = 0; i < 20; i++) {
      const subscription = await within(sql.subscribe('insert:test', noop, noop, e => stale.push(e)), 'subscribe hung', 5000)
      if (subscription === 'subscribe hung')
        break
      subscription.unsubscribe()
      cycles++
    }
    const subscription = await within(sql.subscribe('insert:test', noop, noop, e => live.push(e)), 'live subscribe hung', 5000)
    if (subscription.state) {
      await delay(50)
      await admin`select pg_terminate_backend(${ subscription.state.pid })`
      await until(() => live.length > 0)
      liveCalled = live.length > 0 ? 'called' : 'live onerror not called'
    } else {
      liveCalled = subscription
    }
    await delay(200)
    ended = await within(sql.end().then(() => 'ended'), 'end hung', 3000)
  } finally {
    globalThis.console.error = error
    process.off('warning', onwarning)
  }
  await admin.unsafe('drop publication alltables')
  await admin`drop table test`
  await admin.end()

  return [
    JSON.stringify([20, 0, 1, 0, 'called', 'ended']),
    JSON.stringify([cycles, stale.length, live.length, warnings.filter(x => x === 'MaxListenersExceededWarning').length, liveCalled, ended])
  ]
})

const releaseReplication = admin => admin`
  select pg_terminate_backend(active_pid) from pg_replication_slots where active_pid is not null
`

t('sql.end() while sql.subscribe() reconnects ends the new replication connection and rejects nothing', { timeout: 18 }, async() => {
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
  await admin.unsafe('create publication alltables for all tables')

  const results = []
  const error = globalThis.console.error
  globalThis.console.error = noop
  try {
    const [, errors] = await uncaught(async() => {
      for (const step of ['CREATE_REPLICATION_SLOT', 'START_REPLICATION']) {
        let sent = 0
        let ending = null
        const sql = postgres({
          database: 'postgres_js_test',
          publications: 'alltables',
          fetch_types: false,
          debug: (id, query) => query.startsWith(step) && ++sent === 2 && (ending = sql.end())
        })
        const { state } = await sql.subscribe('*', noop, noop, noop)
        await admin`select pg_terminate_backend(${ state.pid })`
        await until(() => ending)
        const result = await Promise.race([
          ending ? ending.then(() => 'ended') : 'not ending',
          delay(2000).then(() => 'hung')
        ])
        result === 'ended' || await releaseReplication(admin)
        results.push(result)
      }
    })
    results.push(errors.length)
  } finally {
    globalThis.console.error = error
  }

  return [
    'ended ended 0',
    results.join(' '),
    await admin`drop publication alltables`,
    await admin.end()
  ]
})

t('a subscription made after a reconnect uses the new replication connection and sql.end() ends it', { timeout: 16 }, async() => {
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
  await admin.unsafe('create publication alltables for all tables')
  await admin`create table test (id serial primary key, name text)`

  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false
  })

  const xs = []
  const subscribes = []
  const error = globalThis.console.error
  globalThis.console.error = noop
  let result
  try {
    const { state } = await sql.subscribe('insert:test', noop, () => subscribes.push(1), noop)
    await admin`select pg_terminate_backend(${ state.pid })`
    await until(() => subscribes.length >= 2)
    await sql.subscribe('insert:test', row => xs.push(row.name))
    await admin`insert into test (name) values ('a')`
    await until(() => xs.length > 0)
    result = [xs.join(), subscribes.length]
    result.push(await Promise.race([
      sql.end().then(() => 'ended'),
      delay(2000).then(() => 'hung')
    ]))
    result[2] === 'ended' || await releaseReplication(admin)
  } finally {
    globalThis.console.error = error
  }

  return [
    'a 2 ended',
    result.join(' '),
    await admin`drop table test`,
    await admin`drop publication alltables`,
    await admin.end()
  ]
})

function holdReplicationSlots(admin) {
  const names = []
  const hold = { on: true }
  let full
  const filled = new Promise(resolve => full = resolve)
  const loop = (async() => {
    while (hold.on) {
      try {
        const name = 'fill' + names.length
        await admin`select pg_create_logical_replication_slot(${ name }, 'pgoutput')`
        names.push(name)
      } catch (e) {
        if (e.code !== '53400')
          throw e
        full()
        await new Promise(setImmediate)
      }
    }
  })()
  loop.catch(noop)

  const release = async() => {
    hold.on = false
    await loop
    for (const name of names)
      await admin`select pg_drop_replication_slot(${ name })`
  }
  release.full = filled
  return release
}

t('a rejected sql.subscribe() while the replication connection cannot be restored is the only signal its caller gets', { timeout: 18 }, async() => {
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
  await admin.unsafe('create publication alltables for all tables')
  await admin`create table test (id serial primary key, name text)`

  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    backoff: 0.2
  })

  const xs = []
  const late = []
  const errors = []
  const lateErrors = []
  const subscribes = []
  const lateSubscribes = []
  const error = globalThis.console.error
  globalThis.console.error = noop
  let rejected
  let uncaughts
  let release
  try {
    [, uncaughts] = await uncaught(async() => {
      const { state } = await sql.subscribe('insert:test', row => xs.push(row.name), () => subscribes.push(1), e => errors.push(e.code))
      release = holdReplicationSlots(admin)
      await release.full
      await admin`select pg_terminate_backend(${ state.pid })`
      await until(() => errors.includes('53400'))
      rejected = await sql.subscribe(
        'insert:test',
        row => late.push(row.name),
        () => lateSubscribes.push(1),
        e => lateErrors.push(e.code)
      ).catch(e => e.code)
      await until(() => errors.filter(x => x === '53400').length > 2)
      await release()
      release = null
      await until(() => subscribes.length > 1)
      await admin`insert into test (name) values ('a')`
      await until(() => xs.length > 0)
    })
  } finally {
    globalThis.console.error = error
    release && await release()
  }

  return [
    JSON.stringify(['53400', 2, 'a', 0, 0, 0, 0]),
    JSON.stringify([rejected, subscribes.length, xs.join(), late.length, lateErrors.length, lateSubscribes.length, uncaughts.length]),
    await sql.end(),
    await admin`drop table test`,
    await admin`drop publication alltables`,
    await admin.end()
  ]
})

t('a failed reconnect of sql.subscribe() is retried until it succeeds and a later sql.subscribe() works', { timeout: 18 }, async() => {
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
  await admin.unsafe('create publication alltables for all tables')
  await admin`create table test (id serial primary key, name text)`

  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    backoff: 0.2
  })

  const xs = []
  const ys = []
  const errors = []
  const subscribes = []
  const error = globalThis.console.error
  globalThis.console.error = noop
  let release
  let again
  try {
    const { state } = await sql.subscribe('insert:test', row => xs.push(row.name), () => subscribes.push(1), e => errors.push(e.code))
    release = holdReplicationSlots(admin)
    await release.full
    await admin`select pg_terminate_backend(${ state.pid })`
    await until(() => errors.filter(x => x === '53400').length > 1)
    await release()
    release = null
    await until(() => subscribes.length > 1)
    await admin`insert into test (name) values ('a')`
    await until(() => xs.length > 0)
    again = await sql.subscribe('insert:test', row => ys.push(row.name)).then(() => 'subscribed', e => e.code)
    await admin`insert into test (name) values ('b')`
    await until(() => ys.length > 0)
  } finally {
    globalThis.console.error = error
    release && await release()
  }

  return [
    JSON.stringify([true, 2, 'a,b', 'subscribed', 'b']),
    JSON.stringify([errors.filter(x => x === '53400').length > 1, subscribes.length, xs.join(), again, ys.join()]),
    await sql.end(),
    await admin`drop table test`,
    await admin`drop publication alltables`,
    await admin.end()
  ]
})

t('a failed reconnect of sql.subscribe() is logged and never rethrown for a subscriber without onerror', { timeout: 18 }, async() => {
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
  await admin.unsafe('create publication alltables for all tables')
  await admin`create table test (id serial primary key, name text)`

  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    backoff: 0.2
  })

  const xs = []
  const logged = []
  const subscribes = []
  const error = globalThis.console.error
  globalThis.console.error = (message, e) => logged.push(e && e.code)
  let release
  let uncaughts
  try {
    [, uncaughts] = await uncaught(async() => {
      const { state } = await sql.subscribe('insert:test', row => xs.push(row.name), () => subscribes.push(1))
      release = holdReplicationSlots(admin)
      await release.full
      await admin`select pg_terminate_backend(${ state.pid })`
      await until(() => logged.filter(x => x === '53400').length > 1)
      await release()
      release = null
      await until(() => subscribes.length > 1)
      await admin`insert into test (name) values ('a')`
      await until(() => xs.length > 0)
    })
  } finally {
    globalThis.console.error = error
    release && await release()
  }

  return [
    JSON.stringify([0, true, 2, 'a']),
    JSON.stringify([uncaughts.length, logged.filter(x => x === '53400').length > 1, subscribes.length, xs.join()]),
    await sql.end(),
    await admin`drop table test`,
    await admin`drop publication alltables`,
    await admin.end()
  ]
})

t('a subscription made while sql.subscribe() reconnects calls onsubscribe once', { timeout: 13 }, async() => {
  const admin = postgres({ database: 'postgres_js_test', fetch_types: false })
  await admin.unsafe('create publication alltables for all tables')

  let sent = 0
  let during
  const subscribes = []
  const lateSubscribes = []
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    debug: (id, query) => query.startsWith('CREATE_REPLICATION_SLOT') && ++sent === 2 &&
      (during = sql.subscribe('*', noop, () => lateSubscribes.push(1), noop))
  })

  const error = globalThis.console.error
  globalThis.console.error = noop
  try {
    const { state } = await sql.subscribe('*', noop, () => subscribes.push(1), noop)
    await admin`select pg_terminate_backend(${ state.pid })`
    await until(() => during)
    await during
    await until(() => subscribes.length > 1)
    await admin`select 1`
  } finally {
    globalThis.console.error = error
  }

  return [
    JSON.stringify([2, 1]),
    JSON.stringify([subscribes.length, lateSubscribes.length]),
    await sql.end(),
    await admin`drop publication alltables`,
    await admin.end()
  ]
})

t('a throwing column transform skips each change of its table and the replication stream carries on', { timeout: 13 }, async() => {
  const sentinel = new Error('column sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      column: {
        from: x => {
          if (x === 'bad')
            throw sentinel
          return x
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`
  await sql`create table other (id serial primary key, bad text)`

  const xs = []
  const errors = []
  const { state } = await sql.subscribe('insert', row => xs.push(row.name), noop, e => errors.push(e))
  const pid = state.pid
  await sql`insert into other (bad) values ('x')`
  await sql`insert into test (name) values ('a')`
  await until(() => xs.length > 0)
  await sql`insert into other (bad) values ('y')`
  await sql`insert into test (name) values ('b')`
  await until(() => xs.length >= 2)

  return [
    'a,b 2 true true',
    [xs.join(), errors.length, errors.every(e => e === sentinel), state.pid === pid].join(' '),
    await sql`drop table test`,
    await sql`drop table other`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a column transform that throws undefined reports it and the replication stream carries on', { timeout: 8 }, async() => {
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      column: {
        from: x => {
          if (x === 'bad')
            throw [][0]
          return x
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`
  await sql`create table other (id serial primary key, bad text)`

  const xs = []
  const errors = []
  const { state } = await sql.subscribe('insert', row => xs.push(row.name), noop, e => errors.push(e))
  const pid = state.pid
  await sql`insert into other (bad) values ('x')`
  await sql`insert into test (name) values ('a')`
  await until(() => xs.length > 0)

  return [
    'a 1 true true',
    [xs.join(), errors.length, errors.every(e => e === undefined), state.pid === pid].join(' '),
    await sql`drop table test`,
    await sql`drop table other`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a row transform that returns nothing skips the change before any subscriber receives it', { timeout: 8 }, async() => {
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: { row: { from: row => row.name === 'bad' ? undefined : row } }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table test (id serial primary key, name text)`

  const xs = []
  const errors = []
  const { state } = await sql.subscribe('*:test', row => xs.push(row ? row.name : 'none'), noop, e => errors.push(e.name))
  await sql.subscribe('insert:test', row => xs.push(row ? row.name : 'none'), noop, e => errors.push(e.name))
  const pid = state.pid
  await sql`insert into test (name) values ('bad')`
  await sql`insert into test (name) values ('good')`
  await until(() => xs.length >= 2)

  return [
    'good,good TypeError,TypeError true',
    [xs.join(), errors.join(), state.pid === pid].join(' '),
    await sql`drop table test`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a one-character table name is subscribed to by its own inserts and decode errors only', { timeout: 13 }, async() => {
  const sentinel = new Error('transform sentinel')
  const sql = postgres({
    database: 'postgres_js_test',
    publications: 'alltables',
    fetch_types: false,
    transform: {
      row: {
        from: row => {
          if (row.name === 'bad')
            throw sentinel
          return row
        }
      }
    }
  })

  await sql.unsafe('create publication alltables for all tables')
  await sql`create table t (id serial primary key, name text)`
  await sql`create table other (id serial primary key, name text)`

  const xs = []
  const errors = []
  const { state } = await sql.subscribe('insert:t', row => xs.push(row.name), noop, e => errors.push(e))
  const pid = state.pid
  await sql`insert into other (name) values ('bad')`
  await sql`insert into t (name) values ('a')`
  await until(() => xs.length > 0)
  await sql`insert into t (name) values ('bad')`
  await until(() => errors.length > 0)

  return [
    'a 1 true true',
    [xs.join(), errors.length, errors.every(e => e === sentinel), state.pid === pid].join(' '),
    await sql`drop table t`,
    await sql`drop table other`,
    await sql`drop publication alltables`,
    await sql.end()
  ]
})

t('a query sent while a retried statement waits for its parameter types gets its own rows', { timeout: 10 }, async() => {
  let calls = 0
  let next
  const sql = postgres({
    ...options,
    max: 1,
    fetch_types: false,
    debug: (id, string) => {
      if (string.includes('retry_me') && ++calls === 3)
        next = sql`select 3 as x`.then(x => x[0].x, e => e.message)
    }
  })
  const select = () => sql`select name as retry_me, ${ 1 }::int as p from test`
  await sql`create table test (name text)`
  await sql`insert into test values ('1')`
  await select()
  await sql`alter table test alter column name type int using name::integer`
  const retried = await Promise.race([select().then(x => x[0], e => e.message), delay(2000).then(() => 'hung')])
  const sent = await Promise.race([next, delay(2000).then(() => 'hung')])
  const again = await select().then(x => x[0], e => e.message)
  await delay(50)
  const stats = pick(sql.stats())
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify([{ retry_me: 1, p: 1 }, 3, { retry_me: 1, p: 1 }, idleStats]),
    JSON.stringify([retried, sent, again, stats])
  ]
})

t('a statement sent on a reserved connection while a retried statement waits for its parameter types gets its own rows', { timeout: 10 }, async() => {
  let calls = 0
  let next
  const sql = postgres({
    ...options,
    max: 1,
    fetch_types: false,
    debug: (id, string) => {
      if (string.includes('retry_me') && ++calls === 3)
        next = reserved`select 3 as x`.then(x => x[0].x, e => e.message)
    }
  })
  const reserved = await sql.reserve()
  const select = () => reserved`select name as retry_me, ${ 1 }::int as p from test`
  await reserved`create table test (name text)`
  await reserved`insert into test values ('1')`
  await select()
  await reserved`alter table test alter column name type int using name::integer`
  const retried = await Promise.race([select().then(x => x[0], e => e.message), delay(2000).then(() => 'hung')])
  const sent = await Promise.race([next, delay(2000).then(() => 'hung')])
  const again = await select().then(x => x[0], e => e.message)
  await reserved`drop table test`
  reserved.release()
  await delay(50)
  const stats = pick(sql.stats())
  await sql.end()

  return [
    JSON.stringify([{ retry_me: 1, p: 1 }, 3, { retry_me: 1, p: 1 }, idleStats]),
    JSON.stringify([retried, sent, again, stats])
  ]
})

t('concurrent statements in a transaction after a cached plan changes roll back and free the connection', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (id int primary key, a int)`
  await sql`insert into test values (1, 1)`
  const before = (await sql`select pg_backend_pid() as pid`)[0].pid
  await sql`select * from test where id = ${ 1 }`
  await sql`select id from test where id = ${ 1 } and a > ${ 0 }`
  await sql`alter table test add column b int`
  const error = await within(sql.begin(sql => [
    sql`select * from test where id = ${ 1 }`,
    sql`select id from test where id = ${ 1 } and a > ${ 0 }`
  ]).catch(e => e.code), 'begin hung')
  const next = await within(sql`select 5 as x`.then(x => x[0].x, e => e.code), 'next query hung')
  const after = await within(sql`select pg_backend_pid() as pid`.then(x => x[0].pid, e => e.code), 'pid query hung')
  const ended = await within(sql.end().then(() => 'ended'), 'end hung')
  const admin = postgres({ ...options, onnotice: noop })
  await admin`select pg_terminate_backend(${ before })`
  await admin`drop table test`
  await admin.end()

  return [
    JSON.stringify(['0A000', 5, true, 'ended']),
    JSON.stringify([error, next, before === after, ended])
  ]
})

t('a query sent behind copy from stdin runs after the copy', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  const copy = sql.unsafe('copy test from stdin').execute()
  const next = sql`select 7 as x`.then(x => x[0].x, e => e.code)
  const writable = await copy
  const done = new Promise(r => (writable.on('finish', () => r('finish')), writable.on('error', e => r(e.code))))
  writable.end('1\n')
  const results = await Promise.race([
    Promise.all([done, next, sql`select count(*)::int as n from test`.then(x => x[0].n, e => e.code)]),
    delay(2000).then(() => 'hung')
  ])
  await delay(50)
  const stats = pick(sql.stats())
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['finish', 7, 1, idleStats]),
    JSON.stringify([...results, stats])
  ]
})

t('statements sent on a reserved connection behind copy from stdin reject with COPY_IN_PROGRESS and the copy completes', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  await sql`create table test (x int)`
  const reserved = await sql.reserve()
  const copy = reserved.unsafe('copy test from stdin').execute()
  const first = reserved`select 7 as x`.then(x => x[0].x, e => e.code)
  const second = reserved`select 8 as x`.then(x => x[0].x, e => e.code)
  const writable = await copy
  const done = new Promise(r => (writable.on('finish', () => r('finish')), writable.on('error', e => r(e.code))))
  writable.end('1\n')
  const results = await Promise.race([Promise.all([done, first, second]), delay(2000).then(() => 'hung')])
  const count = await reserved`select count(*)::int as n from test`.then(x => x[0].n, e => e.code)
  reserved.release()
  await delay(50)
  const stats = pick(sql.stats())
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['finish', 'COPY_IN_PROGRESS', 'COPY_IN_PROGRESS', 1, idleStats]),
    JSON.stringify([...results, count, stats])
  ]
})

t('a statement whose plan changed rejects with the plan error when a new statement is described behind it', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1 })
  const select = () => sql`select name from test`
  await sql`create table test (name text)`
  await sql`insert into test values ('1')`
  await select()
  await sql`alter table test alter column name type int using name::integer`
  const results = await Promise.race([
    Promise.all([
      select().then(x => x, e => e.code),
      sql`select ${ 5 }::int as x`.then(x => x[0], e => e.message)
    ]),
    delay(2000).then(() => 'hung')
  ])
  const again = await sql`select ${ 5 }::int as x`.then(x => x[0], e => e.message)
  const rerun = await select().then(x => x[0], e => e.code)
  await delay(50)
  const stats = pick(sql.stats())
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify(['0A000', { x: 5 }, { x: 5 }, { name: 1 }, idleStats]),
    JSON.stringify([...results, again, rerun, stats])
  ]
})

t('releasing a reserved connection while its statement is described does not hand the connection pool queries', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1, fetch_types: false })
  const reserved = await sql.reserve()
  const first = sql`select ${ 1 }::int as a`.then(x => x[0].a, e => e.message)
  const second = sql`select ${ 2 }::int as b`.then(x => x[0].b, e => e.message)
  const pending = reserved`select ${ 7 }::int as p`.execute().then(x => x[0].p, e => e.message)
  await new Promise(r => setImmediate(r))
  reserved.release()
  const results = await Promise.race([Promise.all([pending, first, second]), delay(2000).then(() => 'hung')])
  const again = await Promise.race([
    sql`select ${ 7 }::int as p`.then(x => x[0], e => e.message),
    delay(2000).then(() => 'hung')
  ])
  await delay(50)
  const stats = pick(sql.stats())
  await sql.end({ timeout: 1 })

  return [
    JSON.stringify([[7, 1, 2], { p: 7 }, idleStats]),
    JSON.stringify([results, again, stats])
  ]
})

t('a connection that lost its session during copy from stdin retries a statement whose plan changed', { timeout: 10 }, async() => {
  const sql = postgres({ ...options, max: 1, fetch_types: false })
  const other = postgres(options)
  await sql`create table test (id int primary key, a int)`
  const pid = (await sql`select pg_backend_pid() as pid`)[0].pid
  const copy = await sql.unsafe('copy test from stdin').execute()
  const lost = new Promise(r => (copy.on('error', e => r(e.code)), copy.on('close', () => r('close'))))
  await other`select pg_terminate_backend(${ pid })`
  const cause = await Promise.race([lost, delay(2000).then(() => 'hung')])
  await sql`select a from test`
  await sql`alter table test alter column a type text using a::text`
  const rows = await Promise.race([
    sql`select a from test`.then(x => x.length, e => e.code),
    delay(2000).then(() => 'hung')
  ])
  await other`drop table test`
  await other.end()
  await sql.end()

  return [
    JSON.stringify([true, 0]),
    JSON.stringify([typeof cause === 'string', rows])
  ]
})

for (const prepare of [true, false]) {
  t('a typed value whose serializer throws rejects its query and the next query runs with prepare: ' + prepare, async() => {
    const sql = postgres({ ...options, max: 1, prepare })
    const name = await sql`select ${ new Date('x') } as x`.then(() => 'resolved', e => e.name)
    const next = (await sql`select 1 as x`)[0].x
    await delay(50)
    const stats = pick(sql.stats())
    await sql.end()

    return [
      JSON.stringify(['RangeError', 1, idleStats]),
      JSON.stringify([name, next, stats])
    ]
  })
}

t('parameter_types rejects unknown values', async() => {
  let message
  try {
    postgres({ ...options, parameter_types: 'nope' })
  } catch (e) {
    message = e.message
  }

  return ['parameter_types nope is not supported', message]
})

t('parameter_types falls back to the default when passed as undefined', async() => {
  const sql = postgres({ ...options, parameter_types: undefined })

  return ['server', sql.options.parameter_types]
})

t('parameter_types is read from PGPARAMETER_TYPES', async() => {
  const env = process.env // eslint-disable-line
  const previous = env.PGPARAMETER_TYPES
  let value
  try {
    env.PGPARAMETER_TYPES = 'warn'
    value = postgres(options).options.parameter_types
  } finally {
    previous === undefined ? delete env.PGPARAMETER_TYPES : (env.PGPARAMETER_TYPES = previous)
  }

  return ['warn', value]
})

t('parameter_types is read from the connection URL', async() => {
  const sql = postgres('postgres://localhost/postgres_js_test?parameter_types=warn')

  return [
    JSON.stringify(['warn', false]),
    JSON.stringify([sql.options.parameter_types, 'parameter_types' in sql.options.connection])
  ]
})

for (const prepare of [true, false]) {
  t('parameter_types warn reports the values the \'client\' mode would send differently with prepare: ' + prepare, async() => {
    const reports = []
    const sql = postgres({ ...options, prepare, parameter_types: 'warn', ontypemismatch: x => reports.push(x) })
    await sql`create table test (t text, j jsonb, b bool, i int, tz timestamptz, o text)`
    const insert = () => sql`insert into test values (${ 'x' }, ${ '{"a":1}' }, ${ 'true' }, ${ 5 }, ${ '2020-01-02T09:00:00.000Z' }, ${ { a: 1 } })`
    await insert()
    await insert()
    const count = (await sql`select count(*)::int as n from test where t = ${ 'x' } and i = ${ 5 }`)[0].n
    const rows = await sql`select jsonb_typeof(j) as j, b, o from test`
    await sql`drop table test`
    await sql.end()

    const report = {
      query: 'insert into test values ($1, $2, $3, $4, $5, $6)',
      parameters: [
        { position: 2, oid: 3802, typeof: 'string' },
        { position: 3, oid: 16, typeof: 'string' },
        { position: 6, oid: 25, typeof: 'object' }
      ]
    }
    const row = { j: 'string', b: false, o: '[object Object]' }

    return [
      JSON.stringify([[report, report], 2, [row, row]]),
      JSON.stringify([reports, count, [...rows]])
    ]
  })
}

t('parameter_types warn includes serialized texts only with debug and reports values the \'client\' mode cannot serialize', async() => {
  const reports = []
  const sql = postgres({ ...options, debug: true, parameter_types: 'warn', ontypemismatch: x => reports.push(x) })
  await sql`create table test (j jsonb, t text, tz timestamptz)`
  const count = (await sql`insert into test values (${ 'x' }, ${ { a: 1n } }, ${ 1700000000000 })`).count
  await sql`drop table test`
  await sql.end()

  return [
    JSON.stringify([1, [
      [1, 3802, 'string', '"x"', 'x'],
      [2, 25, 'object', '[object Object]', 'TypeError'],
      [3, 1184, 'number', '2023-11-14T22:13:20.000Z', '1700000000000']
    ]]),
    JSON.stringify([count, reports[0].parameters.map(x =>
      [x.position, x.oid, x.typeof, x.serverText, x.clientText instanceof Error ? x.clientText.name : x.clientText]
    )])
  ]
})

t('parameter_types warn without ontypemismatch writes the report to console.warn', async() => {
  const warned = []
  const warn = globalThis.console.warn
  globalThis.console.warn = x => warned.push(x)
  let value
  try {
    const sql = postgres({ ...options, parameter_types: 'warn' })
    value = (await sql`select ${ '{"a":1}' }::jsonb as x`)[0].x
    await sql.end()
  } finally {
    globalThis.console.warn = warn
  }

  return [
    JSON.stringify(['{"a":1}', 1, 3802]),
    JSON.stringify([value, warned.length, warned[0].parameters[0].oid])
  ]
})

t('a throwing ontypemismatch callback is rethrown as an uncaught exception and its query runs', async() => {
  const sentinel = new Error('mismatch sentinel')
  const sql = postgres({ ...options, parameter_types: 'warn', ontypemismatch: () => { throw sentinel } })
  const [value, errors] = await uncaught(async() => {
    const x = (await sql`select ${ '{"a":1}' }::jsonb as x`)[0].x
    await sql.end()
    return x
  })

  return [
    JSON.stringify(['{"a":1}', 1, true]),
    JSON.stringify([value, errors.length, errors[0] === sentinel])
  ]
})

for (const prepare of [true, false]) {
  const suffix = ' with prepare: ' + prepare
  const client = extra => postgres({ ...options, parameter_types: 'client', prepare, ...extra })
  const code = query => query.then(() => 'resolved', e => e.code)

  t('parameter_types client sends strings for PostgreSQL to parse' + suffix, async() => {
    const sql = client()
    await sql`create table test (id serial, t text, i int, n numeric, j json, jb jsonb)`
    await sql`insert into test (t, i, n, j, jb) values (${ 'x' }, ${ '5' }, ${ '1.5' }, ${ '{"a":1}' }, ${ '[1,2]' })`
    await sql`insert into test (t, jb) values (${ 'y' }, ${ '"s"' })`
    const rejected = [
      await code(sql`insert into test (j) values (${ 'hello' })`),
      await code(sql`insert into test (jb) values (${ 'hello' })`)
    ]
    const rows = await sql`select t, i, n, json_typeof(j) as j, jsonb_typeof(jb) as jb from test order by id`
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify([
        ['22P02', '22P02'],
        [{ t: 'x', i: 5, n: '1.5', j: 'object', jb: 'array' }, { t: 'y', i: null, n: null, j: null, jb: 'string' }]
      ]),
      JSON.stringify([rejected, [...rows]])
    ]
  })

  t('parameter_types client reads booleans with PostgreSQL boolean input' + suffix, async() => {
    const sql = client()
    await sql`create table test (id serial, b bool)`
    for (const x of ['t', 'true', 'yes', 'on', '1', ' TRUE ', 1, 'f', 'false', 'no', 'off', '0', 0])
      await sql`insert into test (b) values (${ x })`
    const rejected = [
      await code(sql`insert into test (b) values (${ 'maybe' })`),
      await code(sql`insert into test (b) values (${ 2 })`)
    ]
    const count = (await sql`select count(*) filter (where b)::int as t, count(*) filter (where not b)::int as f from test`)[0]
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify([['22P02', '22P02'], { t: 7, f: 6 }]),
      JSON.stringify([rejected, count])
    ]
  })

  t('parameter_types client parses date strings in the session time zone' + suffix, async() => {
    const sql = client({ connection: { timezone: 'Asia/Tokyo' } })
    await sql`create table test (id serial, tz timestamptz, ts timestamp, d date)`
    await sql`insert into test (tz, ts, d) values (${ '2020-01-02 10:00' }, ${ '2020-01-02T23:30:00-05:00' }, ${ '2020-01-02T23:30:00-05:00' })`
    await sql`insert into test (tz, ts, d) values (${ 'infinity' }, ${ '-infinity' }, ${ 'epoch' })`
    await sql`insert into test (tz, ts, d) values (${ new Date(0) }, ${ null }, ${ null })`
    const [a, b, c] = await sql`
      select
        tz = '2020-01-02T01:00:00Z'::timestamptz as tz,
        ts = '2020-01-02 23:30'::timestamp as ts,
        d = '2020-01-02'::date as d,
        tz = 'infinity' as infinity,
        ts = '-infinity' as negative,
        d = '1970-01-01' as epoch_date,
        tz = 'epoch' as epoch
      from test
      order by id
    `
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify([true, true, true, true, true, true, true]),
      JSON.stringify([a.tz, a.ts, a.d, b.infinity, b.negative, b.epoch_date, c.epoch])
    ]
  })

  t('parameter_types client rejects a number bound to a date or time column' + suffix, async() => {
    const sql = client()
    await sql`create table test (tz timestamptz, ts timestamp, d date)`
    const rejected = []
    for (const column of ['tz', 'ts', 'd'])
      rejected.push(await code(sql`insert into test (${ sql(column) }) values (${ 1700000000000 })`))
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify(['22008', '22008', '22008']),
      JSON.stringify(rejected)
    ]
  })

  t('parameter_types client sends numbers as their JavaScript text' + suffix, async() => {
    const sql = client()
    await sql`create table test (id serial, n numeric, f float8, i8 int8, tz timestamptz)`
    await sql`create table test2 (i int, j jsonb, b bool)`
    await sql`insert into test (n, f, i8, tz) values (${ NaN }, ${ -0 }, ${ 2 ** 53 }, ${ Infinity })`
    await sql`insert into test (n) values (${ Infinity })`
    await sql`insert into test (n) values (${ 1e21 })`
    const rejected = [
      await code(sql`insert into test (i8) values (${ 1e21 })`),
      await code(sql`insert into test2 (i) values (${ NaN })`),
      await code(sql`insert into test2 (j) values (${ NaN })`)
    ]
    await sql`insert into test2 (b) values (${ 1 })`
    const rows = await sql`select n::text, f::text, i8::text, tz::text from test order by id`.values()
    const bool = (await sql`select b from test2`)[0].b
    await sql`drop table test`
    await sql`drop table test2`
    await sql.end()

    return [
      JSON.stringify([
        ['22P02', '22P02', '22P02'],
        true,
        [['NaN', '0', '9007199254740992', 'infinity'], ['Infinity', null, null, null], ['1000000000000000000000', null, null, null]]
      ]),
      JSON.stringify([rejected, bool, rows])
    ]
  })

  t('parameter_types client sends strings to bytea as bytea text' + suffix, async() => {
    const sql = client()
    await sql`create table test (id serial, bin bytea)`
    await sql`insert into test (bin) values (${ 'hello' })`
    await sql`insert into test (bin) values (${ '\\x6869' })`
    const rejected = await code(sql`insert into test (bin) values (${ 'a\\b' })`)
    const rows = await sql`select encode(bin, 'escape') as bin from test order by id`
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify(['22P02', ['hello', 'hi']]),
      JSON.stringify([rejected, rows.map(x => x.bin)])
    ]
  })

  t('parameter_types client sends plain objects as JSON and other objects as their primitive value' + suffix, async() => {
    class Money {
      valueOf() { return 1 }
      toString() { return 'c' }
      toJSON() { return { cents: 100 } }
    }

    const bare = Object.create(null)
    bare.a = 1
    const sql = client()
    const identity = client({ types: { json: { to: 114, from: [114, 3802], serialize: x => x, parse: x => x } } })
    await sql`create table test (id serial, t text, j jsonb)`
    for (const x of [{ a: 1 }, bare, new Money()])
      await sql`insert into test (t, j) values (${ x }, ${ x })`
    await identity`insert into test (j) values (${ { a: 1 } })`
    const rows = await sql`select t, jsonb_typeof(j) as j from test order by id`
    await sql`drop table test`
    await identity.end()
    await sql.end()

    return [
      JSON.stringify([['{"a":1}', '{"a":1}', '1', null], ['object', 'object', 'number', 'object']]),
      JSON.stringify([rows.map(x => x.t), rows.map(x => x.j)])
    ]
  })

  t('parameter_types client uses custom type serializers only for typed values and arrays' + suffix, async() => {
    const point = {
      to: 600,
      from: [600],
      serialize: x => '(' + (Array.isArray(x) ? x : [x.x, x.y]) + ')',
      parse: x => x
    }
    const sql = client({ types: { point } })
    await sql`create table test (x point)`
    await sql`insert into test values (${ [1, 2] })`
    await sql`insert into test values (${ sql.types.point({ x: 3, y: 4 }) })`
    const rejected = await code(sql`insert into test values (${ { x: 5, y: 6 } })`)
    const rows = await sql`select x::text as x from test order by x::text`
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify(['22P02', ['(1,2)', '(3,4)']]),
      JSON.stringify([rejected, rows.map(x => x.x)])
    ]
  })

  t('parameter_types client asks PostgreSQL about arrays' + suffix, async() => {
    const sql = client()
    await sql`create table test (ia int[], ta text[], j jsonb)`
    await sql`insert into test values (${ [1, 2] }, ${ ['a', 'b'] }, ${ [{ a: 1 }] })`
    const row = (await sql`select ia::text as ia, ta::text as ta, jsonb_typeof(j) as j from test`)[0]
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify({ ia: '{1,2}', ta: '{a,b}', j: 'array' }),
      JSON.stringify(row)
    ]
  })

  t('parameter_types client leaves typed values as they are' + suffix, async() => {
    const sql = client()
    await sql`create table test (j jsonb, b bool, tz timestamptz, i8 int8, bin bytea)`
    await sql`insert into test values (${ sql.json('{"a":1}') }, ${ true }, ${ new Date(0) }, ${ 5n }, ${ Buffer.from('hi') })`
    const row = (await sql`
      select jsonb_typeof(j) as j, b, tz = 'epoch' as tz, i8::text as i8, encode(bin, 'escape') as bin from test
    `)[0]
    await sql`drop table test`
    await sql.end()

    return [
      JSON.stringify({ j: 'string', b: true, tz: true, i8: '5', bin: 'hi' }),
      JSON.stringify(row)
    ]
  })

  t('parameter_types client sends null as SQL NULL and keeps undefined handling' + suffix, async() => {
    const sql = client()
    const transformed = client({ transform: { undefined: null } })
    await sql`create table test (j jsonb)`
    await sql`insert into test values (${ null })`
    await transformed`insert into test values (${ undefined })`
    const rejected = await code(sql`insert into test values (${ undefined })`)
    const count = (await sql`select count(*)::int as n from test where j is null`)[0].n
    await sql`drop table test`
    await transformed.end()
    await sql.end()

    return [
      JSON.stringify([2, 'UNDEFINED_VALUE']),
      JSON.stringify([count, rejected])
    ]
  })

  t('parameter_types client serializes each value by its own type on every run of a prepared statement' + suffix, async() => {
    const sql = client()
    const q = x => sql`select ${ x }::jsonb as j`
    const described = (await q('x').describe()).types
    const values = []
    for (const x of ['{"a":1}', { b: 2 }, [3], '"s"'])
      values.push((await q(x))[0].j)
    const last = await q('{"c":3}')
    await sql.end()

    return [
      JSON.stringify([[3802], [{ a: 1 }, { b: 2 }, [3], 's'], [3802]]),
      JSON.stringify([described, values, last.statement.types])
    ]
  })
}

t('identical queries pipelined on a fresh connection prepare their statement once', async() => {
  const sql = postgres({ ...options, max: 1, prepare: true })
  await Promise.all(Array.from({ length: 5 }, () => sql`select ${ true } as burst_marker`))
  const count = (await sql`select count(*)::int as n from pg_prepared_statements where statement like 'select $1 as burst_marker%'`)[0].n
  await sql.end()

  return [1, count]
})

t('pool asyncDispose ends the pool', async() => {
  const sql = postgres(options)
  await sql[Symbol.asyncDispose]()
  return ['CONNECTION_ENDED', (await sql``.catch(x => x.code))]
})

t('pool asyncDispose after end resolves', async() => {
  const sql = postgres(options)
  await sql.end()
  return [undefined, await sql[Symbol.asyncDispose]()]
})

t('reserved dispose releases the connection', async() => {
  const sql = postgres({ ...options, max: 1 })
  const reserved = await sql.reserve()
  reserved[Symbol.dispose]()
  const code = await reserved`select 1`.catch(x => x.code)
  const [{ x }] = await sql`select 1 as x`
  await sql.end()
  return ['CONNECTION_ENDED 1', code + ' ' + x]
})

t('reserved asyncDispose releases the connection', async() => {
  const sql = postgres({ ...options, max: 1 })
  const reserved = await sql.reserve()
  await reserved[Symbol.asyncDispose]()
  const code = await reserved`select 1`.catch(x => x.code)
  const [{ x }] = await sql`select 1 as x`
  await sql.end()
  return ['CONNECTION_ENDED 1', code + ' ' + x]
})

t('reserved dispose after release does not throw', async() => {
  const sql = postgres({ ...options, max: 1 })
  const reserved = await sql.reserve()
  reserved.release()
  reserved[Symbol.dispose]()
  await reserved[Symbol.asyncDispose]()
  await sql.end()
  return [true, true]
})

t('transaction and savepoint handles are not disposable', async() => {
  const sql = postgres({ ...options, max: 2 })
  const reserved = await sql.reserve()
  const seen = await sql.begin(async tx => [
    tx[Symbol.asyncDispose],
    await tx.savepoint(async sp => sp[Symbol.asyncDispose])
  ])
  reserved.release()
  await sql.end()
  return ['undefined undefined', seen.map(String).join(' ')]
})

t('using declarations end the pool and release the reservation', async() => {
  const AsyncFunction = Object.getPrototypeOf(async() => null).constructor
  try {
    AsyncFunction('await using x = null')
  } catch (e) {
    if (!(e instanceof SyntaxError))
      throw e
    return [true, true]
  }

  const run = new AsyncFunction('postgres', 'options', `
    let pool, handle
    {
      await using sql = postgres(options)
      pool = sql
      {
        using reserved = await sql.reserve()
        handle = reserved
        await reserved\`select 1\`
      }
      const released = await handle\`select 1\`.catch(x => x.code)
      const [{ x }] = await sql\`select 1 as x\`
      if (released !== 'CONNECTION_ENDED' || x !== 1)
        return 'reservation not released'
    }
    return await pool\`select 1\`.catch(x => x.code)
  `)

  return ['CONNECTION_ENDED', await run(postgres, { ...options, max: 2 })]
})

t('end with a timeout runs a query queued behind running ones and leaves no backend open', async() => {
  const application_name = 'end_queued_' + Math.random().toString(36).slice(2)
  const pool = postgres({ ...options, max: 2, max_pipeline: 0, connection: { application_name } })
  const held = await Promise.all([pool.reserve(), pool.reserve()])
  held.forEach(x => x.release())
  const running = [1, 2].map(() => pool`select pg_sleep(0.05)`.execute())
  const queued = pool`select 3 as x`.execute()
  await 1
  const executing = pool.stats().executingCount
  const order = []
  const third = queued.then(rows => (order.push('query'), rows[0].x))
  const ending = pool.end({ timeout: 1 }).then(() => order.push('end'))
  const [x] = await Promise.all([third, ending, ...running])
  const left = await backendsLeft(application_name)

  return [
    JSON.stringify([2, 3, ['query', 'end'], 0]),
    JSON.stringify([executing, x, order, left])
  ]
})

t('end with a timeout runs a query queued while the pool is still connecting and leaves no backend open', async() => {
  const application_name = 'end_cold_' + Math.random().toString(36).slice(2)
  const pool = postgres({ ...options, max: 2, connection: { application_name } })
  const running = [1, 2].map(() => pool`select pg_sleep(0.05)`.execute())
  const queued = pool`select 3 as x`.execute()
  const order = []
  const third = queued.then(rows => (order.push('query'), rows[0].x))
  const ending = pool.end({ timeout: 1 }).then(() => order.push('end'))
  const [x] = await Promise.all([third, ending, ...running])
  const left = await backendsLeft(application_name)

  return [
    JSON.stringify([3, ['query', 'end'], 0]),
    JSON.stringify([x, order, left])
  ]
})

t('arrays are sent and read back without fetching types, prepared or not', async() => {
  const seen = []
  for (const prepare of [true, false]) {
    const sql = postgres({ ...options, fetch_types: false, prepare })
    const unnested = (await sql`select x from unnest(${ ['foo', 'bar'] }::text[]) as x`).map(row => row.x).join()
    await sql`create temp table report_arrays (ta text[], ia int4[])`
    await sql`insert into report_arrays values (${ ['a', 'b'] }, ${ [1, 2] })`
    const [row] = await sql`select ta, ia from report_arrays`
    await sql.end()
    seen.push([unnested, row.ta, row.ia])
  }

  return [
    JSON.stringify(Array(2).fill(['foo,bar', ['a', 'b'], [1, 2]])),
    JSON.stringify(seen)
  ]
})

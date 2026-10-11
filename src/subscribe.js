import callback from './callback.js'

const noop = () => { /* noop */ }
    , commands = { 68: 'delete', 73: 'insert', 85: 'update' }

export default function Subscribe(postgres, options) {
  const subscribers = new Map()
      , slot = 'postgresjs_' + Math.random().toString(36).slice(2)
      , state = {}

  let connection
    , stream
    , ended = false

  const sql = subscribe.sql = postgres({
    ...options,
    transform: { column: {}, value: {}, row: {} },
    max: 1,
    fetch_types: false,
    idle_timeout: null,
    max_lifetime: null,
    onidle: null,
    connection: {
      ...options.connection,
      replication: 'database'
    },
    onclose: async function() {
      if (ended)
        return
      stream = null
      state.pid = state.secret = undefined
      connected(await init(sql, slot, options.publications))
      subscribers.forEach(event => event.forEach(({ onsubscribe }) => callback(onsubscribe)))
    },
    no_subscribe: true
  })

  const end = sql.end
      , close = sql.close

  sql.end = async() => {
    ended = true
    stream && (await new Promise(r => (stream.once('close', r), stream.end())))
    return end()
  }

  sql.close = async() => {
    stream && (await new Promise(r => (stream.once('close', r), stream.end())))
    return close()
  }

  return subscribe

  async function subscribe(event, fn, onsubscribe = noop, onerror) {
    event = parseEvent(event)

    if (!connection)
      connection = init(sql, slot, options.publications)

    const subscriber = { fn, onsubscribe, onerror }
    const fns = subscribers.has(event)
      ? subscribers.get(event).add(subscriber)
      : subscribers.set(event, new Set([subscriber])).get(event)

    const unsubscribe = () => {
      fns.delete(subscriber)
      fns.size === 0 && subscribers.delete(event)
    }

    return connection.then(x => {
      connected(x)
      callback(onsubscribe)
      return { unsubscribe, state, sql }
    })
  }

  function connected(x) {
    stream = x.stream
    state.pid = x.state.pid
    state.secret = x.state.secret
  }

  async function init(sql, slot, publications) {
    if (!publications)
      throw new Error('Missing publication names')

    const xs = await sql.unsafe(
      `CREATE_REPLICATION_SLOT ${ slot } TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT`
    )

    const [x] = xs

    const stream = await sql.unsafe(
      `START_REPLICATION SLOT ${ slot } LOGICAL ${
        x.consistent_point
      } (proto_version '1', publication_names '${ publications }')`
    ).writable()

    const state = {
      lsn: Buffer.concat(x.consistent_point.split('/').map(x => Buffer.from(('00000000' + x).slice(-8), 'hex')))
    }

    stream.on('data', data)
    stream.on('error', error)
    stream.on('close', sql.close)

    return { stream, state: xs.state }

    function error(e) {
      console.error('Unexpected error during logical streaming - reconnecting', e) // eslint-disable-line
      subscribers.forEach(fns => fns.forEach(({ onerror }) => callback(onerror, e)))
    }

    function data(x) {
      if (x[0] === 0x77) {
        try {
          parse(x.subarray(25), state, sql.options.parsers, handle, options.transform)
        } catch (error) {
          skip(x.subarray(25), error)
        }
      } else if (x[0] === 0x6b && x[17]) {
        state.lsn = x.subarray(1, 9)
        pong()
      }
    }

    function handle(a, b) {
      const path = b.relation.schema + '.' + b.relation.table
          , key = b.relation.keys.length && '=' + b.relation.keys.map(x => a[x.name])
      call('*', a, b)
      call('*:' + path, a, b)
      key && call('*:' + path + key, a, b)
      call(b.command, a, b)
      call(b.command + ':' + path, a, b)
      key && call(b.command + ':' + path + key, a, b)
    }

    function skip(x, error) {
      const command = commands[x[0]]
          , relation = command && state[x.readUInt32BE(1)]

      if (!relation)
        throw error

      const path = relation.schema + '.' + relation.table
          , events = ['*', '*:' + path, command, command + ':' + path]

      let uncaught = false
      subscribers.forEach((fns, event) => events.includes(event.split('=')[0]) && fns.forEach(({ onerror }) =>
        onerror ? callback(onerror, error) : uncaught = true
      ))
      uncaught && callback(() => { throw error })
    }

    function pong() {
      const x = Buffer.alloc(34)
      x[0] = 'r'.charCodeAt(0)
      x.fill(state.lsn, 1)
      x.writeBigInt64BE(BigInt(Date.now() - Date.UTC(2000, 0, 1)) * BigInt(1000), 25)
      stream.write(x)
    }
  }

  function call(x, a, b) {
    subscribers.has(x) && subscribers.get(x).forEach(({ fn }) => callback(fn, a, b, x))
  }
}

function Time(x) {
  return new Date(Date.UTC(2000, 0, 1) + Number(x / BigInt(1000)))
}

function parse(x, state, parsers, handle, transform) {
  const char = (acc, [k, v]) => (acc[k.charCodeAt(0)] = v, acc)

  Object.entries({
    R: x => {  // Relation
      let i = 1
      const r = state[x.readUInt32BE(i)] = {
        schema: x.toString('utf8', i += 4, i = x.indexOf(0, i)) || 'pg_catalog',
        table: x.toString('utf8', i + 1, i = x.indexOf(0, i + 1)),
        columns: Array(x.readUInt16BE(i += 2)),
        keys: []
      }
      i += 2

      let columnIndex = 0
        , column

      try {
        while (i < x.length) {
          column = r.columns[columnIndex++] = {
            key: x[i++],
            name: transform.column.from
              ? transform.column.from(x.toString('utf8', i, i = x.indexOf(0, i)))
              : x.toString('utf8', i, i = x.indexOf(0, i)),
            type: x.readUInt32BE(i += 1),
            parser: parsers[x.readUInt32BE(i)],
            atttypmod: x.readUInt32BE(i += 4)
          }

          column.key && r.keys.push(column)
          i += 4
        }
      } catch (error) {
        r.error = error
        r.failed = true
      }
    },
    Y: () => { /* noop */ }, // Type
    O: () => { /* noop */ }, // Origin
    B: x => { // Begin
      state.date = Time(x.readBigInt64BE(9))
      state.lsn = x.subarray(1, 9)
    },
    I: x => { // Insert
      let i = 1
      const relation = decodable(state[x.readUInt32BE(i)])
      const { row } = tuples(x, relation.columns, i += 7, transform)

      handle(row, {
        command: 'insert',
        relation
      })
    },
    D: x => { // Delete
      let i = 1
      const relation = decodable(state[x.readUInt32BE(i)])
      i += 4
      const key = x[i] === 75
      handle(key || x[i] === 79
        ? tuples(x, relation.columns, i += 3, transform).row
        : null
      , {
        command: 'delete',
        relation,
        key
      })
    },
    U: x => { // Update
      let i = 1
      const relation = decodable(state[x.readUInt32BE(i)])
      i += 4
      const key = x[i] === 75
      const xs = key || x[i] === 79
        ? tuples(x, relation.columns, i += 3, transform)
        : null

      xs && (i = xs.i)

      const { row } = tuples(x, relation.columns, i + 3, transform)

      handle(row, {
        command: 'update',
        relation,
        key,
        old: xs && xs.row
      })
    },
    T: () => { /* noop */ }, // Truncate,
    C: () => { /* noop */ }  // Commit
  }).reduce(char, {})[x[0]](x)
}

function decodable(relation) {
  if (relation.failed)
    throw relation.error

  return relation
}

function tuples(x, columns, xi, transform) {
  let type
    , column
    , value

  const row = transform.raw ? new Array(columns.length) : {}
  for (let i = 0; i < columns.length; i++) {
    type = x[xi++]
    column = columns[i]
    value = type === 110 // n
      ? null
      : type === 117 // u
        ? undefined
        : column.parser === undefined
          ? x.toString('utf8', xi + 4, xi += 4 + x.readUInt32BE(xi))
          : column.parser.array === true
            ? column.parser(x.toString('utf8', xi + 5, xi += 4 + x.readUInt32BE(xi)))
            : column.parser(x.toString('utf8', xi + 4, xi += 4 + x.readUInt32BE(xi)))

    transform.raw
      ? (row[i] = transform.raw === true
        ? value
        : transform.value.from ? transform.value.from(value, column) : value)
      : (row[column.name] = transform.value.from
        ? transform.value.from(value, column)
        : value
      )
  }

  return { i: xi, row: transform.row.from ? transform.row.from(row) : row }
}

function parseEvent(x) {
  const xs = x.match(/^(\*|insert|update|delete)?:?([^.=]+(?:\.[^=]+)?)?=?(.+)?/i) || []

  if (!xs)
    throw new Error('Malformed subscribe pattern: ' + x)

  const [, command, path, key] = xs

  return (command || '*')
       + (path ? ':' + (path.indexOf('.') === -1 ? 'public.' + path : path) : '')
       + (key ? '=' + key : '')
}

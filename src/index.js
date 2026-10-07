import os from 'os'
import fs from 'fs'

import {
  mergeUserTypes,
  addDefaultArrayTypes,
  inferType,
  Parameter,
  Identifier,
  Builder,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab
} from './types.js'

import Connection from './connection.js'
import { Query, CLOSE } from './query.js'
import Queue from './queue.js'
import { Errors, PostgresError } from './errors.js'
import Subscribe from './subscribe.js'
import largeObject from './large.js'

Object.assign(Postgres, {
  PostgresError,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab,
  BigInt: {
    to: 20,
    from: [20],
    parse: x => BigInt(x), // eslint-disable-line
    serialize: x => x.toString()
  }
})

export default Postgres

function Postgres(a, b) {
  const options = parseOptions(a, b)
      , subscribe = options.no_subscribe || Subscribe(Postgres, { ...options })

  let ending = false

  const queries = Queue()
      , connecting = Queue()
      , reserved = Queue()
      , closed = Queue()
      , ended = Queue()
      , open = Queue()
      , busy = Queue()
      , full = Queue()
      , queues = { connecting, reserved, closed, ended, open, busy, full }

  const connections = [...Array(options.max)].map(() => Connection(options, queues, { onopen, onend, onclose, ondrain }))

  const sql = Sql(handler)

  Object.assign(sql, {
    get parameters() { return options.parameters },
    largeObject: largeObject.bind(null, sql),
    subscribe,
    CLOSE,
    END: CLOSE,
    PostgresError,
    options,
    reserve,
    listen,
    begin,
    close,
    end
  })

  return sql

  function Sql(handler) {
    handler.debug = options.debug

    Object.entries(options.types).reduce((acc, [name, type]) => {
      acc[name] = (x) => new Parameter(x, type.to)
      return acc
    }, typed)

    Object.assign(sql, {
      types: typed,
      typed,
      unsafe,
      notify,
      array,
      json,
      file
    })

    return sql

    function typed(value, type) {
      return new Parameter(value, type)
    }

    function sql(strings, ...args) {
      const query = strings && Array.isArray(strings.raw)
        ? new Query(strings, args, handler, cancel)
        : typeof strings === 'string' && !args.length
          ? new Identifier(options.transform.column.to ? options.transform.column.to(strings) : strings)
          : new Builder(strings, args)
      return query
    }

    function unsafe(string, args = [], options = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options = args, args = [])
      const query = new Query([string], args, handler, cancel, {
        prepare: false,
        ...options,
        simple: 'simple' in options ? options.simple : args.length === 0
      })
      return query
    }

    function file(path, args = [], options = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options = args, args = [])
      const query = new Query([], args, (query) => {
        fs.readFile(path, 'utf8', (err, string) => {
          if (err)
            return query.reject(err)

          query.strings = [string]
          handler(query)
        })
      }, cancel, {
        ...options,
        simple: 'simple' in options ? options.simple : args.length === 0
      })
      return query
    }
  }

  async function listen(name, fn, onlisten) {
    const listener = { fn, onlisten }

    const sql = listen.sql || (listen.sql = Postgres({
      ...options,
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      fetch_types: false,
      onclose() {
        Object.entries(listen.channels).forEach(([name, { listeners }]) => {
          delete listen.channels[name]
          Promise.all(listeners.map(l => listen(name, l.fn, l.onlisten).catch(() => { /* noop */ })))
        })
      },
      onnotify(c, x) {
        c in listen.channels && listen.channels[c].listeners.forEach(l => l.fn(x))
      }
    }))

    const channels = listen.channels || (listen.channels = {})
        , exists = name in channels

    if (exists) {
      channels[name].listeners.push(listener)
      const result = await channels[name].result
      listener.onlisten && listener.onlisten()
      return { state: result.state, unlisten }
    }

    channels[name] = { result: sql`listen ${
      sql.unsafe('"' + name.replace(/"/g, '""') + '"')
    }`, listeners: [listener] }
    const result = await channels[name].result
    listener.onlisten && listener.onlisten()
    return { state: result.state, unlisten }

    async function unlisten() {
      if (name in channels === false)
        return

      channels[name].listeners = channels[name].listeners.filter(x => x !== listener)
      if (channels[name].listeners.length)
        return

      delete channels[name]
      return sql`unlisten ${
        sql.unsafe('"' + name.replace(/"/g, '""') + '"')
      }`
    }
  }

  async function notify(channel, payload) {
    return await sql`select pg_notify(${ channel }, ${ '' + payload })`
  }

  async function lease(auto) {
    if (ending)
      throw Errors.connection('CONNECTION_ENDED', options)

    const l = { connection: null, closed: null, onclose: null, reserved: null, queue: Queue() }
    open.length
      ? own(open.shift(), l)
      : auto && !closed.length && busy.length
        ? own(busy.shift(), l)
        : await new Promise((resolve, reject) => {
          const query = { reserve: c => resolve(own(c, l)), reject }
          closed.length
            ? connect(closed.shift(), query)
            : queries.push(query)
        })
    return l
  }

  function own(c, l) {
    l.connection = c
    c.lease = l
    move(c, reserved)
    c.reserved = l.reserved = () => l.queue.length
      ? c.execute(l.queue.shift())
      : move(c, reserved)
    c.reserved.release = true
    return c
  }

  function valid(l) {
    return !l.closed && l.connection.lease === l && l.connection.reserved === l.reserved
  }

  function send(l, q) {
    const c = l.connection
    valid(l)
      ? c.queue === full
        ? l.queue.push(q)
        : c.execute(q) || move(c, full)
      : q.reject(gone(l))
  }

  function gone(l) {
    return Errors.connection(l.closed && l.closed.code === 'CONNECTION_ENDED' ? 'CONNECTION_ENDED' : 'CONNECTION_CLOSED', options)
  }

  function finish(l) {
    const c = l.connection
    if (l.closed || c.lease !== l)
      return false

    const held = c.reserved === l.reserved
    c.lease = null
    l.closed = Errors.connection('CONNECTION_ENDED', options)
    held && (c.reserved = null)
    while (l.queue.length)
      l.queue.shift().reject(gone(l))
    return held
  }

  async function reserve() {
    const l = await lease(false)
    const sql = Sql(q => send(l, q))
    sql.release = () => finish(l) && l.connection.release()
    return sql
  }

  async function begin(options, fn) {
    !fn && (fn = options, options = '')
    const l = await lease(true)
    let savepoints = 0
      , prepare = null
      , settled = false

    try {
      const closing = new Promise((_, reject) => l.onclose = reject)
      return await Promise.race([transaction(), closing])
    } finally {
      finish(l) && (settled ? l.connection.release() : l.connection.terminate())
    }

    async function transaction() {
      await Sql(q => send(l, q)).unsafe('begin ' + options.replace(/[^a-z ]/ig, ''), []).execute().catch(e => {
        e instanceof PostgresError && (settled = true)
        throw e
      })
      return scope(fn)
    }

    async function scope(fn, name) {
      const sql = Sql(handler)
      sql.savepoint = savepoint
      sql.prepare = x => prepare = x.replace(/[^a-z0-9$-_. ]/gi)
      let uncaughtError
        , result

      name && await sql`savepoint ${ sql(name) }`
      try {
        result = await new Promise((resolve, reject) => {
          const x = fn(sql)
          Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve, reject)
        })

        if (uncaughtError)
          throw uncaughtError
      } catch (e) {
        l.closed || await (name
          ? sql`rollback to ${ sql(name) }`
          : sql`rollback`
        )
        name || (settled = true)
        throw e instanceof PostgresError && e.code === '25P02' && uncaughtError || e
      }

      if (l.closed)
        throw l.closed

      if (!name) {
        prepare
          ? await sql`prepare transaction '${ sql.unsafe(prepare) }'`
          : await sql`commit`
        settled = true
      }

      return result

      function savepoint(name, fn) {
        if (name && Array.isArray(name.raw))
          return savepoint(sql => sql.apply(sql, arguments))

        arguments.length === 1 && (fn = name, name = null)
        return scope(fn, 's' + savepoints++ + (name ? '_' + name : ''))
      }

      function handler(q) {
        q.catch(e => uncaughtError || (uncaughtError = e))
        send(l, q)
      }
    }
  }

  function move(c, queue) {
    c.queue.remove(c)
    queue.push(c)
    c.queue = queue
    queue === open
      ? c.idleTimer.start()
      : c.idleTimer.cancel()
    return c
  }

  function json(x) {
    return new Parameter(x, 3802)
  }

  function array(x, type) {
    if (!Array.isArray(x))
      return array(Array.from(arguments))

    return new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap)
  }

  function handler(query) {
    if (ending)
      return query.reject(Errors.connection('CONNECTION_ENDED', options, options))

    if (open.length)
      return go(open.shift(), query)

    if (closed.length)
      return connect(closed.shift(), query)

    busy.length
      ? go(busy.shift(), query)
      : queries.push(query)
  }

  function go(c, query) {
    return c.execute(query)
      ? move(c, busy)
      : move(c, full)
  }

  function cancel(query) {
    return new Promise((resolve, reject) => {
      query.state
        ? query.active
          ? Connection(options).cancel(query.state, resolve, reject)
          : query.cancelled = { resolve, reject }
        : (
          queries.remove(query),
          query.cancelled = true,
          query.reject(Errors.generic('57014', 'canceling statement due to user request')),
          resolve()
        )
    })
  }

  async function end({ timeout = null } = {}) {
    if (ending)
      return ending

    await 1
    let timer
    return ending = Promise.resolve().then(() => Promise.race([
      new Promise(r => timeout !== null && (timer = setTimeout(destroy, timeout * 1000, r))),
      Promise.all(connections.map(c => c.end()).concat(
        listen.sql ? listen.sql.end({ timeout: 0 }) : [],
        subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : []
      ))
    ])).then(() => {
      clearTimeout(timer)
      while (queries.length)
        queries.shift().reject(Errors.connection('CONNECTION_CLOSED', options))
    })
  }

  async function close() {
    await Promise.all(connections.map(c => c.end()))
  }

  async function destroy(resolve) {
    while (queries.length)
      queries.shift().reject(Errors.connection('CONNECTION_DESTROYED', options))
    await Promise.all(connections.map(c => c.terminate()))
    resolve()
  }

  function connect(c, query) {
    move(c, connecting)
    c.connect(query)
    return c
  }

  function onend(c) {
    move(c, ended)
  }

  function onopen(c, initial) {
    if (initial && initial.reserve)
      return initial.reserve(move(c, reserved))

    if (queries.length === 0)
      return move(c, open)

    let max = Math.ceil(queries.length / (connecting.length + 1))
      , ready = true

    while (ready && queries.length && max-- > 0) {
      const query = queries.shift()
      if (query.reserve)
        return query.reserve(move(c, reserved))

      ready = c.execute(query)
    }

    ready
      ? move(c, busy)
      : move(c, full)
  }

  function ondrain(c) {
    if (!ending)
      return false

    let drained = false
    let ready = true
    while (ready && queries.length) {
      const query = queries.shift()
      query.reserve
        ? query.reject(Errors.connection('CONNECTION_ENDED', options))
        : (drained = true, ready = c.execute(query))
    }
    return drained
  }

  function abandon(l, e) {
    l.connection.lease = null
    l.closed = e || Errors.connection('CONNECTION_CLOSED', options)
    while (l.queue.length)
      l.queue.shift().reject(gone(l))
    l.onclose && l.onclose(e)
  }

  function onclose(c, e) {
    move(c, closed)
    c.reserved = null
    c.lease && abandon(c.lease, e)
    options.onclose && options.onclose(c.id)
    if (ending) {
      while (queries.length)
        queries.shift().reject(e)
    } else if (queries.length && c.queue === closed) {
      connect(c, queries.shift())
    }
  }
}

function parseOptions(a, b) {
  if (a && a.shared)
    return a

  const env = process.env // eslint-disable-line
      , o = (!a || typeof a === 'string' ? b : a) || {}
      , { url, multihost } = parseUrl(a)
      , query = [...url.searchParams].reduce((a, [b, c]) => (a[b] = c, a), {})
      , host = o.hostname || o.host || multihost || url.hostname || env.PGHOST || 'localhost'
      , port = o.port || url.port || env.PGPORT || 5432
      , user = o.user || o.username || url.username || env.PGUSERNAME || env.PGUSER || osUsername()

  o.no_prepare && (o.prepare = false)
  query.sslmode && (query.ssl = query.sslmode, delete query.sslmode)
  'timeout' in o && (console.log('The timeout option is deprecated, use idle_timeout instead'), o.idle_timeout = o.timeout) // eslint-disable-line
  query.sslrootcert === 'system' && (query.ssl = 'verify-full')

  const ints = ['idle_timeout', 'connect_timeout', 'max_lifetime', 'max_pipeline', 'backoff', 'keep_alive']
  const defaults = {
    max             : globalThis.Cloudflare ? 3 : 10,
    ssl             : false,
    sslnegotiation  : null,
    idle_timeout    : null,
    connect_timeout : 30,
    max_lifetime    : max_lifetime,
    max_pipeline    : 100,
    backoff         : backoff,
    keep_alive      : 60,
    prepare         : true,
    debug           : false,
    fetch_types     : true,
    publications    : 'alltables',
    target_session_attrs: null
  }

  const options = {
    host            : Array.isArray(host) ? host : host.split(',').map(x => x.split(':')[0]),
    port            : Array.isArray(port) ? port : host.split(',').map(x => parseInt(x.split(':')[1] || port)),
    path            : o.path || host.indexOf('/') > -1 && host + '/.s.PGSQL.' + port,
    database        : o.database || o.db || (url.pathname || '').slice(1) || env.PGDATABASE || user,
    user            : user,
    pass            : o.pass || o.password || url.password || env.PGPASSWORD || '',
    ...Object.entries(defaults).reduce(
      (acc, [k, d]) => {
        const value = k in o ? o[k] : k in query
          ? (query[k] === 'disable' || query[k] === 'false' ? false : query[k])
          : env['PG' + k.toUpperCase()] || d
        acc[k] = typeof value === 'string' && ints.includes(k)
          ? +value
          : value
        return acc
      },
      {}
    ),
    connection      : {
      application_name: env.PGAPPNAME || 'postgres.js',
      ...o.connection,
      ...Object.entries(query).reduce((acc, [k, v]) => (k in defaults || (acc[k] = v), acc), {})
    },
    types           : o.types || {},
    target_session_attrs: tsa(o, url, env),
    onnotice        : o.onnotice,
    onnotify        : o.onnotify,
    onclose         : o.onclose,
    onparameter     : o.onparameter,
    socket          : o.socket,
    transform       : parseTransform(o.transform || { undefined: undefined }),
    parameters      : {},
    shared          : { retries: 0, typeArrayMap: {} },
    ...mergeUserTypes(o.types)
  }

  !options.fetch_types && addDefaultArrayTypes(options)
  return options
}

function tsa(o, url, env) {
  const x = o.target_session_attrs || url.searchParams.get('target_session_attrs') || env.PGTARGETSESSIONATTRS
  if (!x || ['read-write', 'read-only', 'primary', 'standby', 'prefer-standby'].includes(x))
    return x

  throw new Error('target_session_attrs ' + x + ' is not supported')
}

function backoff(retries) {
  return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20)
}

function max_lifetime() {
  return 60 * (30 + Math.random() * 30)
}

function parseTransform(x) {
  return {
    undefined: x.undefined,
    column: {
      from: typeof x.column === 'function' ? x.column : x.column && x.column.from,
      to: x.column && x.column.to
    },
    value: {
      from: typeof x.value === 'function' ? x.value : x.value && x.value.from,
      to: x.value && x.value.to
    },
    row: {
      from: typeof x.row === 'function' ? x.row : x.row && x.row.from,
      to: x.row && x.row.to
    }
  }
}

function parseUrl(url) {
  if (!url || typeof url !== 'string')
    return { url: { searchParams: new Map() } }

  let host = url
  host = host.slice(host.indexOf('://') + 3).split(/[?/]/)[0]
  host = decodeURIComponent(host.slice(host.indexOf('@') + 1))

  const urlObj = new URL(url.replace(host, host.split(',')[0]))

  return {
    url: {
      username: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      host: urlObj.host,
      hostname: urlObj.hostname,
      port: urlObj.port,
      pathname: urlObj.pathname,
      searchParams: urlObj.searchParams
    },
    multihost: host.indexOf(',') > -1 && host
  }
}

function osUsername() {
  try {
    return os.userInfo().username // eslint-disable-line
  } catch (_) {
    return process.env.USERNAME || process.env.USER || process.env.LOGNAME  // eslint-disable-line
  }
}

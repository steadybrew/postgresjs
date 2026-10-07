import { Buffer } from 'node:buffer'
import { setImmediate, clearImmediate } from '../polyfills.js'
import { net } from '../polyfills.js'
import { tls } from '../polyfills.js'
import { crypto } from '../polyfills.js'
import Stream from 'node:stream'
import { performance } from '../polyfills.js'

import { stringify, handleValue, addArrayType } from './types.js'
import { Errors } from './errors.js'
import Result from './result.js'
import Queue from './queue.js'
import { Query, CLOSE } from './query.js'
import b from './bytes.js'

export default Connection

let uid = 1

const Sync = b().S().end()
    , Flush = b().H().end()
    , SSLRequest = b().i32(8).i32(80877103).end(8)
    , ExecuteUnnamed = Buffer.concat([b().E().str(b.N).i32(0).end(), Sync])
    , DescribeUnnamed = b().D().str('S').str(b.N).end()
    , noop = () => { /* noop */ }

const Phase = { Closed: 0, Backoff: 1, Opening: 2, Negotiating: 3, Authenticating: 4, Initializing: 5, Ready: 6, Draining: 7, Closing: 8 }

const retryRoutines = new Set([
  'FetchPreparedStatement',
  'RevalidateCachedQuery',
  'transformAssignedExpr'
])

const errorFields = {
  83  : 'severity_local',    // S
  86  : 'severity',          // V
  67  : 'code',              // C
  77  : 'message',           // M
  68  : 'detail',            // D
  72  : 'hint',              // H
  80  : 'position',          // P
  112 : 'internal_position', // p
  113 : 'internal_query',    // q
  87  : 'where',             // W
  115 : 'schema_name',       // s
  116 : 'table_name',        // t
  99  : 'column_name',       // c
  100 : 'data type_name',    // d
  110 : 'constraint_name',   // n
  70  : 'file',              // F
  76  : 'line',              // L
  82  : 'routine'            // R
}

function Connection(options, queues = {}, { onopen = noop, onend = noop, onclose = noop, ondrain = noop } = {}) {
  const {
    sslnegotiation,
    ssl,
    max,
    user,
    host,
    port,
    database,
    parsers,
    transform,
    onnotice,
    onnotify,
    onparameter,
    max_pipeline,
    keep_alive,
    backoff,
    target_session_attrs
  } = options

  const sent = Queue()
      , id = uid++
      , backend = { pid: null, secret: null }
      , idleTimer = timer(end, options.idle_timeout)
      , lifeTimer = timer(end, options.max_lifetime)

  let socket = null
    , phase = Phase.Closed
    , generation = 0
    , acquisition = null
    , endRequested = false
    , endWaiters = []
    , inheritedBackoff = null
    , backoffTimer = null
    , connectTimer = null
    , errorResponse = null
    , result = new Result()
    , incoming = Buffer.alloc(0)
    , needsTypes = options.fetch_types
    , backendParameters = {}
    , statements = {}
    , statementId = Math.random().toString(36).slice(2)
    , statementCount = 1
    , remaining = 0
    , hostIndex = 0
    , length = 0
    , rows = 0
    , serverSignature = null
    , nextWriteTimer = null
    , incomings = null
    , results = null
    , stream = null
    , chunk = null
    , nonce = null
    , query = null
    , final = null

  const connection = {
    queue: queues.closed,
    idleTimer,
    connect: acquire,
    terminate,
    execute,
    cancel,
    release,
    end,
    count: 0,
    id
  }

  queues.closed && queues.closed.push(connection)

  return connection

  function transition(next) {
    generation++
    phase = next
  }

  function starting() {
    return phase >= Phase.Opening && phase <= Phase.Initializing
  }

  function held() {
    return connection.reserved || connection.queue === queues.reserved
  }

  function drained() {
    ondrain(connection) || closing(true)
  }

  function idle() {
    return !query && sent.length === 0
  }

  function backoffMs() {
    return (typeof backoff === 'function' ? backoff(options.shared.retries) : backoff) * 1000
  }

  function acquire(owner) {
    if (phase !== Phase.Closed)
      return queryError(owner, Errors.connection('CONNECTION_CLOSED', options))

    acquisition = { owner, attempts: 0, hostsTried: 0, lastError: null, deadline: null, expired: false }
    const wait = inheritedBackoff ? inheritedBackoff.at + inheritedBackoff.delay - performance.now() : 0
    inheritedBackoff = null
    wait > 0 ? enterBackoff(wait) : enterOpening()
  }

  function enterBackoff(ms) {
    transition(Phase.Backoff)
    const a = acquisition
    const attempt = generation
    const left = a.deadline === null ? Infinity : Math.max(0, a.deadline - performance.now())
    a.expired = left <= ms
    backoffTimer = setTimeout(() => {
      backoffTimer = null
      attempt === generation && (a.expired
        ? enterClosed(a.lastError || Errors.connection('CONNECT_TIMEOUT', options))
        : enterOpening())
    }, Math.min(ms, left))
  }

  function enterOpening() {
    transition(Phase.Opening)
    const a = acquisition
    const attempt = generation
    const ms = options.connect_timeout * 1000
    if (ms) {
      const now = performance.now()
      a.deadline === null && (a.deadline = now + ms * host.length)
      const left = a.deadline - now
      connectTimer = setTimeout(() => connectTimedOut(left <= ms), Math.min(ms, left))
    }
    a.hostsTried++
    backendParameters = {}
    Promise.resolve()
      .then(() => options.socket ? options.socket(options) : new net.Socket())
      .then(created => attempt === generation ? attach(created) : dispose(created))
      .catch(err => attempt === generation && fail(err))
  }

  function dispose(created) {
    created.on('error', noop)
    created.destroy()
  }

  function attach(created) {
    socket = created
    created.on('error', error)
    created.on('close', closed)
    created.on('drain', drain)

    if (options.socket)
      return ssl ? negotiate() : authenticate()

    created.on('connect', ssl ? negotiate : authenticate)

    if (options.path)
      return created.connect(options.path)

    created.ssl = ssl
    created.connect(port[hostIndex], host[hostIndex])
    created.host = host[hostIndex]
    created.port = port[hostIndex]

    hostIndex = (hostIndex + 1) % port.length
  }

  function negotiate() {
    transition(Phase.Negotiating)
    if (sslnegotiation === 'direct')
      return upgrade()

    const attempt = generation
    socket.once('data', x => attempt === generation && (
      x[0] === 83
        ? upgrade()
        : ssl === 'prefer'
          ? authenticate()
          : fail(Errors.generic('SSL_NOT_SUPPORTED', 'The server does not support SSL connections'))
    ))
    write(SSLRequest)
  }

  function upgrade() {
    try {
      const raw = socket
      const config = tlsConfig(raw)
      raw.removeAllListeners()
      socket = tls.connect(config)
      socket.on('secureConnect', authenticate)
      socket.on('error', error)
      socket.on('close', closed)
      socket.on('drain', drain)
    } catch (err) {
      fail(err)
    }
  }

  function tlsConfig(raw) {
    const config = {
      socket: raw,
      servername: net.isIP(raw.host) ? undefined : raw.host
    }

    if (sslnegotiation === 'direct')
      config.ALPNProtocols = ['postgresql']

    if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
      config.rejectUnauthorized = false
    else if (typeof ssl === 'object')
      Object.assign(config, ssl)

    return config
  }

  function authenticate() {
    transition(Phase.Authenticating)
    try {
      statements = {}
      needsTypes = options.fetch_types
      statementId = Math.random().toString(36).slice(2)
      statementCount = 1
      lifeTimer.start()
      socket.on('data', data)
      keep_alive && socket.setKeepAlive && socket.setKeepAlive(true, 1000 * keep_alive)
      write(StartupMessage())
    } catch (err) {
      fail(err)
    }
  }

  function connectTimedOut(expiring) {
    connectTimer = null
    if (!starting())
      return
    expiring && (acquisition.expired = true)
    fail(Errors.connection('CONNECT_TIMEOUT', options, socket), true)
  }

  function fail(err, persist = host.length > 1) {
    const a = acquisition
    a.attempts++
    a.lastError = err && err.code === 'CONNECT_TIMEOUT' && a.lastError ? a.lastError : err
    clearTimeout(connectTimer)
    connectTimer = null
    detach()
    resetSocketState(err)

    if (endRequested)
      return enterClosed(err)

    if (a.expired || (a.deadline !== null && performance.now() >= a.deadline))
      return enterClosed(a.lastError)

    if (a.hostsTried < host.length)
      return enterBackoff(0)

    options.shared.retries++
    if (!persist) {
      inheritedBackoff = { at: performance.now(), delay: backoffMs() }
      return enterClosed(err)
    }

    a.hostsTried = 0
    enterBackoff(backoffMs())
  }

  function detach() {
    clearTimeout(connectTimer)
    connectTimer = null
    idleTimer.cancel()
    lifeTimer.cancel()
    incoming = Buffer.alloc(0)
    remaining = 0
    incomings = null
    if (socket) {
      socket.removeAllListeners()
      socket.on('error', noop)
      socket.destroy()
      socket = null
    }
  }

  function enterClosed(err = Errors.connection('CONNECTION_CLOSED', options, socket)) {
    if (phase === Phase.Closed)
      return

    const a = acquisition
    const waiters = endWaiters
    clearTimeout(backoffTimer)
    backoffTimer = null
    detach()
    resetSocketState(err)
    acquisition = null
    endRequested = false
    endWaiters = []
    transition(Phase.Closed)
    a && queryError(a.owner, err)
    waiters.forEach(resolve => resolve())
    onclose(connection, err)
  }

  function closing(quit) {
    transition(Phase.Closing)
    idleTimer.cancel()
    lifeTimer.cancel()
    quit && socket.readyState === 'open'
      ? socket.end(b().X().end())
      : socket.destroy()
  }

  function handoff() {
    const owner = acquisition.owner
    transition(Phase.Ready)
    clearTimeout(connectTimer)
    connectTimer = null
    acquisition = null
    options.shared.retries = 0

    if (endRequested) {
      endRequested = false
      if (owner.reserve)
        return (queryError(owner, Errors.connection('CONNECTION_ENDED', options)), closing(true))
      if (owner.cancelled)
        return closing(true)
      transition(Phase.Draining)
      return execute(owner)
    }

    owner.reserve
      ? onopen(connection, owner)
      : owner.cancelled
        ? onopen(connection)
        : execute(owner)
  }

  async function cancel({ pid, secret }, resolve, reject) {
    let timeout = null
    try {
      let s = await Promise.resolve(options.socket ? options.socket(options) : new net.Socket())
      const request = b().i32(16).i32(80877102).i32(pid).i32(secret).end(16)
      const watch = x => {
        x.once('error', reject)
        x.on('error', noop)
        x.once('close', () => (clearTimeout(timeout), resolve()))
      }
      const upgrade = () => {
        const raw = s
        const config = tlsConfig(raw)
        raw.removeAllListeners()
        s = tls.connect(config)
        watch(s)
        s.once('secureConnect', () => s.write(request))
      }
      const start = !ssl
        ? () => s.write(request)
        : sslnegotiation === 'direct'
          ? upgrade
          : () => {
            s.once('data', x => x[0] === 83 || ssl !== 'prefer' ? upgrade() : s.write(request))
            s.write(SSLRequest)
          }

      watch(s)
      options.connect_timeout && (timeout = setTimeout(() => s.destroy(), options.connect_timeout * 1000))

      if (options.socket)
        return start()

      s.once('connect', start)

      if (options.path)
        return s.connect(options.path)

      s.ssl = ssl
      s.connect(port[0], host[0])
      s.host = host[0]
      s.port = port[0]
    } catch (error) {
      reject(error)
    }
  }

  function execute(q) {
    if (phase !== Phase.Ready && phase !== Phase.Draining && !(phase === Phase.Initializing && q.initialization))
      return queryError(q, Errors.connection('CONNECTION_CLOSED', options))

    if (stream)
      return queryError(q, Errors.generic('COPY_IN_PROGRESS', 'You cannot execute queries during copy'))

    if (q.cancelled)
      return

    try {
      q.state = backend
      query
        ? sent.push(q)
        : (query = q, query.active = true)

      build(q)
      return write(toBuffer(q))
        && !q.describeFirst
        && !q.cursorFn
        && sent.length < max_pipeline
    } catch (error) {
      sent.length === 0 && write(Sync)
      errored(error)
      return true
    }
  }

  function toBuffer(q) {
    if (q.parameters.length >= 65534)
      throw Errors.generic('MAX_PARAMETERS_EXCEEDED', 'Max number of parameters (65534) exceeded')

    return q.options.simple
      ? b().Q().str(q.statement.string + b.N).end()
      : q.describeFirst
        ? Buffer.concat([describe(q), Flush])
        : q.prepare
          ? q.prepared
            ? prepared(q)
            : Buffer.concat([describe(q), prepared(q)])
          : unnamed(q)
  }

  function describe(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types, q.statement.name),
      Describe('S', q.statement.name)
    ])
  }

  function prepared(q) {
    return Buffer.concat([
      Bind(q.parameters, q.statement.types, q.statement.name, q.cursorName),
      q.cursorFn
        ? Execute('', q.cursorRows)
        : ExecuteUnnamed
    ])
  }

  function unnamed(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types),
      DescribeUnnamed,
      prepared(q)
    ])
  }

  function build(q) {
    const parameters = []
        , types = []

    const string = stringify(q, q.strings[0], q.args[0], parameters, types, options)

    !q.tagged && q.args.forEach(x => handleValue(x, parameters, types, options))

    q.prepare = options.prepare && ('prepare' in q.options ? q.options.prepare : true)
    q.string = string
    q.signature = q.prepare && types + string
    q.onlyDescribe && (delete statements[q.signature])
    q.parameters = q.parameters || parameters
    q.prepared = q.prepare && q.signature in statements
    q.describeFirst = q.onlyDescribe || (parameters.length && !q.prepared)
    q.statement = q.prepared
      ? statements[q.signature]
      : { string, types, name: q.prepare ? statementId + statementCount++ : '' }

    typeof options.debug === 'function' && options.debug(id, string, parameters, types)
  }

  function write(x, fn) {
    chunk = chunk ? Buffer.concat([chunk, x]) : Buffer.from(x)
    if (fn || chunk.length >= 1024)
      return nextWrite(fn)
    nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite))
    return true
  }

  function nextWrite(fn) {
    const x = socket ? socket.write(chunk, fn) : false
    nextWriteTimer !== null && clearImmediate(nextWriteTimer)
    chunk = nextWriteTimer = null
    return x
  }

  function resetSocketState(err) {
    clearImmediate(nextWriteTimer)
    stream && (stream.destroy(err), stream = null)
    final && (final(err), final = null)
    query && queryError(query, err)
    while (sent.length)
      queryError(sent.shift(), err)
    query = results = errorResponse = chunk = nextWriteTimer = null
    result = new Result()
    rows = 0
    nonce = serverSignature = null
  }

  /* c8 ignore next 3 */
  function drain() {
    phase === Phase.Ready && !query && !held() && onopen(connection)
  }

  function data(x) {
    if (incomings) {
      incomings.push(x)
      remaining -= x.length
      if (remaining > 0)
        return
    }

    incoming = incomings
      ? Buffer.concat(incomings, length - remaining)
      : incoming.length === 0
        ? x
        : Buffer.concat([incoming, x], incoming.length + x.length)

    const source = socket
    while (incoming.length > 4) {
      length = incoming.readUInt32BE(1)
      if (length >= incoming.length) {
        remaining = length - incoming.length
        incomings = [incoming]
        break
      }

      try {
        handle(incoming.subarray(0, length + 1))
      } catch (e) {
        query && (query.cursorFn || query.describeFirst) && write(Sync)
        starting() ? fail(e) : errored(e)
      }
      if (socket !== source)
        return
      incoming = incoming.subarray(length + 1)
      remaining = 0
      incomings = null
    }
  }

  function error(err) {
    if (starting())
      return fail(err)

    if (phase === Phase.Ready || phase === Phase.Draining)
      socketFailed(err)
  }

  function socketFailed(err) {
    errored(err)
    while (sent.length)
      queryError(sent.shift(), err)
    query = null
    options.shared.retries++
    inheritedBackoff = { at: performance.now(), delay: backoffMs() }
    closing(false)
  }

  function errored(err) {
    stream && (stream.destroy(err), stream = null)
    query && queryError(query, err)
  }

  function queryError(query, err) {
    if (query.reserve)
      return query.reject(err)

    if (!err || typeof err !== 'object')
      err = new Error(err)

    'query' in err || 'parameters' in err || Object.defineProperties(err, {
      stack: { value: err.stack + query.origin.replace(/.*\n/, '\n'), enumerable: options.debug },
      query: { value: query.string, enumerable: options.debug },
      parameters: { value: query.parameters, enumerable: options.debug },
      args: { value: query.args, enumerable: options.debug },
      types: { value: query.statement && query.statement.types, enumerable: options.debug }
    })
    query.reject(err)
  }

  function end() {
    if (phase === Phase.Closed)
      return Promise.resolve()

    const done = new Promise(resolve => endWaiters.push(resolve))

    if (phase === Phase.Closing || phase === Phase.Draining)
      return done

    if (phase === Phase.Ready) {
      !held() && onend(connection)
      idle() && !held()
        ? closing(true)
        : transition(Phase.Draining)
      return done
    }

    if (acquisition.owner.reserve)
      enterClosed(Errors.connection('CONNECTION_ENDED', options))
    else if (phase === Phase.Backoff && acquisition.attempts > 0)
      enterClosed(acquisition.lastError)
    else if (!endRequested)
      (endRequested = true, onend(connection))

    return done
  }

  function terminate() {
    if (phase === Phase.Closed)
      return

    const destroyed = Errors.connection('CONNECTION_DESTROYED', options, socket)
    if (phase === Phase.Closing)
      return socket.destroy()

    if (phase !== Phase.Ready && phase !== Phase.Draining)
      return enterClosed(destroyed)

    const inflight = !idle()
    resetSocketState(destroyed)
    enterClosed(inflight ? destroyed : undefined)
  }

  function release() {
    phase === Phase.Ready
      ? onopen(connection)
      : phase === Phase.Draining && idle() && drained()
  }

  function closed(hadError) {
    const err = Errors.connection('CONNECTION_CLOSED', options, socket)
    if (starting())
      return fail(errorResponse || err, true)

    if (!inheritedBackoff && (phase !== Phase.Closing || hadError)) {
      hadError && options.shared.retries++
      inheritedBackoff = { at: performance.now(), delay: backoffMs() }
    }
    enterClosed(err)
  }


  /* Handlers */
  function handle(xs, x = xs[0]) {
    (
      x === 68 ? DataRow :                   // D
      x === 100 ? CopyData :                 // d
      x === 65 ? NotificationResponse :      // A
      x === 83 ? ParameterStatus :           // S
      x === 90 ? ReadyForQuery :             // Z
      x === 67 ? CommandComplete :           // C
      x === 50 ? BindComplete :              // 2
      x === 49 ? ParseComplete :             // 1
      x === 116 ? ParameterDescription :     // t
      x === 84 ? RowDescription :            // T
      x === 82 ? Authentication :            // R
      x === 110 ? NoData :                   // n
      x === 75 ? BackendKeyData :            // K
      x === 69 ? ErrorResponse :             // E
      x === 115 ? PortalSuspended :          // s
      x === 51 ? CloseComplete :             // 3
      x === 71 ? CopyInResponse :            // G
      x === 78 ? NoticeResponse :            // N
      x === 72 ? CopyOutResponse :           // H
      x === 99 ? CopyDone :                  // c
      x === 73 ? EmptyQueryResponse :        // I
      x === 86 ? FunctionCallResponse :      // V
      x === 118 ? NegotiateProtocolVersion : // v
      x === 87 ? CopyBothResponse :          // W
      /* c8 ignore next */
      UnknownMessage
    )(xs)
  }

  function DataRow(x) {
    let index = 7
    let length
    let column
    let value

    const valueFrom = !query.initialization && transform.value.from
    const rowFrom = !query.initialization && transform.row.from
    const row = query.isRaw ? new Array(query.statement.columns.length) : {}
    for (let i = 0; i < query.statement.columns.length; i++) {
      column = query.statement.columns[i]
      length = x.readInt32BE(index)
      index += 4

      value = length === -1
        ? null
        : query.isRaw === true
          ? x.subarray(index, index += length)
          : column.parser === undefined
            ? x.toString('utf8', index, index += length)
            : column.parser.array === true
              ? column.parser(x.toString('utf8', index + 1, index += length))
              : column.parser(x.toString('utf8', index, index += length))

      query.isRaw
        ? (row[i] = query.isRaw === true
          ? value
          : valueFrom ? transform.value.from(value, column) : value)
        : (row[column.name] = valueFrom ? transform.value.from(value, column) : value)
    }

    query.forEachFn
      ? query.forEachFn(rowFrom ? transform.row.from(row) : row, result)
      : (result[rows++] = rowFrom ? transform.row.from(row) : row)
  }

  function ParameterStatus(x) {
    const [k, v] = x.toString('utf8', 5, x.length - 1).split(b.N)
    backendParameters[k] = v
    if (options.parameters[k] !== v) {
      options.parameters[k] = v
      onparameter && onparameter(k, v)
    }
  }

  function ReadyForQuery(x) {
    if (query) {
      if (errorResponse) {
        if (query.initialization)
          return enterClosed(errorResponse)
        query.retried
          ? errored(query.retried)
          : query.prepared && retryRoutines.has(errorResponse.routine)
            ? retry(query, errorResponse)
            : errored(errorResponse)
      } else {
        query.initialization && query.initialization(results || result)
        query.resolve(results || result)
      }
    } else if (errorResponse) {
      errored(errorResponse)
    }

    query = results = errorResponse = null
    result = new Result()

    if (phase === Phase.Authenticating || phase === Phase.Initializing)
      return initialized()

    if (phase === Phase.Closing)
      return

    while (sent.length && (query = sent.shift()) && (query.active = true, query.cancelled))
      Connection(options).cancel(query.state, query.cancelled.resolve, query.cancelled.reject)

    if (query)
      return

    connection.reserved
      ? !connection.reserved.release && x[5] === 73
        ? phase === Phase.Draining
          ? drained()
          : (connection.reserved = null, onopen(connection))
        : connection.reserved()
      : phase === Phase.Draining
        ? drained()
        : onopen(connection)
  }

  function initialized() {
    if (target_session_attrs) {
      if (!backendParameters.in_hot_standby || !backendParameters.default_transaction_read_only)
        return fetchState()
      if (tryNext(target_session_attrs, backendParameters)) {
        acquisition.mismatch = true
        return fail(Errors.connection('CONNECTION_CLOSED', options, socket), true)
      }
    }

    if (needsTypes)
      return fetchArrayTypes()

    handoff()
  }

  function CommandComplete(x) {
    rows = 0

    for (let i = x.length - 1; i > 0; i--) {
      if (x[i] === 32 && x[i + 1] < 58 && result.count === null)
        result.count = +x.toString('utf8', i + 1, x.length - 1)
      if (x[i - 1] >= 65) {
        result.command = x.toString('utf8', 5, i)
        result.state = backend
        break
      }
    }

    final && (final(), final = null)

    if (result.command === 'BEGIN' && max !== 1 && !connection.reserved)
      return errored(Errors.generic('UNSAFE_TRANSACTION', 'Only use sql.begin, sql.reserved or max: 1'))

    if (query.options.simple)
      return BindComplete()

    if (query.cursorFn) {
      result.count && query.cursorFn(result)
      write(Sync)
    }
  }

  function ParseComplete() {
    query.parsing = false
  }

  function BindComplete() {
    !result.statement && (result.statement = query.statement)
    result.columns = query.statement.columns
  }

  function ParameterDescription(x) {
    const length = x.readUInt16BE(5)

    for (let i = 0; i < length; ++i)
      !query.statement.types[i] && (query.statement.types[i] = x.readUInt32BE(7 + i * 4))

    query.prepare && (statements[query.signature] = query.statement)
    query.describeFirst && !query.onlyDescribe && (write(prepared(query)), query.describeFirst = false)
  }

  function RowDescription(x) {
    if (result.command) {
      results = results || [result]
      results.push(result = new Result())
      result.count = null
      query.statement.columns = null
    }

    const length = x.readUInt16BE(5)
    let index = 7
    let start

    query.statement.columns = Array(length)

    for (let i = 0; i < length; ++i) {
      start = index
      while (x[index++] !== 0);
      const table = x.readUInt32BE(index)
      const number = x.readUInt16BE(index + 4)
      const type = x.readUInt32BE(index + 6)
      query.statement.columns[i] = {
        name: !query.initialization && transform.column.from
          ? transform.column.from(x.toString('utf8', start, index - 1))
          : x.toString('utf8', start, index - 1),
        parser: parsers[type],
        table,
        number,
        type
      }
      index += 18
    }

    result.statement = query.statement
    if (query.onlyDescribe)
      return (query.resolve(query.statement), write(Sync))
  }

  function Authentication(x, type = x.readUInt32BE(5)) {
    const attempt = generation
    Promise.resolve((
      type === 3 ? AuthenticationCleartextPassword :
      type === 5 ? AuthenticationMD5Password :
      type === 10 ? SASL :
      type === 11 ? SASLContinue :
      type === 12 ? SASLFinal :
      type !== 0 ? UnknownAuth :
      noop
    )(x, type, attempt)).catch(err => attempt === generation && enterClosed(err))
  }

  /* c8 ignore next 5 */
  async function AuthenticationCleartextPassword(x, type, attempt) {
    const payload = await Pass()
    if (attempt !== generation)
      return
    write(
      b().p().str(payload).z(1).end()
    )
  }

  async function AuthenticationMD5Password(x, type, attempt) {
    const payload = 'md5' + (
      await md5(
        Buffer.concat([
          Buffer.from(await md5((await Pass()) + user)),
          x.subarray(9)
        ])
      )
    )
    if (attempt !== generation)
      return
    write(
      b().p().str(payload).z(1).end()
    )
  }

  async function SASL(x, type, attempt) {
    const nextNonce = (await crypto.randomBytes(18)).toString('base64')
    if (attempt !== generation)
      return
    nonce = nextNonce
    b().p().str('SCRAM-SHA-256' + b.N)
    const i = b.i
    write(b.inc(4).str('n,,n=*,r=' + nonce).i32(b.i - i - 4, i).end())
  }

  async function SASLContinue(x, type, attempt) {
    const clientNonce = nonce
    const res = x.toString('utf8', 9).split(',').reduce((acc, x) => (acc[x[0]] = x.slice(2), acc), {})

    const saltedPassword = await crypto.pbkdf2Sync(
      await Pass(),
      Buffer.from(res.s, 'base64'),
      parseInt(res.i), 32,
      'sha256'
    )

    const clientKey = await hmac(saltedPassword, 'Client Key')

    const auth = 'n=*,r=' + clientNonce + ','
               + 'r=' + res.r + ',s=' + res.s + ',i=' + res.i
               + ',c=biws,r=' + res.r

    const signature = (await hmac(await hmac(saltedPassword, 'Server Key'), auth)).toString('base64')

    const payload = 'c=biws,r=' + res.r + ',p=' + xor(
      clientKey, Buffer.from(await hmac(await sha256(clientKey), auth))
    ).toString('base64')

    if (attempt !== generation)
      return
    serverSignature = signature
    write(
      b().p().str(payload).end()
    )
  }

  function SASLFinal(x) {
    if (x.toString('utf8', 9).split(b.N, 1)[0].slice(2) === serverSignature)
      return
    /* c8 ignore next 5 */
    enterClosed(Errors.generic('SASL_SIGNATURE_MISMATCH', 'The server did not return the correct signature'))
  }

  function Pass() {
    return Promise.resolve(typeof options.pass === 'function'
      ? options.pass()
      : options.pass
    )
  }

  function NoData() {
    result.statement = query.statement
    result.statement.columns = []
    if (query.onlyDescribe)
      return (query.resolve(query.statement), write(Sync))
  }

  function BackendKeyData(x) {
    backend.pid = x.readUInt32BE(5)
    backend.secret = x.readUInt32BE(9)
  }

  function fetchArrayTypes() {
    needsTypes = false
    initialize(`
      select b.oid, b.typarray
      from pg_catalog.pg_type a
      left join pg_catalog.pg_type b on b.oid = a.typelem
      where a.typcategory = 'A'
      group by b.oid, b.typarray
      order by b.oid
    `, types => types.forEach(({ oid, typarray }) => addArrayType(options, oid, typarray)))
  }

  function tryNext(x, xs) {
    return (
      (x === 'read-write' && xs.default_transaction_read_only === 'on') ||
      (x === 'read-only' && xs.default_transaction_read_only === 'off') ||
      (x === 'primary' && xs.in_hot_standby === 'on') ||
      (x === 'standby' && xs.in_hot_standby === 'off') ||
      (x === 'prefer-standby' && xs.in_hot_standby === 'off' && host.length > 1 && !acquisition.mismatch)
    )
  }

  function fetchState() {
    initialize(`
      show transaction_read_only;
      select pg_catalog.pg_is_in_recovery()
    `, ([[a], [b]]) => {
      backendParameters.default_transaction_read_only = a.transaction_read_only
      backendParameters.in_hot_standby = b.pg_is_in_recovery ? 'on' : 'off'
    }, true)
  }

  function initialize(string, resolve, simple = false) {
    transition(Phase.Initializing)
    const attempt = generation
    const q = new Query([string], [], q => attempt === generation
      ? execute(q)
      : queryError(q, Errors.connection('CONNECTION_CLOSED', options)), null, { simple })
    q.initialization = resolve
    q.catch(noop)
  }

  function ErrorResponse(x) {
    if (query) {
      (query.cursorFn || query.describeFirst) && write(Sync)
      errorResponse = Errors.postgres(parseError(x))
    } else {
      const err = Errors.postgres(parseError(x))
      phase === Phase.Ready || phase === Phase.Draining
        ? socketFailed(err)
        : phase === Phase.Authenticating && fail(err)
    }
  }

  function retry(q, error) {
    delete statements[q.signature]
    q.retried = error
    execute(q)
  }

  function NotificationResponse(x) {
    if (!onnotify)
      return

    let index = 9
    while (x[index++] !== 0);
    onnotify(
      x.toString('utf8', 9, index - 1),
      x.toString('utf8', index, x.length - 1)
    )
  }

  async function PortalSuspended() {
    const current = query
    const source = socket
    try {
      const x = await Promise.resolve(current.cursorFn(result))
      if (query !== current || socket !== source)
        return
      rows = 0
      x === CLOSE
        ? write(Close(current.portal))
        : (result = new Result(), write(Execute('', current.cursorRows)))
    } catch (err) {
      query === current && socket === source && write(Sync)
      current.reject(err)
    }
  }

  function CloseComplete() {
    result.count && query.cursorFn(result)
    query.resolve(result)
  }

  function CopyInResponse() {
    stream = new Stream.Writable({
      autoDestroy: true,
      write(chunk, encoding, callback) {
        socket.write(b().d().raw(chunk).end(), callback)
      },
      destroy(error, callback) {
        callback(error)
        socket && socket.readyState === 'open' && socket.write(b().f().str(error + b.N).end())
        stream = null
      },
      final(callback) {
        socket.write(b().c().end())
        final = callback
        stream = null
      }
    })
    query.resolve(stream)
  }

  function CopyOutResponse() {
    stream = new Stream.Readable({
      read() { socket.resume() }
    })
    query.resolve(stream)
  }

  /* c8 ignore next 3 */
  function CopyBothResponse() {
    stream = new Stream.Duplex({
      autoDestroy: true,
      read() { socket.resume() },
      /* c8 ignore next 11 */
      write(chunk, encoding, callback) {
        socket.write(b().d().raw(chunk).end(), callback)
      },
      destroy(error, callback) {
        callback(error)
        socket && socket.readyState === 'open' && socket.write(b().f().str(error + b.N).end())
        stream = null
      },
      final(callback) {
        socket.write(b().c().end())
        final = callback
      }
    })
    query.resolve(stream)
  }

  function CopyData(x) {
    stream && (stream.push(x.subarray(5)) || socket.pause())
  }

  function CopyDone() {
    stream && stream.push(null)
    stream = null
  }

  function NoticeResponse(x) {
    onnotice
      ? onnotice(parseError(x))
      : console.log(parseError(x)) // eslint-disable-line

  }

  /* c8 ignore next 3 */
  function EmptyQueryResponse() {
    /* noop */
  }

  /* c8 ignore next 3 */
  function FunctionCallResponse() {
    errored(Errors.notSupported('FunctionCallResponse'))
  }

  /* c8 ignore next 3 */
  function NegotiateProtocolVersion() {
    errored(Errors.notSupported('NegotiateProtocolVersion'))
  }

  /* c8 ignore next 3 */
  function UnknownMessage(x) {
    console.error('Postgres.js : Unknown Message:', x[0]) // eslint-disable-line
  }

  /* c8 ignore next 3 */
  function UnknownAuth(x, type) {
    console.error('Postgres.js : Unknown Auth:', type) // eslint-disable-line
  }

  /* Messages */
  function Bind(parameters, types, statement = '', portal = '') {
    let prev
      , type

    b().B().str(portal + b.N).str(statement + b.N).i16(0).i16(parameters.length)

    parameters.forEach((x, i) => {
      if (x === null)
        return b.i32(0xFFFFFFFF)

      type = types[i]
      x = type in options.serializers
        ? options.serializers[type](x)
        : '' + x

      prev = b.i
      b.inc(4).str(x).i32(b.i - prev - 4, prev)
    })

    b.i16(0)

    return b.end()
  }

  function Parse(str, parameters, types, name = '') {
    b().P().str(name + b.N).str(str + b.N).i16(parameters.length)
    parameters.forEach((x, i) => b.i32(types[i] || 0))
    return b.end()
  }

  function Describe(x, name = '') {
    return b().D().str(x).str(name + b.N).end()
  }

  function Execute(portal = '', rows = 0) {
    return Buffer.concat([
      b().E().str(portal + b.N).i32(rows).end(),
      Flush
    ])
  }

  function Close(portal = '') {
    return Buffer.concat([
      b().C().str('P').str(portal + b.N).end(),
      b().S().end()
    ])
  }

  function StartupMessage() {
    return b().inc(4).i16(3).z(2).str(
      Object.entries(Object.assign({
        user,
        database,
        client_encoding: 'UTF8'
      },
        options.connection
      )).filter(([, v]) => v).map(([k, v]) => k + b.N + v).join(b.N)
    ).z(2).end(0)
  }

}

function parseError(x) {
  const error = {}
  let start = 5
  for (let i = 5; i < x.length - 1; i++) {
    if (x[i] === 0) {
      error[errorFields[x[start]]] = x.toString('utf8', start + 1, i)
      start = i + 1
    }
  }
  return error
}

function md5(x) {
  return crypto.createHash('md5').update(x).digest('hex')
}

function hmac(key, x) {
  return crypto.createHmac('sha256', key).update(x).digest()
}

function sha256(x) {
  return crypto.createHash('sha256').update(x).digest()
}

function xor(a, b) {
  const length = Math.max(a.length, b.length)
  const buffer = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++)
    buffer[i] = a[i] ^ b[i]
  return buffer
}

function timer(fn, seconds) {
  seconds = typeof seconds === 'function' ? seconds() : seconds
  if (!seconds)
    return { cancel: noop, start: noop }

  let timer
  return {
    cancel() {
      timer && (clearTimeout(timer), timer = null)
    },
    start(...args) {
      timer && clearTimeout(timer)
      timer = setTimeout(() => done(args), seconds * 1000)
    }
  }

  function done(args) {
    timer = null
    fn.apply(null, args)
  }
}

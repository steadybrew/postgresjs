import dc from 'diagnostics_channel'
import { performance } from 'perf_hooks'

const supported = Boolean(dc) && typeof dc.tracingChannel === 'function'

export const queryChannel = supported ? dc.tracingChannel('postgres:query') : undefined
export const connectChannel = supported ? dc.tracingChannel('postgres:connect') : undefined
export const transactionChannel = supported ? dc.tracingChannel('postgres:transaction') : undefined
export const poolConnectChannel = supported ? dc.tracingChannel('postgres:pool:connect') : undefined
export const poolReleaseChannel = supported ? dc.channel('postgres:pool:release') : undefined
export const poolRemoveChannel = supported ? dc.channel('postgres:pool:remove') : undefined

export function watched(channel) {
  return channel !== undefined && (channel.hasSubscribers ?? channel.start.hasSubscribers)
}

export function run(channel, context, fn, ...args) {
  try {
    return channel.start.runStores(context, fn, undefined, ...args)
  } finally {
    channel.end.publish(context)
  }
}

export function resolved(channel, context) {
  channel.asyncStart.publish(context)
  channel.asyncEnd.publish(context)
}

export function rejected(channel, context, error) {
  context.error = error
  channel.error.publish(context)
  resolved(channel, context)
}

export function traceAsync(channel, context, fn) {
  return run(channel, context, fn).then(
    result => (resolved(channel, context), result),
    error => {
      rejected(channel, context, error)
      throw error
    }
  )
}

function serverOf({ host, port, path }) {
  return path
    ? { host: path, port: undefined }
    : host && host.length === 1
      ? { host: host[0], port: port[0] }
      : { host: undefined, port: undefined }
}

function clientOf(config) {
  return { database: config.database, ...serverOf(config), user: config.user, ssl: Boolean(config.ssl), processID: undefined }
}

export function connectContext(config) {
  const { database, host, port, user, ssl } = clientOf(config)
  return { connection: { database, host, port, user, ssl } }
}

export function connectAttempt(context, host, port) {
  context.connection.host = host
  context.connection.port = port
}

export function connectSecured(context, ssl) {
  context.connection.ssl = ssl
}

export function transactionContext(config, session, options, savepoint) {
  return { client: { ...clientOf(config), ...session }, options, savepoint, prepared: undefined }
}

export function transactionSession(context, session) {
  Object.assign(context.client, session)
}

export function transactionCommitted(context, committed) {
  context.result = { committed }
}

export function poolContext({ totalCount, idleCount, waitingCount, max }) {
  return { pool: { totalCount, idleCount, waitingCount, maxSize: max } }
}

export function poolAcquired(context, processID, reused, queuedBehind) {
  context.handoverTime = performance.timeOrigin + performance.now()
  context.queuedBehind = queuedBehind
  context.client = { processID, reused }
}

export function poolHandover(q, queuedBehind, session) {
  const wait = q.poolWait
  wait.context.handoverTime = performance.timeOrigin + performance.now()
  wait.context.queuedBehind = queuedBehind
  wait.context.client = { processID: session.processID, reused: !wait.fresh }
}

export function traceRoute(q, context, fn) {
  const wait = q.poolWait = { context, fresh: false, routing: true, activated: false, failure: undefined }
  try {
    return run(poolConnectChannel, context, fn, q)
  } finally {
    wait.routing = false
    settleRouted(q, wait)
  }
}

function settleRouted(q, wait) {
  if (q.poolWait !== wait || !(wait.activated || wait.failure))
    return

  q.poolWait = undefined
  if (wait.activated)
    resolved(poolConnectChannel, wait.context)
  else
    rejected(poolConnectChannel, wait.context, wait.failure.error)

  wait.failure && queryFailed(q, wait.failure.error)
}

export function poolStarted(q) {
  const wait = q.poolWait
  if (wait.routing) {
    wait.activated = true
    return
  }

  q.poolWait = undefined
  resolved(poolConnectChannel, wait.context)
}

function poolFailed(q, error) {
  const wait = q.poolWait
  q.poolWait = undefined
  rejected(poolConnectChannel, wait.context, error)
}

export function poolReleased(connection, error) {
  if (poolReleaseChannel && poolReleaseChannel.hasSubscribers)
    poolReleaseChannel.publish({ client: { processID: connection.session.processID }, error })
}

export function poolRemoved(processID, error) {
  poolRemoveChannel && poolRemoveChannel.hasSubscribers && poolRemoveChannel.publish({ client: { processID }, error })
}

export function traceQuery(q, fn) {
  q.trace = { query: { text: undefined, name: undefined }, client: clientOf(q.handler.config || {}) }
  return run(queryChannel, q.trace, fn, q)
}

export function queryBuilt(q, session) {
  const context = q.trace
  context.query.text = q.string
  context.query.name = q.statement.name || undefined
  Object.assign(context.client, session)
}

export function querySettled(q, result) {
  if (q.streaming && result && typeof result.pipe === 'function')
    return

  q.poolWait && poolStarted(q)
  const context = q.trace
  q.trace = undefined
  context.result = result
  resolved(queryChannel, context)
}

export function queryFailed(q, error) {
  if (q.poolWait) {
    if (q.poolWait.routing) {
      q.poolWait.failure = q.poolWait.failure || { error }
      return
    }

    poolFailed(q, error)
  }

  const context = q.trace
  q.trace = undefined
  rejected(queryChannel, context, error)
}

import dc from 'diagnostics_channel'
import { performance } from 'perf_hooks'

const supported = Boolean(dc) && typeof dc.tracingChannel === 'function'

export const queryChannel = supported ? dc.tracingChannel('postgres:query') : undefined
export const connectChannel = supported ? dc.tracingChannel('postgres:connect') : undefined
export const transactionChannel = supported ? dc.tracingChannel('postgres:transaction') : undefined
export const poolConnectChannel = supported ? dc.tracingChannel('postgres:pool:connect') : undefined
const poolReleaseChannel = supported ? dc.channel('postgres:pool:release') : undefined
const poolRemoveChannel = supported ? dc.channel('postgres:pool:remove') : undefined

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

export function publishResolved(channel, context) {
  channel.asyncStart.publish(context)
  channel.asyncEnd.publish(context)
}

export function publishRejected(channel, context, error) {
  context.error = error
  channel.error.publish(context)
  publishResolved(channel, context)
}

export function traceAsync(channel, context, fn) {
  return run(channel, context, fn).then(
    result => (publishResolved(channel, context), result),
    error => {
      publishRejected(channel, context, error)
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

export function transactionContext(config, { mode, savepoint, session }) {
  return { client: { ...clientOf(config), ...session }, options: mode, savepoint, prepared: undefined }
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

export function poolSpan(r, context) {
  r.pool = context
  r.reserve && (r.trace = true)
}

export function poolHandover(r, c, fresh) {
  const context = r.pool
  context.handoverTime = performance.timeOrigin + performance.now()
  context.queuedBehind = c.active + c.pipelined
  context.client = { processID: c.processID, reused: !fresh }
}

export function poolEnded(r) {
  const context = r.pool
  r.pool = undefined
  publishResolved(poolConnectChannel, context)
}

function poolFailed(r, error) {
  const context = r.pool
  r.pool = undefined
  context.handoverTime === undefined
    ? publishRejected(poolConnectChannel, context, error)
    : publishResolved(poolConnectChannel, context)
}

export function poolReleased(processID, error) {
  watched(poolReleaseChannel) && poolReleaseChannel.publish({ client: { processID }, error })
}

export function poolRemoved(processID, error) {
  watched(poolRemoveChannel) && poolRemoveChannel.publish({ client: { processID }, error })
}

export function traceQuery(q, fn) {
  q.trace = { query: { text: undefined, name: undefined }, client: clientOf(q.handler.options) }
  return run(queryChannel, q.trace, fn, q)
}

export function queryBuilt(q, session) {
  const context = q.trace
  context.query.text = q.string
  context.query.name = q.statement.name || undefined
  Object.assign(context.client, session)
}

export function traceSucceeded(r, value) {
  r.pool && poolEnded(r)
  const context = r.trace
  r.trace = undefined
  if (r.reserve)
    return

  context.result = value
  publishResolved(queryChannel, context)
}

export function traceFailed(r, error) {
  r.pool && poolFailed(r, error)
  const context = r.trace
  r.trace = undefined
  r.reserve || publishRejected(queryChannel, context, error)
}

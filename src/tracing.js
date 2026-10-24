import dc from 'diagnostics_channel'

const supported = Boolean(dc) && typeof dc.tracingChannel === 'function'

export const queryChannel = supported ? dc.tracingChannel('postgres:query') : undefined
export const connectChannel = supported ? dc.tracingChannel('postgres:connect') : undefined
export const transactionChannel = supported ? dc.tracingChannel('postgres:transaction') : undefined
export const poolConnectChannel = supported ? dc.tracingChannel('postgres:pool:connect') : undefined
export const sendChannel = supported ? dc.channel('postgres:query:send') : undefined
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

export function poolAcquired(context, processID, reused) {
  context.client = { processID, reused }
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

export function querySent(q, session) {
  const context = q.trace
  context.query.text = q.string
  context.query.name = q.statement.name || undefined
  Object.assign(context.client, session)
  sendChannel.hasSubscribers && sendChannel.publish(context)
}

export function querySettled(q, result) {
  if (q.streaming && result && typeof result.pipe === 'function')
    return

  const context = q.trace
  q.trace = undefined
  context.result = result
  resolved(queryChannel, context)
}

export function queryFailed(q, error) {
  const context = q.trace
  q.trace = undefined
  rejected(queryChannel, context, error)
}

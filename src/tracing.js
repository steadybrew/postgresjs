import dc from 'diagnostics_channel'

const supported = Boolean(dc) && typeof dc.tracingChannel === 'function'

export const queryChannel = supported ? dc.tracingChannel('postgres:query') : undefined
export const connectionChannel = supported ? dc.tracingChannel('postgres:connection') : undefined
export const transactionChannel = supported ? dc.tracingChannel('postgres:transaction') : undefined
export const sendChannel = supported ? dc.channel('postgres:query:send') : undefined
export const closeChannel = supported ? dc.channel('postgres:connection:close') : undefined

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

export function serverOf({ host, port, path }) {
  return path
    ? { serverAddress: path, serverPort: undefined }
    : host.length === 1
      ? { serverAddress: host[0], serverPort: port[0] }
      : { serverAddress: undefined, serverPort: undefined }
}

export function traceQuery(q, fn) {
  const config = q.handler.config
  q.trace = {
    query: undefined,
    values: undefined,
    database: config && config.database,
    user: config && config.user,
    ...config && serverOf(config),
    connectionId: undefined
  }
  return run(queryChannel, q.trace, fn, q)
}

export function querySent(q, connectionId, serverAddress, serverPort) {
  const context = q.trace
  context.query = q.string
  context.values = q.parameters
  context.connectionId = connectionId
  context.serverAddress = serverAddress
  context.serverPort = serverPort
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

export function connectionClosed(connectionId, error) {
  closeChannel && closeChannel.hasSubscribers && closeChannel.publish({ connectionId, error })
}

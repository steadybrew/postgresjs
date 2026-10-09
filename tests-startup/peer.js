import net from 'net'

export function frames(onFrame, startup = false) {
  let pending = Buffer.alloc(0)
  return chunk => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= (startup ? 4 : 5)) {
      const length = pending.readUInt32BE(startup ? 0 : 1)
      if (length < 4 || length > 1024 * 1024)
        throw new Error('Invalid protocol frame length: ' + length)
      const size = length + (startup ? 0 : 1)
      if (pending.length < size)
        return
      const message = pending.subarray(0, size)
      pending = pending.subarray(size)
      const type = startup ? 'startup' : String.fromCharCode(message[0])
      startup = false
      onFrame(type, message)
    }
  }
}

export function message(type, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(5)
  header[0] = type.charCodeAt(0)
  header.writeUInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

const ready = (status = 'I') => message('Z', Buffer.from(status))
const complete = command => message('C', Buffer.from(command + '\0'))

function rowset(columns, values) {
  const descriptions = columns.map(([name, oid]) => {
    const column = Buffer.alloc(18)
    column.writeUInt32BE(oid, 6)
    column.writeInt16BE(-1, 10)
    column.writeInt32BE(-1, 12)
    return Buffer.concat([Buffer.from(name + '\0'), column])
  })
  const count = Buffer.alloc(2)
  count.writeUInt16BE(columns.length)
  const rows = values.map(row => message('D', Buffer.concat([count, ...row.map(value => {
    const data = Buffer.from(String(value))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, data])
  })])))
  return Buffer.concat([message('T', Buffer.concat([count, ...descriptions])), ...rows, complete('SELECT ' + values.length)])
}

export async function peer({ catalogError = false, holdStartup = false, failAuthentication = false, catalogRows = [],
                             closeStartup = 0, closeCatalog = 0, holdCatalog = false, holdSession = false,
                             closeAfterError = false, sessionError = false, fatalAfterSession = false, fatalDuringSession = false,
                             readOnly = false, standby = false, passwordAuth = false, allowHalfOpen = false,
                             holdQuery = '', fatalQuery = '', failQuery = '', closeQuery = '', holdStatement = '', sslReply = '', port = 0,
                             onStartup = () => { /* Optional startup barrier. */ }, onEvent = () => { /* Optional protocol observer. */ } } = {}) {
  const events = []
  const sockets = new Set()
  const startupReplies = []
  let connections = 0
  let held = null
  const onFrames = new Map()
  const denied = failure => message('E', Buffer.from(
    'SERROR\0C40002\0Mstatement denied\0' + (typeof failure === 'string' ? 'R' + failure + '\0' : '') + '\0'
  ))
  const server = net.createServer({ allowHalfOpen }, socket => {
    sockets.add(socket)
    const pid = ++connections
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', error => events.push({ error: error.code }))
    const authenticated = () => {
      const key = Buffer.alloc(8)
      key.writeUInt32BE(pid, 0)
      socket.write(Buffer.concat([message('R', Buffer.alloc(4)), message('K', key), rdy()]))
    }
    let statement = ''
    let status = 'I'
    const rdy = () => ready(status)
    const tag = text => {
      const word = text.trim().toLowerCase()
      if (word.startsWith('begin'))
        return status = 'T', 'BEGIN'
      if (word.startsWith('commit') || word === 'rollback')
        return status = 'I', word.toUpperCase()
      return ''
    }
    const outsideTransaction = text => status === 'I' && /^\s*savepoint\b/i.test(text)
    const noTransaction = () => message('E', Buffer.from('SERROR\0C25P01\0MSAVEPOINT can only be used in transaction blocks\0\0'))
    const hold = (synced, reply) => {
      held = { socket, synced, blocked: [], reply: failure => socket.write(reply(failure)) }
    }
    let parameters = Buffer.from([0, 0])
    let parse
    const onFrame = (type, frame, replay) => {
      if (type === 'startup' && frame.length === 8 && frame.readUInt32BE(4) === 80877103) {
        events.push({ type: 'ssl', pid })
        socket.write(sslReply || 'N')
        parse = frames(onFrame, true)
        return
      }
      if (type === 'startup' && frame.length === 16 && frame.readUInt32BE(4) === 80877102) {
        const cancel = { type: 'cancel', pid, backend: frame.readUInt32BE(8), secret: frame.readUInt32BE(12) }
        events.push(cancel)
        onEvent(cancel)
        socket.end()
        return
      }
      const event = replay || { type, pid, sql: type === 'Q' ? frame.subarray(5, -1).toString() : undefined }
      replay || (events.push(event), onEvent(event))
      if (held && held.socket === socket) {
        type === 'S' && !held.synced ? held.synced = true : held.blocked.push([type, frame, event])
        return
      }
      if (type === 'p') {
        authenticated()
      } else if (type === 'P') {
        const end = frame.indexOf(0, 5)
        const queryEnd = frame.indexOf(0, end + 1)
        statement = frame.subarray(end + 1, queryEnd).toString()
        parameters = frame.subarray(queryEnd + 1)
        event.text = statement
        socket.write(message('1'))
      } else if (type === 'B') {
        socket.write(message('2'))
      } else if (type === 'D') {
        socket.write(message('t', parameters))
        socket.write(statement.includes('pg_catalog.pg_type') && catalogRows.length
          ? rowset([['oid', 23], ['typarray', 23]], []).subarray(0, 1 + rowset([['oid', 23], ['typarray', 23]], []).readUInt32BE(1))
          : message('n'))
      } else if (type === 'E') {
        if (holdStatement && statement.toLowerCase().includes(holdStatement)) {
          const text = statement
          holdStatement = ''
          hold(false, failure => failure
            ? Buffer.concat([denied(failure), rdy()])
            : Buffer.concat([complete(tag(text) || 'SELECT 0'), rdy()]))
          return
        } else if (fatalQuery && statement.includes(fatalQuery)) {
          socket.end(message('E', Buffer.from('SFATAL\0C57P01\0Mterminating connection\0\0')))
        } else if (outsideTransaction(statement)) {
          socket.write(noTransaction())
        } else if (holdCatalog && statement.includes('pg_catalog.pg_type')) {
          return
        } else if (statement.includes('pg_catalog.pg_type') && pid <= closeCatalog) {
          socket.destroy()
        } else if (catalogError && statement.includes('pg_catalog.pg_type') && (catalogError === true || pid === 1)) {
          const error = message('E', Buffer.from('SERROR\0C42501\0Mcatalog denied\0\0'))
          closeAfterError ? socket.end(error) : socket.write(error)
        } else if (statement.includes('pg_catalog.pg_type') && catalogRows.length) {
          const result = rowset([['oid', 23], ['typarray', 23]], catalogRows)
          socket.write(result.subarray(1 + result.readUInt32BE(1)))
        } else {
          socket.write(complete(tag(statement) || 'SELECT 0'))
        }
      } else if (type === 'S') {
        const failing = closeAfterError && catalogError && (catalogError === true || pid === 1)
        if (!holdCatalog && !socket.destroyed && !socket.writableEnded && !failing && pid > closeCatalog)
          socket.write(rdy())
      } else if (type === 'startup') {
        const reply = authenticated
        if (pid <= closeStartup)
          socket.destroy()
        else if (failAuthentication && (failAuthentication === 'always' || pid === 1))
          socket.end(message('E', Buffer.from('SFATAL\0C28P01\0Mauthentication denied\0\0')))
        else if (passwordAuth && (passwordAuth === true || pid === 1))
          socket.write(message('R', Buffer.from([0, 0, 0, 3])))
        else if (holdStartup)
          startupReplies.push(reply)
        else
          reply()
        onStartup(socket)
      } else if (type === 'Q') {
        if (frame.subarray(5, -1).toString().startsWith('copy ')) {
          socket.write(message(frame.subarray(5, -1).toString().includes('from stdin') ? 'G' : 'H', Buffer.from([0, 0, 1, 0, 0])))
          return
        }
        if (fatalQuery && frame.subarray(5, -1).toString().includes(fatalQuery))
          return socket.end(message('E', Buffer.from('SFATAL\0C57P01\0Mterminating connection\0\0')))
        if (holdQuery && frame.subarray(5, -1).toString().includes(holdQuery))
          return
        if (holdStatement && frame.subarray(5, -1).toString().toLowerCase().includes(holdStatement)) {
          const text = frame.subarray(5, -1).toString()
          holdStatement = ''
          hold(true, failure => failure
            ? Buffer.concat([denied(failure), rdy()])
            : Buffer.concat([complete(tag(text) || 'SELECT 0'), rdy()]))
          return
        }
        if (closeQuery && frame.subarray(5, -1).toString().includes(closeQuery))
          return socket.end(message('E', Buffer.from('SERROR\0C22012\0Mdivision by zero\0\0')))
        if (failQuery && frame.subarray(5, -1).toString().includes(failQuery)) {
          socket.write(Buffer.concat([message('E', Buffer.from('SERROR\0C42601\0Msyntax denied\0\0')), rdy()]))
          return
        }
        if (outsideTransaction(frame.subarray(5, -1).toString())) {
          socket.write(Buffer.concat([noTransaction(), rdy()]))
          return
        }
        const session = frame.subarray(5, -1).toString().includes('transaction_read_only')
        const catalog = frame.subarray(5, -1).toString().includes('pg_catalog.pg_type')
        const command = session || catalog ? '' : tag(frame.subarray(5, -1).toString().replace(/\0$/, ''))
        if (session) {
          if (holdSession)
            return
          const fatal = message('E', Buffer.from('SFATAL\0C57P01\0Mterminating connection\0\0'))
          const answer = fatalDuringSession ? fatal : sessionError
            ? Buffer.concat([message('E', Buffer.from('SERROR\0C42501\0Msession denied\0\0')), rdy()])
            : Buffer.concat([rowset([['transaction_read_only', 25]], [[readOnly ? 'on' : 'off']]),
                             rowset([['pg_is_in_recovery', 16]], [[standby ? 't' : 'f']]), rdy()])
          fatalAfterSession
            ? socket.end(Buffer.concat([answer, fatal]))
            : fatalDuringSession ? socket.end(answer) : socket.write(answer)
        } else if (catalog && catalogError) {
          socket.write(Buffer.concat([message('E', Buffer.from('SERROR\0C42501\0Mcatalog denied\0\0')), rdy()]))
        } else if (catalog) {
          socket.write(Buffer.concat([complete('SELECT 0'), rdy()]))
        } else if (command) {
          socket.write(Buffer.concat([complete(command), rdy()]))
        } else {
          const column = Buffer.alloc(18)
          column.writeUInt32BE(23, 6)
          column.writeInt16BE(4, 10)
          column.writeInt32BE(-1, 12)
          socket.write(Buffer.concat([
            message('T', Buffer.concat([Buffer.from([0, 1]), Buffer.from('marker\0'), column])),
            message('D', Buffer.from([0, 1, 0, 0, 0, 2, 52, 50])), complete('SELECT 1'), rdy()
          ]))
        }
      } else if (type === 'X') {
        !allowHalfOpen && socket.end()
      }
    }
    onFrames.set(pid, onFrame)
    parse = frames(onFrame, true)
    socket.on('data', chunk => parse(chunk))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    events,
    hold: text => holdStatement = text,
    releaseStatement: failure => {
      const { reply, blocked } = held
      held = null
      reply(failure)
      blocked.forEach(([type, frame, event]) => onFrames.get(event.pid)(type, frame, event))
    },
    heldStatement: () => held,
    releaseStartup: () => startupReplies.splice(0).forEach(reply => reply()),
    disconnect: () => sockets.forEach(socket => socket.destroy()),
    reset: () => sockets.forEach(socket => socket.resetAndDestroy()),
    fatal: () => sockets.forEach(socket => socket.end(message('E', Buffer.from('SFATAL\0C57P01\0Mterminating connection\0\0')))),
    sockets,
    close: () => new Promise(resolve => {
      sockets.forEach(socket => socket.destroy())
      server.close(resolve)
    })
  }
}

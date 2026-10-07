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

const ready = () => message('Z', Buffer.from('I'))
const complete = command => message('C', Buffer.from(command + '\0'))

export async function peer({ catalogError = false, onEvent = () => { /* Optional protocol observer. */ } } = {}) {
  const events = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', error => events.push({ error: error.code }))
    let statement = ''
    socket.on('data', frames((type, frame) => {
      events.push({ type, sql: type === 'Q' ? frame.subarray(5, -1).toString() : undefined })
      onEvent(events[events.length - 1])
      if (type === 'P') {
        const end = frame.indexOf(0, 5)
        statement = frame.subarray(end + 1, frame.indexOf(0, end + 1)).toString()
        socket.write(message('1'))
      } else if (type === 'B') {
        socket.write(message('2'))
      } else if (type === 'D') {
        socket.write(message('n'))
      } else if (type === 'E') {
        if (catalogError && statement.includes('pg_catalog.pg_type'))
          socket.write(message('E', Buffer.from('SERROR\0C42501\0Mcatalog denied\0\0')))
        else
          socket.write(complete('SELECT 0'))
      } else if (type === 'S') {
        socket.write(ready())
      } else if (type === 'startup') {
        const key = Buffer.alloc(8)
        key.writeUInt32BE(100 + events.length, 0)
        socket.write(Buffer.concat([message('R', Buffer.alloc(4)), message('K', key), ready()]))
      } else if (type === 'Q') {
        const catalog = frame.subarray(5, -1).toString().includes('pg_catalog.pg_type')
        if (catalog && catalogError) {
          socket.write(Buffer.concat([message('E', Buffer.from('SERROR\0C42501\0Mcatalog denied\0\0')), ready()]))
        } else if (catalog) {
          socket.write(Buffer.concat([complete('SELECT 0'), ready()]))
        } else {
          const column = Buffer.alloc(18)
          column.writeUInt32BE(23, 6)
          column.writeInt16BE(4, 10)
          column.writeInt32BE(-1, 12)
          socket.write(Buffer.concat([
            message('T', Buffer.concat([Buffer.from([0, 1]), Buffer.from('marker\0'), column])),
            message('D', Buffer.from([0, 1, 0, 0, 0, 2, 52, 50])), complete('SELECT 1'), ready()
          ]))
        }
      } else if (type === 'X') {
        socket.end()
      }
    }, true))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    events,
    close: () => new Promise(resolve => {
      sockets.forEach(socket => socket.destroy())
      server.close(resolve)
    })
  }
}

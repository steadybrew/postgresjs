import assert from 'assert'
import net from 'net'
import { frames, message } from './peer.js'
import { bounded } from './bounded.js'

export const copyNames = ['out-done-paused', 'out-error-paused']

const int16 = n => {
  const x = Buffer.alloc(2)
  x.writeInt16BE(n)
  return x
}
const int32 = n => {
  const x = Buffer.alloc(4)
  x.writeInt32BE(n)
  return x
}
const ready = message('Z', Buffer.from('I'))
const copyOut = message('H', Buffer.concat([Buffer.from([0]), int16(1), int16(0)]))
const failure = message('E', Buffer.from('SERROR\0C57014\0Mcopy cancelled\0\0'))
const column = Buffer.concat([int16(1), Buffer.from('x\0'), int32(0), int16(0), int32(23), int16(4), int32(-1), int16(0)])
const row = Buffer.concat([int16(1), int32(1), Buffer.from('1')])

async function server(size, ending) {
  const sockets = new Set()
  const listener = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let copy = false
    let out = []
    const read = frames((type, frame) => {
      if (type === 'startup')
        return socket.write(Buffer.concat([message('R', int32(0)), message('K', Buffer.alloc(8)), ready]))
      if (type === 'Q' || type === 'P')
        copy = /copy/i.test(frame.toString('utf8', 5))
      const data = message('d', Buffer.alloc(size, 120))
      const select = [message('D', row), message('C', Buffer.from('SELECT 1\0'))]
      if (type === 'P') {
        out.push(message('1'))
      } else if (type === 'B') {
        out.push(message('2'))
      } else if (type === 'D') {
        frame[5] === 83 && out.push(message('t', int16(0)))
        out.push(copy ? message('n') : message('T', column))
      } else if (type === 'E') {
        out.push(...copy ? [copyOut, data, ending] : select)
      } else if (type === 'Q') {
        out.push(...copy ? [copyOut, data, ending, ready] : [message('T', column), ...select, ready])
      } else if (type === 'S') {
        out.push(ready)
      } else if (type === 'X') {
        return socket.end()
      }
      if (type === 'S' || type === 'Q') {
        socket.write(Buffer.concat(out.filter(Boolean)))
        out = []
      }
    }, true)
    socket.on('data', read)
  })
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  return {
    port: listener.address().port,
    close: () => new Promise(resolve => {
      sockets.forEach(x => x.destroy())
      listener.close(resolve)
    })
  }
}

export async function copy(name, postgres) {
  assert(copyNames.includes(name), 'Unknown copy scenario ' + name)
  const done = name === 'out-done-paused'
  const peer = await server(70000, done ? Buffer.concat([message('c'), message('C', Buffer.from('COPY 1\0'))]) : failure)
  const sql = postgres({ host: '127.0.0.1', port: peer.port, user: 'fixture', database: 'fixture', ssl: false,
                         fetch_types: false, max: 1, onnotice: false })
  try {
    const readable = await bounded(sql`copy (select 1) to stdout`.readable(), 'copy to stdout never started')
    readable.on('error', () => undefined)
    await new Promise(resolve => setTimeout(resolve, 200))
    let length = 0
    let failed = null
    try {
      for await (const chunk of readable)
        length += chunk.length
    } catch (error) {
      failed = error.code
    }
    const next = await bounded(sql`select 1 as x`.then(x => x[0].x), 'connection left paused after COPY TO')
    assert.strictEqual(next, 1)
    assert.strictEqual(failed, done ? null : '57014')
    done && assert.strictEqual(length, 70000)
  } finally {
    await bounded(sql.end({ timeout: 0 }), 'sql.end', 2000)
    await peer.close()
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Frames } from '../src/messages.js'

const frame = (type, body) => {
  const x = Buffer.alloc(5 + body.length)
  x[0] = type.charCodeAt(0)
  x.writeUInt32BE(4 + body.length, 1)
  Buffer.from(body).copy(x, 5)
  return x
}

const collect = (chunks, frames = Frames()) => {
  const got = []
  chunks.forEach(chunk => frames.push(chunk, message => { got.push(Buffer.from(message)) }))
  return got
}

const random = (seed) => (n) => (seed = (seed * 16807) % 2147483647) % n

test('messages inside one chunk are handed out as views of that chunk', () => {
  const chunk = Buffer.concat([frame('T', 'abc'), frame('D', ''), frame('C', 'SELECT 1\0')])
  const views = []
  Frames().push(chunk, message => { views.push(message) })
  assert.equal(views.length, 3)
  views.forEach(view => assert.equal(view.buffer, chunk.buffer))
  assert.deepEqual(views.map(x => String.fromCharCode(x[0])), ['T', 'D', 'C'])
})

test('a stream split at every byte position yields the same messages', () => {
  const sent = [frame('T', 'header'), frame('D', 'a row of data'), frame('1', ''), frame('C', 'SELECT 2\0')]
  const all = Buffer.concat(sent)
  for (let cut = 0; cut <= all.length; cut++) {
    for (let second = cut; second <= all.length; second += 3)
      assert.deepEqual(collect([all.subarray(0, cut), all.subarray(cut, second), all.subarray(second)]), sent, `cuts ${ cut }, ${ second }`)
  }
})

test('one byte per chunk yields every message', () => {
  const sent = [frame('T', 'x'.repeat(30)), frame('D', ''), frame('Z', 'I')]
  const all = Buffer.concat(sent)
  assert.deepEqual(collect(Array.from(all, (_, i) => all.subarray(i, i + 1))), sent)
})

test('a message larger than many chunks arrives whole', () => {
  const big = frame('D', Buffer.alloc(100000, 7))
  const chunks = []
  for (let i = 0; i < big.length; i += 1500)
    chunks.push(big.subarray(i, i + 1500))
  assert.deepEqual(collect(chunks), [big])
})

test('random streams in random chunks arrive intact and in order', () => {
  const next = random(11)
  for (let trial = 0; trial < 200; trial++) {
    const sent = Array.from({ length: 1 + next(30) }, () =>
      frame(String.fromCharCode(65 + next(26)), Buffer.from(Array.from({ length: next(10) === 0 ? next(5000) : next(60) }, () => next(256))))
    )
    const all = Buffer.concat(sent)
    const chunks = []
    for (let i = 0; i < all.length;) {
      const n = 1 + next(next(4) === 0 ? 7 : 3000)
      chunks.push(all.subarray(i, i + n))
      i += n
    }
    assert.deepEqual(collect(chunks), sent, 'trial ' + trial)
  }
})

test('returning false stops the chunk, and reset discards what is buffered', () => {
  const frames = Frames()
  const got = []
  frames.push(Buffer.concat([frame('A', 'one'), frame('B', 'two'), frame('C', 'three').subarray(0, 4)]), message => {
    got.push(String.fromCharCode(message[0]))
    return false
  })
  assert.deepEqual(got, ['A'])
  frames.reset()
  assert.deepEqual(collect([frame('D', 'fresh')], frames), [frame('D', 'fresh')])
})

test('after a drop mid-header or mid-body, reset leaves no bytes for the next connection', () => {
  for (const cut of [1, 3, 4, 5, 9]) {
    const frames = Frames()
    assert.deepEqual(collect([frame('T', 'a partial description').subarray(0, cut)], frames), [])
    frames.reset()
    const next = [frame('R', '\0\0\0\0'), frame('Z', 'I')]
    assert.deepEqual(collect([Buffer.concat(next)], frames), next, 'cut at ' + cut)
  }
})

test('a reply that is not PostgreSQL does not allocate the length its header claims', () => {
  const frames = Frames()
  const reply = Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
  const before = process.memoryUsage().arrayBuffers
  const got = []
  for (let i = 0; i < 100; i++)
    frames.push(reply, message => { got.push(message) })
  assert.deepEqual(got, [])
  assert(process.memoryUsage().arrayBuffers - before < 1 << 20, 'allocated ' + (process.memoryUsage().arrayBuffers - before) + ' bytes')
})

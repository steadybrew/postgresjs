import assert from 'assert'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { peer } from './peer.js'
import { sleep } from './startup.js'

export const cfNames = ['destroy-early', 'late-connect', 'late-end', 'own-close', 'own-close-reject', 'own-close-tls',
                        'own-close-tls-reject', 'read-cancel', 'read-cancel-tls', 'error-live', 'error-closed', 'error-closed-tls',
                        'ssl-eof', 'core-plain', 'core-tls']

const tracked = ['connect', 'data', 'close', 'error', 'secureConnect']

function fakeRaw(options = {}) {
  let resolve
    , reject
  const reader = {
    pending: null,
    read: () => new Promise((a, b) => { reader.pending = { resolve: a, reject: b } }),
    releaseLock() { /* Fake. */ }
  }
  const raw = {
    closeCalls: 0,
    closeMode: 'resolve',
    readMode: 'done',
    closed: new Promise((a, b) => { resolve = a; reject = b }),
    resolveClosed: () => resolve(),
    rejectClosed: error => reject(error),
    close() {
      raw.closeCalls++
      raw.closeMode === 'reject' ? reject(new TypeError('Stream was cancelled.')) : raw.closeMode === 'resolve' && resolve()
      raw.reader.pending && raw.readMode !== 'none' && (raw.readMode === 'done'
        ? raw.reader.pending.resolve({ done: true })
        : raw.reader.pending.reject(new TypeError('Stream was cancelled.')))
      return Promise.resolve()
    },
    writable: { getWriter: () => ({ ready: Promise.resolve(), write: () => Promise.resolve(), releaseLock() { /* Fake. */ } }) },
    readable: { getReader: () => reader },
    startTls() {
      raw.tls = fakeRaw(options)
      return raw.tls
    },
    reader
  }
  return raw
}

const dirs = []

async function patched() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgresjs-cf-'))
  dirs.push(dir)
  fs.cpSync(new URL('../cf', import.meta.url), path.join(dir, 'cf'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'cf/polyfills.js')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('import(\'cloudflare:sockets\')', 'globalThis.__sockets()'))
  return dir
}

async function load(sockets) {
  const dir = await patched()
  globalThis.__sockets = sockets
  return { dir, ...await import(pathToFileURL(path.join(dir, 'cf/polyfills.js')).href) }
}

async function harness({ gated = false, ssl = false } = {}) {
  const raws = []
  let release
  const gate = new Promise(resolve => release = resolve)
  const mod = await load(async() => {
    gated && await gate
    return { connect: () => raws[raws.push(fakeRaw()) - 1] }
  })
  const socket = new mod.net.Socket()
  socket.ssl = ssl
  const events = []
  tracked.forEach(x => socket.on(x, error => events.push(x === 'error' ? 'error:' + error.message : x)))
  return { ...mod, socket, raws, release, events }
}

async function upgrade(t) {
  t.socket.connect(5432, 'h')
  await sleep(5)
  t.raws[0].reader.pending.resolve({ done: false, value: new Uint8Array([83]) })
  await sleep(5)
  t.tls.connect({ socket: t.socket, servername: 'h' })
  await sleep(5)
  t.raws[0].resolveClosed()
  await sleep(5)
  return t.raws[0].tls
}

function once(events, expected) {
  assert.strictEqual(events.filter(x => x === 'close').length, 1, 'close emitted ' + JSON.stringify(events))
  assert.deepStrictEqual(events.filter(x => x.startsWith('error')), expected, 'errors ' + JSON.stringify(events))
  expected.length && assert(events.findIndex(x => x.startsWith('error')) < events.indexOf('close'), 'error must precede close')
}

export async function cf(name) {
  const uncaught = []
  const observe = error => uncaught.push(error.message)
  process.on('uncaughtException', observe)
  process.on('unhandledRejection', observe)
  try {
    if (name.startsWith('core-'))
      await core(name === 'core-tls')
    else
      await cases[name]()
    await sleep(20)
    assert.deepStrictEqual(uncaught, [])
  } finally {
    process.off('uncaughtException', observe)
    process.off('unhandledRejection', observe)
    dirs.forEach(x => fs.rmSync(x, { recursive: true, force: true }))
  }
}

const cases = {
  async 'destroy-early'() {
    const t = await harness({ gated: true })
    t.socket.connect(5432, 'h')
    assert.doesNotThrow(() => t.socket.destroy())
    t.release()
    await sleep(20)
    assert.deepStrictEqual(t.raws.map(x => x.closeCalls), [1])
    once(t.events, [])
    assert(!t.events.includes('connect'))
  },
  async 'late-connect'() {
    const t = await harness({ gated: true })
    t.socket.connect(5432, 'h')
    t.socket.destroy()
    t.socket.end()
    t.release()
    await sleep(20)
    assert.deepStrictEqual(t.raws.map(x => x.closeCalls), [1])
    assert.deepStrictEqual(t.events, ['close'])
  },
  async 'late-end'() {
    const t = await harness({ gated: true })
    t.socket.connect(5432, 'h')
    t.socket.end()
    t.release()
    await sleep(20)
    assert.deepStrictEqual(t.raws.map(x => x.closeCalls), [1])
    assert.deepStrictEqual(t.events, ['close'])
    assert.strictEqual(t.socket.readyState, 'closed')
  },
  async 'own-close'() {
    const t = await harness()
    t.socket.connect(5432, 'h')
    await sleep(5)
    t.socket.destroy()
    await sleep(20)
    once(t.events, [])
  },
  async 'own-close-reject'() {
    const t = await harness()
    t.socket.connect(5432, 'h')
    await sleep(5)
    t.raws[0].closeMode = 'reject'
    t.raws[0].readMode = 'reject'
    t.socket.destroy()
    await sleep(20)
    once(t.events, [])
  },
  async 'own-close-tls'() {
    const t = await harness({ ssl: true })
    const tls = await upgrade(t)
    t.socket.destroy()
    await sleep(20)
    assert.strictEqual(tls.closeCalls, 1)
    once(t.events, [])
  },
  async 'own-close-tls-reject'() {
    const t = await harness({ ssl: true })
    const tls = await upgrade(t)
    tls.closeMode = 'reject'
    tls.readMode = 'none'
    t.socket.destroy()
    await sleep(20)
    once(t.events, [])
  },
  async 'read-cancel'() {
    const t = await harness()
    t.socket.connect(5432, 'h')
    await sleep(5)
    t.raws[0].closeMode = 'none'
    t.raws[0].readMode = 'none'
    t.socket.end()
    t.raws[0].reader.pending.reject(new TypeError('Stream was cancelled.'))
    await sleep(20)
    once(t.events, [])
  },
  async 'read-cancel-tls'() {
    const t = await harness({ ssl: true })
    const tls = await upgrade(t)
    tls.closeMode = 'none'
    tls.readMode = 'none'
    t.socket.end()
    tls.reader.pending.reject(new TypeError('Stream was cancelled.'))
    await sleep(20)
    once(t.events, [])
  },
  async 'error-live'() {
    const t = await harness()
    t.socket.connect(5432, 'h')
    await sleep(5)
    t.raws[0].reader.pending.reject(new Error('boom'))
    await sleep(20)
    once(t.events, ['error:boom'])
  },
  async 'error-closed'() {
    const t = await harness()
    t.socket.connect(5432, 'h')
    await sleep(5)
    t.raws[0].rejectClosed(new Error('Network connection lost'))
    await sleep(20)
    once(t.events, ['error:Network connection lost'])
  },
  async 'error-closed-tls'() {
    const t = await harness({ ssl: true })
    const tls = await upgrade(t)
    tls.rejectClosed(new Error('Network connection lost'))
    await sleep(20)
    once(t.events, ['error:Network connection lost'])
  },
  async 'ssl-eof'() {
    const t = await harness({ ssl: true })
    t.socket.connect(5432, 'h')
    await sleep(5)
    t.raws[0].reader.pending.resolve({ done: true, value: undefined })
    await sleep(20)
    once(t.events, [])
  }
}

function netConnect(port) {
  const socket = net.connect(port, '127.0.0.1')
  const state = { chunks: [], waiter: null, finished: false }
  const push = x => state.waiter ? (state.waiter(x), state.waiter = null) : state.chunks.push(x)
  socket.on('data', x => push({ done: false, value: new Uint8Array(x) }))
  socket.on('close', () => {
    state.finished = true
    push({ done: true })
  })
  socket.on('error', () => { /* Observed through close. */ })
  const read = () => state.chunks.length
    ? Promise.resolve(state.chunks.shift())
    : state.finished ? Promise.resolve({ done: true }) : new Promise(resolve => state.waiter = resolve)
  const make = (closed, cancel, startTls) => ({
    closed,
    startTls,
    close() {
      cancel(new TypeError('Stream was cancelled.'))
      socket.destroy()
      return Promise.resolve()
    },
    writable: { getWriter: () => ({ ready: Promise.resolve(), write: data => new Promise(resolve => socket.write(data, resolve)),
                                    releaseLock() { /* Fake. */ } }) },
    readable: { getReader: () => ({ read, releaseLock() { /* Fake. */ } }) }
  })
  const lifetime = () => {
    let resolve
      , reject
    const closed = new Promise((a, b) => { resolve = a; reject = b })
    socket.once('close', resolve)
    return { closed, resolve, reject }
  }
  const parent = lifetime()
  return make(parent.closed, parent.reject, () => {
    setTimeout(parent.resolve, 1)
    const child = lifetime()
    return make(child.closed, child.reject)
  })
}

async function core(ssl) {
  const server = await peer({ sslReply: ssl ? 'S' : '' })
  const dir = await patched()
  globalThis.__sockets = async() => ({ connect: (address) => netConnect(Number(address.split(':')[1])) })
  const { default: postgres } = await import(pathToFileURL(path.join(dir, 'cf/src/index.js')).href)
  const sql = postgres({ host: '127.0.0.1', port: server.port, user: 'fixture', database: 'fixture', ssl: ssl ? 'require' : false,
                         fetch_types: false, max: 1, connect_timeout: 2 })
  try {
    assert.strictEqual((await sql.unsafe('select 42 as marker', [], { simple: true }))[0].marker, 42)
    assert.strictEqual(server.events.some(x => x.type === 'ssl'), ssl)
    let timer
    const outcome = await Promise.race([sql.end().then(() => 'resolved'), new Promise(resolve => timer = setTimeout(resolve, 3000, 'hung'))])
    clearTimeout(timer)
    assert.strictEqual(outcome, 'resolved')
  } finally {
    await sql.end({ timeout: 0 })
    await server.close()
  }
}

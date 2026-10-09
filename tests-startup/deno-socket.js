/* global Deno */
import { net, tls } from '../deno/polyfills.js'

for (const mode of ['tcp', 'tls']) {
  for (const outcome of ['resolve', 'reject']) {
    Deno.test('Destroyed pending ' + mode + ' socket ignores late ' + outcome, async() => {
      const original = mode === 'tcp' ? Deno.connect : Deno.startTls
      let resolve
        , reject
      const pending = new Promise((a, b) => { resolve = a; reject = b })
      const key = mode === 'tcp' ? 'connect' : 'startTls'
      Deno[key] = () => pending
      let closes = 0
        , connections = 0
        , errors = 0
        , resourcesClosed = 0
        , reads = 0
      const raw = { close: () => resourcesClosed++, read: () => { reads++; return Promise.resolve(null) } }
      const socket = new net.Socket()
      socket.on('close', () => closes++)
      socket.on(mode === 'tcp' ? 'connect' : 'secureConnect', () => connections++)
      socket.on('error', () => errors++)
      try {
        if (mode === 'tcp') {
          socket.connect(5432, 'localhost')
        } else {
          socket.raw = raw
          tls.connect({ socket })
        }
        socket.destroy()
        socket.destroy()
        const immediateState = socket.readyState
        const immediateCloses = closes
        outcome === 'resolve' ? resolve(raw) : reject(new Error('late connection rejection'))
        await new Promise(r => setTimeout(r, 0))
        if (immediateState !== 'closed' || socket.readyState !== 'closed')
          throw new Error('Destroyed socket accepted a late connection')
        if (immediateCloses !== 0 || closes !== 1)
          throw new Error('Close must be asynchronous and emitted exactly once')
        if (connections || errors || reads)
          throw new Error('Late completion emitted events or read a closed socket')
        if (resourcesClosed !== (outcome === 'resolve' ? 1 : 0))
          throw new Error('Late successful connection was not closed exactly once')
      } finally {
        Deno[key] = original
        socket.destroy()
      }
    })
  }
}

for (const method of ['destroy', 'end']) {
  Deno.test('Paused socket emits close after ' + method, async() => {
    const original = Deno.connect
    let first = true
      , released = false
      , closes = 0
    const raw = {
      close: () => released = true,
      read: async b => {
        if (first) {
          first = false
          b[0] = 1
          return 1
        }
        if (released)
          throw new Deno.errors.BadResource()
        return new Promise(() => undefined)
      }
    }
    Deno.connect = () => Promise.resolve(raw)
    const socket = new net.Socket()
    try {
      socket.on('close', () => closes++)
      socket.on('data', () => socket.pause())
      socket.connect(5432, 'localhost')
      await new Promise(r => setTimeout(r, 10))
      if (!socket.isPaused())
        throw new Error('Socket never paused')
      socket[method]()
      await new Promise(r => setTimeout(r, 10))
      if (closes !== 1 || socket.readyState !== 'closed')
        throw new Error('Paused socket did not emit close exactly once')
    } finally {
      Deno.connect = original
    }
  })
}

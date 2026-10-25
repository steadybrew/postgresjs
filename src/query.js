import { queryChannel, watched, traceQuery, traceSucceeded, traceFailed } from './tracing.js'

const originCache = new Map()
    , originStackCache = new Map()
    , originError = Symbol('OriginError')

export const CLOSE = {}
export const Stage = { New: 0, Queued: 1, Opening: 2, Sent: 3, Active: 4, Settled: 5 }

const check = globalThis[Symbol.for('postgres.js:check')]
const stageNames = Object.keys(Stage)

export function step(r, next) {
  const from = r.stage
  if (from === Stage.Settled)
    return

  check && check('step', r, stageNames[from], stageNames[next])
  r.stage = next
}

export function succeed(r, value) {
  if (r.stage === Stage.Settled)
    return

  check && check('requestSettled', r, stageNames[r.stage])
  r.stage = Stage.Settled
  r.trace && traceSucceeded(r, value)
  r.resolve(value)
}

export function fail(r, error) {
  if (r.stage === Stage.Settled)
    return

  check && check('requestSettled', r, stageNames[r.stage])
  r.stage = Stage.Settled
  r.trace && traceFailed(r, error)
  r.reject(error)
}

export class Query extends Promise {
  constructor(strings, args, handler, canceller, options = {}) {
    let resolve
      , reject

    super((a, b) => {
      resolve = a
      reject = b
    })

    this.tagged = Array.isArray(strings.raw)
    this.strings = strings
    this.args = args
    this.handler = handler
    this.canceller = canceller
    this.options = options

    this.state = null
    this.statement = null
    this.stage = Stage.New

    // dd-trace's load-time rewrite only accepts single-expression arrows here
    this.resolve = x => (this.active = false, this.settled = true, resolve(x))
    this.reject = x => (this.active = false, this.settled = true, reject(x))

    this.active = false
    this.settled = false
    this.cancelled = null
    this.executed = false
    this.trace = undefined
    this.pool = undefined
    this.signature = ''

    this[originError] = this.handler.options.debug
      ? new Error()
      : this.tagged && cachedError(this.strings)
  }

  get origin() {
    return (this.handler.options.debug
      ? this[originError].stack
      : this.tagged && originStackCache.has(this.strings)
        ? originStackCache.get(this.strings)
        : originStackCache.set(this.strings, this[originError].stack).get(this.strings)
    ) || ''
  }

  static get [Symbol.species]() {
    return Promise
  }

  cancel() {
    if (!this.canceller || this.settled)
      return Promise.resolve()

    Promise.prototype.then.call(this, undefined, () => undefined)
    const cancelled = this.canceller(this)
    this.canceller = null
    cancelled.catch(() => undefined)
    return cancelled
  }

  simple() {
    this.options.simple = true
    this.options.prepare = false
    return this
  }

  async readable() {
    this.simple()
    this.streaming = true
    return this
  }

  async writable() {
    this.simple()
    this.streaming = true
    return this
  }

  cursor(rows = 1, fn) {
    this.options.simple = false
    if (typeof rows === 'function') {
      fn = rows
      rows = 1
    }

    this.cursorRows = rows

    if (typeof fn === 'function')
      return (this.cursorFn = fn, this)

    let prev
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.executed && !this.active)
            return { done: true }

          prev && prev()
          const promise = new Promise((resolve, reject) => {
            this.cursorFn = value => {
              resolve({ value, done: false })
              return new Promise(r => prev = r)
            }
            this.resolve = () => (this.active = false, resolve({ done: true }))
            this.reject = x => (this.active = false, reject(x))
          })
          this.execute()
          return promise
        },
        return() {
          prev && prev(CLOSE)
          return { done: true }
        }
      })
    }
  }

  describe() {
    this.options.simple = false
    this.onlyDescribe = this.options.prepare = true
    return this
  }

  stream() {
    throw new Error('.stream has been renamed to .forEach')
  }

  forEach(fn) {
    this.forEachFn = fn
    this.handle()
    return this
  }

  raw() {
    this.isRaw = true
    return this
  }

  values() {
    this.isRaw = 'values'
    return this
  }

  handle() {
    if (this.executed)
      return

    this.executed = true
    return watched(queryChannel) && this.stage === Stage.New && !this.initialization
      ? traceQuery(this, dispatch)
      : dispatch(this)
  }

  execute() {
    this.handle()
    return this
  }

  then() {
    this.handle()
    return super.then.apply(this, arguments)
  }

  catch() {
    this.handle()
    return super.catch.apply(this, arguments)
  }

  finally() {
    this.handle()
    return super.finally.apply(this, arguments)
  }
}

async function dispatch(q) {
  await 1
  check && check('routed', q)
  q.handler(q)
}

function cachedError(xs) {
  if (originCache.has(xs))
    return originCache.get(xs)

  const x = Error.stackTraceLimit
  Error.stackTraceLimit = 4
  originCache.set(xs, new Error())
  Error.stackTraceLimit = x
  return originCache.get(xs)
}

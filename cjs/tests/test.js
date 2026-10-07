/* eslint no-console: 0 */

const util = require('util')

let done = 0
let registered = 0
let only = false
let ignored = 0
let failed = false
let promise = Promise.resolve()
const tests = {}
    , ignore = {}

const nt = module.exports.nt = () => ignored++
const ot = module.exports.ot = (...rest) => (only = true, test(true, ...rest))
const t = module.exports.t = (...rest) => test(false, ...rest)
t.timeout = 5

async function test(o, name, options, fn) {
  typeof options !== 'object' && (fn = options, options = {})
  const line = new Error().stack.split('\n')[3].match(':([0-9]+):')[1]

  await 1

  if (only && !o)
    return

  const id = ++registered
  tests[id] = { fn, line, name }
  promise = promise.then(() => Promise.race([
    new Promise((resolve, reject) =>
      fn.timer = setTimeout(() => reject('Timed out'), (options.timeout || t.timeout) * 1000)
    ),
    failed
      ? (ignored++, ignore)
      : fn()
  ]))
    .then(async x => {
      clearTimeout(fn.timer)
      if (x === ignore)
        return

      if (!Array.isArray(x))
        throw new Error('Test should return result array')

      const [expected, got] = await Promise.all(x)
      if (expected !== got) {
        failed = true
        throw new Error(util.inspect(expected) + ' != ' + util.inspect(got))
      }

      tests[id].succeeded = true
      process.stdout.write('✅')
    })
    .catch(err => {
      tests[id].failed = failed = true
      tests[id].error = err instanceof Error ? err : new Error(util.inspect(err))
    })
    .then(() => {
      ++done === Object.keys(tests).length && exit()
    })
}

function exit() {
  let success = true
  Object.values(tests).every((x) => {
    if (x.succeeded)
      return true

    success = false
    x.cleanup
      ? console.error('⛔️', x.name + ' at line', x.line, 'cleanup failed', '\n', util.inspect(x.cleanup))
      : console.error('⛔️', x.name + ' at line', x.line, x.failed
        ? 'failed'
        : 'never finished', x.error ? '\n' + util.inspect(x.error) : ''
      )
  })

  only
    ? console.error('⚠️', 'Not all tests were run')
    : ignored
      ? console.error('⚠️', ignored, 'ignored test' + (ignored === 1 ? '' : 's', '\n'))
      : success
        ? console.log('🎉')
        : console.error('⚠️', 'Not good')

  !process.exitCode && (!success || only || ignored) && (process.exitCode = 1)
}


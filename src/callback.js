export default function callback(fn, ...args) {
  try {
    fn && fn(...args)
  } catch (e) {
    queueMicrotask(() => { throw e })
  }
}

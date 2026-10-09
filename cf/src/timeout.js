const maxDelay = 2 ** 31 - 1

export default function clampedTimeout(fn, ms) {
  return setTimeout(fn, Math.min(ms, maxDelay))
}

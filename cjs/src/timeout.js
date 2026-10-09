const maxDelay = 2 ** 31 - 1

module.exports = clampedTimeout;function clampedTimeout(fn, ms) {
  return setTimeout(fn, Math.min(ms, maxDelay))
}

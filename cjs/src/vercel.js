module.exports.vercelPool = vercelPool;function vercelPool(sql) {
  const idle_timeout = sql.options.idle_timeout
  if (typeof idle_timeout !== 'number' || !(idle_timeout > 0))
    throw new Error('vercelPool requires idle_timeout to be a positive number of seconds')

  return {
    options: {
      idleTimeoutMillis: idle_timeout * 1000
    },
    on(event, fn) {
      if (event !== 'release')
        return

      const previous = sql.options.onidle
      sql.options.onidle = previous
        ? id => (fn(), previous(id))
        : () => fn()
    }
  }
}

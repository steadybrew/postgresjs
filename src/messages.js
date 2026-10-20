function uint32(x, i) {
  return ((x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]) >>> 0
}

export function Frames() {
  let parts = null
    , size = 0
    , filled = 0

  return { push, reset }

  function reset() {
    parts = null
    size = filled = 0
  }

  function push(x, each) {
    let i = 0
    if (parts) {
      if (!size) {
        const head = x.subarray(0, 5 - filled)
        parts.push(head)
        filled += head.length
        i = head.length
        if (filled < 5)
          return
        size = uint32(Buffer.concat(parts, 5), 1) + 1
      }
      const n = Math.max(0, Math.min(size - filled, x.length - i))
      n && parts.push(x.subarray(i, i + n))
      filled += n
      i += n
      if (filled < size)
        return
      const message = parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
      reset()
      if (each(message) === false)
        return
    }

    while (x.length - i > 4) {
      const length = uint32(x, i + 1) + 1
      if (length > x.length - i)
        break
      if (each(x.subarray(i, i + length)) === false)
        return
      i += length
    }

    if (i === x.length)
      return
    const rest = x.subarray(i)
    parts = [rest]
    filled = rest.length
    size = rest.length > 4 ? uint32(rest, 1) + 1 : 0
  }
}

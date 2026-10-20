function uint32(x, i) {
  return ((x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]) >>> 0
}

const sliceable = typeof Buffer.prototype.utf8Slice === 'function'

export function text(x, start, end = x.length) {
  end > x.length && (end = x.length)
  return end <= start
    ? ''
    : sliceable
      ? x.utf8Slice(start, end)
      : x.toString('utf8', start, end)
}

export function cell(x, start, end) {
  end > x.length && (end = x.length)
  return (end - start < 9 && ascii(x, start, end - start)) || text(x, start, end)
}

function ascii(x, s, n) {
  if (x[s] > 127)
    return null
  switch (n) {
  case 1: return String.fromCharCode(x[s])
  case 2: return x[s + 1] > 127 ? null : String.fromCharCode(x[s], x[s + 1])
  case 3: return (x[s + 1] | x[s + 2]) > 127 ? null : String.fromCharCode(x[s], x[s + 1], x[s + 2])
  case 4: return (x[s + 1] | x[s + 2] | x[s + 3]) > 127 ? null : String.fromCharCode(x[s], x[s + 1], x[s + 2], x[s + 3])
  case 5: return (x[s + 1] | x[s + 2] | x[s + 3] | x[s + 4]) > 127
    ? null
    : String.fromCharCode(x[s], x[s + 1], x[s + 2], x[s + 3], x[s + 4])
  case 6: return (x[s + 1] | x[s + 2] | x[s + 3] | x[s + 4] | x[s + 5]) > 127
    ? null
    : String.fromCharCode(x[s], x[s + 1], x[s + 2], x[s + 3], x[s + 4], x[s + 5])
  case 7: return (x[s + 1] | x[s + 2] | x[s + 3] | x[s + 4] | x[s + 5] | x[s + 6]) > 127
    ? null
    : String.fromCharCode(x[s], x[s + 1], x[s + 2], x[s + 3], x[s + 4], x[s + 5], x[s + 6])
  case 8: return (x[s + 1] | x[s + 2] | x[s + 3] | x[s + 4] | x[s + 5] | x[s + 6] | x[s + 7]) > 127
    ? null
    : String.fromCharCode(x[s], x[s + 1], x[s + 2], x[s + 3], x[s + 4], x[s + 5], x[s + 6], x[s + 7])
  default: return null
  }
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

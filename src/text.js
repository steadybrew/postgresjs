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

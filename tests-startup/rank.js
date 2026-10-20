export function rankTest(a, b) {
  const all = [...a.map((x) => [x, 0]), ...b.map((x) => [x, 1])].sort((x, y) => x[0] - y[0])
  const n = all.length
  let rankA = 0
    , ties = 0
  for (let i = 0; i < n;) {
    let j = i
    while (j < n && all[j][0] === all[i][0]) j++
    const t = j - i
    ties += t * t * t - t
    for (let k = i; k < j; k++) all[k][1] === 0 && (rankA += (i + j + 1) / 2)
    i = j
  }
  const u = rankA - a.length * (a.length + 1) / 2
  const mean = a.length * b.length / 2
  const sd = Math.sqrt(a.length * b.length / 12 * ((n + 1) - ties / (n * (n - 1))))
  return sd ? 0.5 * erfc((u - mean - 0.5) / sd / Math.SQRT2) : 1
}

function erfc(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x))
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? y : 2 - y
}

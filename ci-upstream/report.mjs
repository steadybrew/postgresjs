import fs from 'fs'
import path from 'path'

const [dir, out] = process.argv.slice(2)
const summaries = fs.readdirSync(dir)
  .map(x => path.join(dir, x, 'summary.json'))
  .filter(x => fs.existsSync(x))
  .map(x => JSON.parse(fs.readFileSync(x, 'utf8')))

const status = t => !t ? 'missing'
  : t.file.result === 'pass' ? 'pass'
  : t.isolated.every(x => x.result === 'pass') && t.isolated.length ? 'pass-isolated'
  : t.isolated.some(x => x.result === 'pass') ? 'flaky'
  : 'fail'

const passing = s => s === 'pass' || s === 'pass-isolated'
const suites = [...new Set(summaries.map(x => x.suite))].sort()
const rows = []
const lines = ['| suite | upstream registered | upstream pass | upstream pass-isolated | upstream flaky | upstream fail | fork registered | fork pass | fork pass-isolated | fork flaky | fork fail | fork missing |', '|' + ' --- |'.repeat(12)]

for (const suite of suites) {
  const up = summaries.find(x => x.suite === suite && x.side === 'upstream')
  const fork = summaries.find(x => x.suite === suite && x.side === 'fork')
  if (!up || !up.tests) {
    rows.push({ suite, script: true, upstream: up && { process: up.process, seeds: up.seeds && up.seeds.length, tail: up.tail }, fork: fork && { process: fork.process, seeds: fork.seeds && fork.seeds.length, tail: fork.tail } })
    continue
  }
  const key = t => t.line + ' ' + t.name
  const forkTests = new Map((fork && fork.tests || []).map(t => [key(t), t]))
  const upTests = new Map(up.tests.map(t => [key(t), t]))
  const all = [...new Set([...upTests.keys(), ...forkTests.keys()])]
  const tally = { upstream: {}, fork: {} }
  for (const k of all) {
    const u = upTests.get(k)
    const f = forkTests.get(k)
    const us = status(u)
    const fs_ = status(f)
    tally.upstream[us] = (tally.upstream[us] || 0) + 1
    tally.fork[fs_] = (tally.fork[fs_] || 0) + 1
    const t = u || f
    rows.push({
      suite,
      line: t.line,
      name: t.name,
      upstream: us,
      fork: fs_,
      candidate: passing(us) && !passing(fs_),
      upstreamError: u && (u.file.error || (u.isolated.find(x => x.error) || {}).error),
      forkError: f && (f.isolated.find(x => x.error) || {}).error || f && f.file.error,
      forkFileError: f && f.file.error
    })
  }
  const c = (side, k) => tally[side][k] || 0
  lines.push('| ' + [suite, up.tests.length, c('upstream', 'pass'), c('upstream', 'pass-isolated'), c('upstream', 'flaky'), c('upstream', 'fail'),
    fork ? fork.tests.length : 0, c('fork', 'pass'), c('fork', 'pass-isolated'), c('fork', 'flaky'), c('fork', 'fail'), c('fork', 'missing')].join(' | ') + ' |')
}

const candidates = rows.filter(x => x.candidate)
lines.push('', 'Tests passing on upstream src but not on fork src: ' + candidates.length, '')
for (const r of rows.filter(x => x.script))
  lines.push('- ' + r.suite + ': upstream ' + JSON.stringify(r.upstream && { ...r.upstream.process, seeds: r.upstream.seeds }) + ', fork ' + JSON.stringify(r.fork && { ...r.fork.process, seeds: r.fork.seeds }))

fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(rows, null, 2))
fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n')
console.log(lines.join('\n'))

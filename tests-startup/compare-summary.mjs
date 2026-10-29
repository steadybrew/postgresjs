/* eslint no-console: 0, no-process-env: 0 */
import fs from 'node:fs'
import path from 'node:path'

const [dir, target] = process.argv.slice(2)
const results = []

for (const file of fs.readdirSync(dir).sort()) {
  const suite = path.basename(file).replace(/\.(jsonl|log)$/, '')
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (!line.startsWith('{'))
      continue
    let x
    try {
      x = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof x.name !== 'string' || typeof x.passed !== 'boolean')
      continue
    results.push({
      suite,
      name: x.line ? x.name + ' @' + x.line : x.name,
      passed: x.passed,
      error: (x.error || (x.passed ? '' : x.output || (x.timedOut ? 'timed out' : ''))).replace(/\s+/g, ' ').slice(0, 300)
    })
  }
}

for (const x of results)
  console.log(['RESULT', target, x.suite, x.passed ? 'pass' : 'fail', x.name, x.error].join('\t'))

const suites = [...new Set(results.map(x => x.suite))]
const summary = [
  `## ${ target }`,
  '',
  '| Suite | Passed | Failed |',
  '| --- | --- | --- |',
  ...suites.map(s => {
    const xs = results.filter(x => x.suite === s)
    return `| ${ s } | ${ xs.filter(x => x.passed).length } | ${ xs.filter(x => !x.passed).length } |`
  }),
  ''
].join('\n')

process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
console.log(summary)

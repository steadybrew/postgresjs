import { readFileSync } from 'fs'

const [file, ...names] = process.argv.slice(2)
const rows = readFileSync(file, 'utf8').split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x))
  .filter(x => !names.length || names.includes(x.name))
for (const row of rows)
  console.log((row.passed ? 'PASSED ON UPSTREAM ' : 'fails on upstream ') + row.name + '\n' + row.output + '\n')
const missing = names.filter(x => !rows.some(row => row.name === x))
missing.length && console.log('NOT RUN ' + missing.join(' '))
process.exitCode = rows.some(x => x.passed) || missing.length || !rows.length ? 1 : 0

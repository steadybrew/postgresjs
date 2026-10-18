#!/usr/bin/env node
import { resolve } from 'node:path'
import { scanProject } from './detect.mjs'
import { changes, levels } from './changes.mjs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const root = resolve(argv.find(a => !a.startsWith('--')) || '.')
const { facts, findings } = scanProject(root)

if (asJson) {
  console.log(JSON.stringify({ root, facts, findings }, null, 2))
  process.exit(0)
}

const shown = findings.filter(f => changes[f.id])
const headings = { act: 'Change before switching', review: 'Review', info: 'Worth knowing' }

console.log(`Postgres.js usage in ${root}`)
console.log(`  postgres: ${facts.postgres.map(p => p.range + ' (' + p.file + ')').join(', ') || 'not a dependency'}`)
facts.orm.length && console.log(`  used through: ${facts.orm.join(', ')}`)
facts.tracers.length && console.log(`  tracing: ${facts.tracers.join(', ')}`)

for (const level of levels) {
  const ids = Object.keys(changes).filter(id => changes[id].level === level && shown.some(f => f.id === id))
  if (!ids.length)
    continue
  console.log(`\n${headings[level]}`)
  for (const id of ids) {
    const change = changes[id]
    console.log(`\n  ${change.title}${change.since ? ' (' + change.since + ')' : ''}`)
    console.log(`  ${change.advice}`)
    for (const f of shown.filter(f => f.id === id))
      console.log(`    ${f.file}:${f.line}  ${f.text}`)
  }
}

shown.length || console.log('\nNothing found that the switch changes.')

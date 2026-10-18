#!/usr/bin/env node
import { resolve } from 'node:path'
import { scanProject } from './detect.mjs'
import { changes, levels } from './changes.mjs'
import { apply, installCommand, plan } from './switch.mjs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const doSwitch = argv.includes('--switch')
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

if (!doSwitch) {
  console.log('\nRun again with --switch to make the switch.')
  process.exit(0)
}

const steps = plan(root, { facts, findings })
if (steps.blockers.length) {
  console.log('\nNot switching, nothing was changed:')
  steps.blockers.forEach(b => console.log('  ' + b))
  process.exit(1)
}
if (!steps.steps.length) {
  console.log('\nNothing to switch: no package declares postgres outside the fork.')
  process.exit(0)
}

console.log('\nSwitched:')
apply(root, steps).forEach(line => console.log('  ' + line))
console.log('\nNext:')
console.log('  ' + installCommand(steps.pm) + ', and commit the updated lockfile with these changes')
const handled = new Set(['patched-postgres', 'postgres-via-dependency', 'postgres-via-transitive'])
const open = findings.filter(f => changes[f.id] && changes[f.id].level === 'act' && !handled.has(f.id))
open.length && console.log('  then change what is listed under "Change before switching" above (' + open.length + ' left)')
facts.tracers.some(t => t.startsWith('@sentry/')) && console.log('  Sentry records no database spans on 4.x until you add the preload: https://github.com/steadybrew/postgresjs#switching-from-postgresjs')

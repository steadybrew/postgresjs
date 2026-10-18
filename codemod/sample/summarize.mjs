import { readFileSync } from 'node:fs'
import { changes, levels } from '../src/changes.mjs'

const results = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'))
const group = process.argv[2]
const scanned = Object.entries(results).filter(([, r]) => !r.error && !r.facts.fork && (!group || r.group === group))
const n = scanned.length
const pct = k => `${k} (${Math.round(100 * k / n)}%)`
const link = (repo, r, f) => `[${repo}/${f.file}:${f.line}](https://github.com/${repo}/blob/${r.commit}/${f.file}#L${f.line})`

console.log(`${group || 'All'}: scanned ${n} repositories (${Object.values(results).filter(r => r.error).length} failed to clone, ${Object.values(results).filter(r => !r.error && r.facts.fork).length} already on the fork).\n`)

const count = pred => scanned.filter(([, r]) => pred(r)).length
console.log('| Fact | Repositories |\n| --- | --- |')
console.log(`| Import postgres directly | ${pct(count(r => r.facts.importers > 0))} |`)
console.log(`| Use drizzle-orm | ${pct(count(r => r.facts.orm.includes('drizzle-orm')))} |`)
console.log(`| Use kysely-postgres-js | ${pct(count(r => r.facts.orm.includes('kysely-postgres-js')))} |`)
console.log(`| Use sql.reserve() | ${pct(count(r => r.facts.reserves > 0))} |`)
console.log(`| Use sql.begin() | ${pct(count(r => r.facts.begins > 0))} |`)
console.log(`| Use COPY streams | ${pct(count(r => r.facts.copies > 0))} |`)
console.log(`| Use sql.listen() | ${pct(count(r => r.facts.listens > 0))} |`)
console.log(`| Use sql.subscribe() | ${pct(count(r => r.facts.subscribes > 0))} |`)
console.log(`| TypeScript | ${pct(count(r => r.facts.typescript))} |`)
for (const t of ['dd-trace', '@sentry/', 'newrelic', '@opentelemetry/'])
  console.log(`| Tracer ${t} | ${pct(count(r => r.facts.tracers.some(x => x.startsWith(t))))} |`)
for (const rt of ['cloudflare', 'vercel', 'next', 'bun', 'deno', 'aws'])
  console.log(`| Runtime hint ${rt} | ${pct(count(r => r.facts.runtimes.includes(rt)))} |`)
for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'])
  console.log(`| Lockfile ${lock} | ${pct(count(r => r.facts.lockfiles.some(l => l.startsWith(lock))))} |`)
console.log(`| Declares a Node version | ${pct(count(r => r.findings.some(f => f.id === 'node-version' || f.id === 'node-below-22')))} |`)

for (const level of levels) {
  console.log(`\n### ${level}\n`)
  console.log('| Change | Repositories | Examples |\n| --- | --- | --- |')
  for (const [id, change] of Object.entries(changes).filter(([, c]) => c.level === level)) {
    const hit = scanned.filter(([, r]) => r.findings.some(f => f.id === id))
    const examples = hit.slice(0, 3).map(([repo, r]) => link(repo, r, r.findings.find(f => f.id === id))).join(', ')
    console.log(`| ${change.title} | ${pct(hit.length)} | ${examples} |`)
  }
}

const versions = {}
for (const [, r] of scanned)
  for (const p of r.facts.postgres)
    versions[p.range] = (versions[p.range] || 0) + 1
console.log('\nDeclared postgres ranges: ' + Object.entries(versions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, k]) => `${v} ${k}`).join(', '))

const envs = scanned.flatMap(([repo, r]) => r.findings.filter(f => f.id === 'env-false-flips').map(f => `${f.text} ${link(repo, r, f)}`))
envs.length && console.log('\nEnvironment values that flip:\n' + envs.map(x => '- ' + x).join('\n'))

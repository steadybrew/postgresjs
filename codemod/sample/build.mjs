import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const out = new URL('./candidates.json', import.meta.url)
const since = process.argv[2] || '2026-04-17'
const gh = (...a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26 }))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const hits = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).hits : {}
const queries = [
  '"postgres" "dependencies" filename:package.json',
  '"postgres" "drizzle-orm" filename:package.json',
  '"postgres" "kysely" filename:package.json',
  '"postgres" "next" filename:package.json',
  '"postgres" "wrangler" filename:package.json',
  '"postgres" "hono" filename:package.json',
  '"postgres" "fastify" filename:package.json',
  '"postgres" "express" filename:package.json',
  '"postgres" "sveltekit" filename:package.json',
  '"postgres" "typescript" filename:package.json'
]

for (const q of queries) {
  for (let page = 1; page <= 10; page++) {
    let res
    try {
      res = gh('api', '-X', 'GET', 'search/code', '-f', 'q=' + q, '-f', 'per_page=100', '-f', 'page=' + page)
    } catch (e) {
      console.error('search failed', q, page, String(e.stderr || e).slice(0, 200))
      await sleep(65000)
      continue
    }
    for (const item of res.items)
      hits[item.repository.full_name] ||= { path: item.path, sha: item.sha }
    console.error(q, page, res.items.length, Object.keys(hits).length)
    if (res.items.length < 100)
      break
    await sleep(7000)
  }
  writeFileSync(out, JSON.stringify({ hits }, null, 1))
}

const repos = Object.keys(hits)
const meta = {}
for (let i = 0; i < repos.length; i += 40) {
  const batch = repos.slice(i, i + 40)
  const query = 'query {' + batch.map((r, j) => {
    const [owner, name] = r.split('/')
    return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner isFork isArchived stargazerCount pushedAt diskUsage defaultBranchRef { name target { oid } } }`
  }).join(' ') + '}'
  let res
  try {
    res = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', 'query=' + query], { encoding: 'utf8', maxBuffer: 1 << 26 }))
  } catch (e) {
    res = JSON.parse(e.stdout || '{"data":{}}')
  }
  for (const repo of Object.values(res.data || {}))
    repo && (meta[repo.nameWithOwner] = repo)
}

const eligible = []
for (const [name, hit] of Object.entries(hits)) {
  const m = meta[name]
  if (!m || m.isFork || m.isArchived || m.pushedAt < since || m.diskUsage > 200000 || !m.defaultBranchRef)
    continue
  let pkg
  try {
    pkg = JSON.parse(Buffer.from(gh('api', `repos/${name}/git/blobs/${hit.sha}`).content, 'base64').toString('utf8'))
  } catch {
    continue
  }
  const range = { ...pkg.dependencies, ...pkg.devDependencies }.postgres
  if (!range)
    continue
  eligible.push({ repo: name, stars: m.stargazerCount, pushedAt: m.pushedAt, branch: m.defaultBranchRef.name, commit: m.defaultBranchRef.target.oid, package: hit.path, postgres: range })
}

writeFileSync(out, JSON.stringify({ since, searched: queries, hits, eligible }, null, 1))
console.error('hits', repos.length, 'eligible', eligible.length)

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const gh = (...a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26 }))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const input = JSON.parse(readFileSync(new URL(process.argv[2] || './wide-candidates.json', import.meta.url), 'utf8'))
const out = new URL(process.argv[3] || './wide-classified.json', import.meta.url)
const auxiliary = /(^|\/)(examples?|templates?|starters?|demos?|samples?|playground|bench(marks?)?|fixtures?|tests?|__tests__|e2e|integration-tests?|docs?)(\/|$)/i

const results = []
for (const { repo, stars } of input) {
  let meta
  try {
    meta = gh('api', `repos/${repo}`)
  } catch {
    results.push({ repo, stars, error: 'not found' })
    continue
  }
  let items = []
  try {
    items = gh('api', '-X', 'GET', 'search/code', '-f', `q=repo:${repo} filename:package.json "postgres"`, '-f', 'per_page=100').items
  } catch (e) {
    await sleep(65000)
    try {
      items = gh('api', '-X', 'GET', 'search/code', '-f', `q=repo:${repo} filename:package.json "postgres"`, '-f', 'per_page=100').items
    } catch {}
  }
  const declared = []
  for (const item of items.filter(i => i.name === 'package.json').slice(0, 40)) {
    try {
      const pkg = JSON.parse(Buffer.from(gh('api', `repos/${repo}/git/blobs/${item.sha}`).content, 'base64').toString('utf8'))
      const kinds = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].filter(k => pkg[k] && pkg[k].postgres)
      kinds.length && declared.push({ path: item.path, name: pkg.name, private: !!pkg.private, kinds, range: pkg[kinds[0]].postgres, auxiliary: auxiliary.test(item.path) })
    } catch {}
  }
  const core = declared.filter(d => !d.auxiliary)
  results.push({
    repo, stars, archived: meta.archived, fork: meta.fork, pushedAt: meta.pushed_at, branch: meta.default_branch, sizeKb: meta.size,
    declared,
    use: !declared.length ? 'none' : !core.length ? 'auxiliary' : core.some(d => d.kinds.includes('dependencies')) ? 'runtime' : core.some(d => d.kinds.includes('peerDependencies') || d.kinds.includes('optionalDependencies')) ? 'peer' : 'dev'
  })
  writeFileSync(out, JSON.stringify(results, null, 1))
  console.error(repo, results.at(-1).use, declared.length)
  await sleep(6500)
}

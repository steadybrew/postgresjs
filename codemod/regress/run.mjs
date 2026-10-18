import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanProject } from '../src/detect.mjs'

const args = process.argv.slice(2)
const update = args.includes('--update')
const cacheIndex = args.indexOf('--cache')
const cache = cacheIndex >= 0 ? args[cacheIndex + 1] : null
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--cache')
const budget = Number(process.env.SCAN_BUDGET_SECONDS || 30)
const targets = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8'))
const expectedFile = new URL('./expected.json', import.meta.url)
const expected = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, 'utf8')) : {}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd, stdio: 'pipe', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' } })

let failed = 0
for (const { repo, commit } of targets.filter(t => !only.length || only.includes(t.repo))) {
  const cached = cache && join(cache, repo.replace('/', '__'))
  const useCache = cached && existsSync(cached) && execFileSync('git', ['-C', cached, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === commit
  const scratch = useCache ? null : mkdtempSync(join(tmpdir(), 'postgresjs-migrate-'))
  try {
    let dir = cached
    if (!useCache) {
      dir = join(scratch, 'repo')
      git(scratch, 'init', '-q', 'repo')
      git(dir, 'fetch', '-q', '--depth', '1', 'https://github.com/' + repo + '.git', commit)
      git(dir, 'checkout', '-q', 'FETCH_HEAD')
    }
    const started = Date.now()
    const rows = scanProject(dir).findings.map(f => f.id + ' ' + f.file + ':' + f.line).sort()
    const seconds = (Date.now() - started) / 1000
    if (update) {
      expected[repo] = rows
      console.log(repo, rows.length, 'findings', seconds.toFixed(1) + 's')
      continue
    }
    const want = new Set(expected[repo] || [])
    const got = new Set(rows)
    const missing = [...want].filter(r => !got.has(r))
    const extra = [...got].filter(r => !want.has(r))
    const slow = seconds > budget
    const ok = !missing.length && !extra.length && !slow
    ok || failed++
    console.log((ok ? 'ok  ' : 'FAIL') + ' ' + repo + ' ' + rows.length + ' findings ' + seconds.toFixed(1) + 's')
    missing.forEach(r => console.log('  missing ' + r))
    extra.forEach(r => console.log('  new     ' + r))
    slow && console.log('  slower than ' + budget + 's')
  } catch (e) {
    failed++
    console.log('FAIL ' + repo + ' ' + (e.stderr ? e.stderr.toString().trim() : e.message))
  } finally {
    scratch && rmSync(scratch, { recursive: true, force: true })
  }
}

if (update)
  writeFileSync(expectedFile, JSON.stringify(expected, null, 1) + '\n')
process.exit(failed ? 1 : 0)

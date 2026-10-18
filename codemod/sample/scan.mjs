import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { scanProject } from '../src/detect.mjs'

const [rest = '157', scratch = tmpdir()] = process.argv.slice(2)
const { eligible } = JSON.parse(readFileSync(new URL('./candidates.json', import.meta.url), 'utf8'))
const resultsFile = new URL('./results.json', import.meta.url)
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : {}

const order = r => createHash('sha256').update(r.repo).digest('hex')
const established = eligible.filter(r => r.stars >= 10)
const others = eligible.filter(r => r.stars < 10).sort((a, b) => order(a) < order(b) ? -1 : 1).slice(0, +rest)
const chosen = [...established, ...others]
const work = mkdtempSync(join(scratch, 'sample-'))

for (const [i, entry] of chosen.entries()) {
  if (results[entry.repo] && results[entry.repo].commit === entry.commit)
    continue
  const dir = join(work, String(i))
  try {
    execFileSync('git', [
      '-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null',
      'clone', '--quiet', '--depth', '1', '--no-tags', '--single-branch', '--branch', entry.branch,
      'https://github.com/' + entry.repo + '.git', dir
    ], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore', timeout: 120000 })
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const { facts, findings } = scanProject(dir)
    results[entry.repo] = { commit: head, stars: entry.stars, group: entry.stars >= 10 ? 'established' : 'other', facts, findings }
  } catch (e) {
    results[entry.repo] = { commit: entry.commit, error: String(e.message || e).slice(0, 200) }
  }
  rmSync(dir, { recursive: true, force: true })
  writeFileSync(resultsFile, JSON.stringify(results, null, 1))
  console.error(i + 1, '/', chosen.length, entry.repo, results[entry.repo].error ? 'error' : results[entry.repo].findings.length)
}

rmSync(work, { recursive: true, force: true })

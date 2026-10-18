import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pm = process.argv[2]
const cli = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'postgresjs-migrate-install-'))
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, CI: 'true' } })

function owner(from) {
  let file = createRequire(join(from, 'noop.js')).resolve('postgres')
  while (!existsSync(join(dirname(file), 'package.json')) || !JSON.parse(readFileSync(join(dirname(file), 'package.json'), 'utf8')).name)
    file = dirname(file)
  const pkg = JSON.parse(readFileSync(join(dirname(file), 'package.json'), 'utf8'))
  return pkg.name + '@' + pkg.version
}

function resolved() {
  return {
    app: owner(dir),
    'sql-tools': owner(realpathSync(join(dir, 'node_modules/@immich/sql-tools')))
  }
}

try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'install-check',
    private: true,
    dependencies: { postgres: '3.4.9', '@immich/sql-tools': '0.6.5' }
  }, null, 2) + '\n')
  run(pm, ['install'])
  const before = resolved()
  console.log('before', before)
  if (!before.app.startsWith('postgres@3') || !before['sql-tools'].startsWith('postgres@3'))
    throw new Error('expected postgres 3.x before the switch')

  console.log(run(process.execPath, [cli, dir, '--switch']).split('Switched:')[1])
  run(pm, pm === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'])
  const after = resolved()
  console.log('after', after)
  for (const [where, name] of Object.entries(after))
    if (!name.startsWith('@steadybrew/postgresjs@4'))
      throw new Error(where + ' still resolves ' + name)
  run(process.execPath, ['--input-type=module', '-e', "import postgres from 'postgres'; if (typeof postgres !== 'function') process.exit(1)"])
  console.log(pm + ': both resolve to the fork')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

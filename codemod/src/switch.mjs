import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { patchCoverage } from './detect.mjs'

export const spec = 'npm:@steadybrew/postgresjs@^4'

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies']

function readJson(root, file) {
  const text = readFileSync(join(root, file), 'utf8')
  return { text, value: JSON.parse(text), indent: (text.match(/^[ \t]+(?=")/m) || ['  '])[0] }
}

function writeJson(root, file, { value, indent, text }) {
  writeFileSync(join(root, file), JSON.stringify(value, null, indent) + (text.endsWith('\n') ? '\n' : ''))
}

function packageManager(root, rootPkg, facts) {
  const declared = rootPkg && typeof rootPkg.packageManager === 'string' && rootPkg.packageManager.split('@')[0]
  if (declared)
    return declared
  const lock = facts.lockfiles[0] || ''
  return lock.startsWith('pnpm') ? 'pnpm' : lock.startsWith('yarn') ? 'yarn' : lock.startsWith('bun') ? 'bun' : 'npm'
}

function setYamlEntry(text, section, key, value) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l === section + ':' || l.startsWith(section + ': '))
  if (start < 0)
    return text.replace(/\n*$/, '\n') + '\n' + section + ':\n  ' + key + ': ' + value + '\n'
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end])))
    end++
  const existing = lines.slice(start + 1, end).findIndex(l => new RegExp('^\\s+[\'"]?' + key + '[\'"]?:').test(l))
  existing >= 0
    ? (lines[start + 1 + existing] = lines[start + 1 + existing].replace(/:.*$/, ': ' + value))
    : lines.splice(start + 1, 0, '  ' + key + ': ' + value)
  return lines.join('\n')
}

function setCatalogEntries(text) {
  let inCatalog = false
  let changed = 0
  const lines = text.split('\n').map(line => {
    if (/^\S/.test(line))
      inCatalog = /^catalogs?:/.test(line)
    if (inCatalog && /^\s+['"]?postgres['"]?:/.test(line)) {
      changed++
      return line.replace(/:.*$/, ': \'' + spec + '\'')
    }
    return line
  })
  return { text: lines.join('\n'), changed }
}

export function plan(root, { facts, findings }) {
  const steps = []
  const blockers = []
  const rootPkg = existsSync(join(root, 'package.json')) ? readJson(root, 'package.json').value : null
  const pm = packageManager(root, rootPkg, facts)
  let catalog = false

  for (const { file } of facts.postgres) {
    const pkg = readJson(root, file).value
    for (const field of dependencyFields) {
      const current = pkg[field] && pkg[field].postgres
      if (!current || current.startsWith('npm:@steadybrew/postgresjs'))
        continue
      current.startsWith('catalog:')
        ? (catalog = true)
        : steps.push({ kind: 'alias', file, field, from: current })
    }
  }

  catalog && steps.push({ kind: 'catalog', file: 'pnpm-workspace.yaml' })

  const bundled = findings.filter(f => f.id === 'postgres-via-dependency' || f.id === 'postgres-via-transitive')
  if (bundled.length) {
    const target = pm === 'pnpm' && existsSync(join(root, 'pnpm-workspace.yaml')) ? 'pnpm-workspace.yaml' : 'package.json'
    steps.push({ kind: 'override', pm, file: target, because: bundled.map(f => f.text.split(' depends on')[0]) })
  }

  for (const f of findings.filter(f => f.id === 'patched-postgres' && /\.patch$/.test(f.file))) {
    const { hunks, covered } = patchCoverage(readFileSync(join(root, f.file), 'utf8'))
    hunks && covered === hunks
      ? steps.push({ kind: 'drop-patch', file: f.file })
      : blockers.push(f.file + ': ' + covered + ' of ' + hunks + ' changes are known fork fixes; port or drop the rest by hand, then run again')
  }

  return { pm, steps, blockers }
}

export function apply(root, { pm, steps }) {
  const done = []
  for (const step of steps) {
    if (step.kind === 'alias') {
      const pkg = readJson(root, step.file)
      pkg.value[step.field].postgres = spec
      writeJson(root, step.file, pkg)
      done.push(step.file + ': ' + step.field + '.postgres ' + step.from + ' → ' + spec)
    }
    if (step.kind === 'catalog') {
      const { text, changed } = setCatalogEntries(readFileSync(join(root, step.file), 'utf8'))
      writeFileSync(join(root, step.file), text)
      done.push(step.file + ': ' + changed + ' catalog entr' + (changed === 1 ? 'y' : 'ies') + ' for postgres → ' + spec)
    }
    if (step.kind === 'override') {
      if (step.file === 'pnpm-workspace.yaml') {
        writeFileSync(join(root, step.file), setYamlEntry(readFileSync(join(root, step.file), 'utf8'), 'overrides', 'postgres', '\'' + spec + '\''))
        done.push(step.file + ': overrides.postgres → ' + spec + ' (for ' + step.because.join(', ') + ')')
      } else {
        const pkg = readJson(root, 'package.json')
        const field = pm === 'yarn' ? 'resolutions' : 'overrides'
        const holder = pm === 'pnpm' ? (pkg.value.pnpm ||= {}) : pkg.value
        holder[field] = { ...holder[field], postgres: spec }
        writeJson(root, 'package.json', pkg)
        done.push('package.json: ' + (pm === 'pnpm' ? 'pnpm.' : '') + field + '.postgres → ' + spec + ' (for ' + step.because.join(', ') + ')')
      }
    }
    if (step.kind === 'drop-patch') {
      const name = step.file.split('/').pop().replace(/\.patch$/, '')
      for (const file of ['package.json', 'pnpm-workspace.yaml'].filter(f => existsSync(join(root, f)))) {
        if (file === 'package.json') {
          const pkg = readJson(root, file)
          const removed = removePatchEntries(pkg.value, 'pnpm') + removePatchEntries(pkg.value)
          removed && (writeJson(root, file, pkg), done.push(file + ': removed the patchedDependencies entry for ' + name))
        } else {
          const text = readFileSync(join(root, file), 'utf8')
          const next = text.replace(/^\s+['"]?postgres@[^:\n]*['"]?:\s*\S+\n/gm, '')
          next !== text && (writeFileSync(join(root, file), next), done.push(file + ': removed the patchedDependencies entry for ' + name))
        }
      }
      rmSync(join(root, step.file))
      done.push(step.file + ': deleted, every change in it is in the fork')
    }
  }
  return done
}

function removePatchEntries(pkg, nested) {
  const holder = nested ? pkg[nested] : pkg
  const patches = holder && holder.patchedDependencies
  const keys = patches ? Object.keys(patches).filter(k => k.startsWith('postgres@')) : []
  keys.forEach(k => delete patches[k])
  patches && !Object.keys(patches).length && delete holder.patchedDependencies
  nested && holder && !Object.keys(holder).length && delete pkg[nested]
  return keys.length
}

export function installCommand(pm) {
  return { pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install', npm: 'npm install' }[pm] || 'npm install'
}

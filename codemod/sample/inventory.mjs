import { parse, Lang } from '@ast-grep/napi'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { walk } from '../src/detect.mjs'

const languages = { '.js': Lang.JavaScript, '.mjs': Lang.JavaScript, '.cjs': Lang.JavaScript, '.jsx': Lang.JavaScript, '.ts': Lang.TypeScript, '.mts': Lang.TypeScript, '.cts': Lang.TypeScript, '.tsx': Lang.Tsx }
const queryMethods = new Set(['values', 'raw', 'cursor', 'forEach', 'describe', 'simple', 'execute', 'cancel', 'readable', 'writable', 'then', 'catch', 'finally'])
const errorFields = new Set(['code', 'severity', 'severity_local', 'detail', 'hint', 'position', 'where', 'schema_name', 'table_name', 'column_name', 'constraint_name', 'routine', 'query', 'parameters', 'cause', 'errno'])
const cache = process.argv[2]
const only = process.argv[3] ? new Set(JSON.parse(readFileSync(process.argv[3], 'utf8')).map(e => e.repo.replace('/', '__'))) : null

function parseFile(root, file) {
  const lang = languages[extname(file)]
  if (!lang || /\.min\.js$|\.d\.ts$/.test(file))
    return null
  try {
    const text = readFileSync(join(root, file), 'utf8')
    return text.length > 512 * 1024 ? null : { text, root: parse(lang, text).root() }
  } catch {
    return null
  }
}

function importsPostgres(node) {
  return node.findAll({ rule: { any: [{ kind: 'import_statement' }, { kind: 'call_expression' }] } })
    .some(n => /^\s*(import[\s\S]*from\s*|require\(\s*|import\(\s*)['"]postgres['"]/.test(n.text()))
}

function resolveImport(file, source, byPath) {
  const candidates = []
  if (source.startsWith('.')) {
    const base = join(dirname(file), source).replace(/\.(m|c)?js$/, '')
    candidates.push(base)
  } else if (/^(@|~|#)\//.test(source)) {
    const rest = source.slice(2).replace(/\.(m|c)?js$/, '')
    for (const key of byPath.keys())
      key.replace(/\.[mc]?[jt]sx?$/, '').replace(/\/index$/, '').endsWith('/' + rest) && candidates.push(key.replace(/\.[mc]?[jt]sx?$/, ''))
  }
  for (const c of candidates)
    for (const ext of ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '/index.ts', '/index.js', '/index.mjs'])
      if (byPath.has(c + ext))
        return c + ext
  return null
}

function inventory(dir) {
  const files = walk(dir).map(f => ({ f, p: parseFile(dir, f) })).filter(x => x.p)
  const byPath = new Map(files.map(x => [x.f, x]))
  const factories = new Map()
  for (const { f, p } of files) {
    const local = new Set()
    for (const imp of p.root.findAll({ rule: { kind: 'import_statement' } }))
      if (/from\s*['"]postgres['"]/.test(imp.text())) {
        const def = imp.find({ rule: { kind: 'import_clause' } })
        const id = def && def.children().find(c => c.kind() === 'identifier')
        id && local.add(id.text())
        const ns = def && def.find({ rule: { kind: 'namespace_import' } })
        const nsId = ns && ns.find({ rule: { kind: 'identifier' } })
        nsId && local.add(nsId.text())
      }
    for (const d of p.root.findAll({ rule: { kind: 'variable_declarator' } })) {
      const value = d.field('value')
      const name = d.field('name')
      if (!value || !name || !/^(await\s+)?(require|import)\(\s*['"]postgres['"]\s*\)/.test(value.text()))
        continue
      if (name.kind() === 'identifier')
        local.add(name.text())
      const pair = name.kind() === 'object_pattern' && name.children().find(c => c.kind() === 'pair_pattern' && c.field('key').text() === 'default')
      pair && pair.field('value').kind() === 'identifier' && local.add(pair.field('value').text())
    }
    factories.set(f, local)
  }

  const handles = new Map(files.map(x => [x.f, new Set()]))
  const exportsOf = new Map(files.map(x => [x.f, new Set()]))
  for (const { f, p } of files) {
    const local = factories.get(f)
    if (!local.size)
      continue
    for (const call of p.root.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = call.field('function')
      if (!fn || fn.kind() !== 'identifier' || !local.has(fn.text()))
        continue
      let up = call.parent()
      while (up && ['await_expression', 'parenthesized_expression', 'as_expression', 'non_null_expression', 'ternary_expression', 'binary_expression'].includes(up.kind()))
        up = up.parent()
      if (up && up.kind() === 'variable_declarator' && up.field('name')) {
        handles.get(f).add(up.field('name').text())
        up.parent() && up.parent().parent() && up.parent().parent().kind() === 'export_statement' && exportsOf.get(f).add(up.field('name').text())
      }
      if (up && up.kind() === 'assignment_expression' && up.field('left').kind() === 'identifier')
        handles.get(f).add(up.field('left').text())
      if (up && (up.kind() === 'export_statement' || up.kind() === 'return_statement'))
        exportsOf.get(f).add('default')
    }
    for (const ex of p.root.findAll({ rule: { kind: 'export_statement' } })) {
      for (const spec of ex.findAll({ rule: { kind: 'export_specifier' } })) {
        const name = spec.field('name').text()
        handles.get(f).has(name) && exportsOf.get(f).add(spec.field('alias') ? spec.field('alias').text() : name)
      }
      const value = ex.field('value') || ex.field('declaration')
      value && value.kind() === 'identifier' && handles.get(f).has(value.text()) && exportsOf.get(f).add('default')
    }
  }

  for (let pass = 0; pass < 3; pass++)
    for (const { f, p } of files)
      for (const imp of p.root.findAll({ rule: { kind: 'import_statement' } })) {
        const source = imp.field('source')
        if (!source)
          continue
        const target = resolveImport(f, source.text().slice(1, -1), byPath)
        if (!target || !exportsOf.get(target).size)
          continue
        const exported = exportsOf.get(target)
        const clause = imp.find({ rule: { kind: 'import_clause' } })
        if (!clause)
          continue
        for (const c of clause.children()) {
          c.kind() === 'identifier' && exported.has('default') && handles.get(f).add(c.text())
          if (c.kind() === 'named_imports')
            for (const spec of c.findAll({ rule: { kind: 'import_specifier' } })) {
              const name = spec.field('name').text()
              if (exported.has(name)) {
                const localName = spec.field('alias') ? spec.field('alias').text() : name
                handles.get(f).add(localName)
                const reexport = imp.parent() && imp.parent().find({ rule: { kind: 'export_statement', has: { kind: 'export_clause', regex: '\\b' + localName + '\\b' } } })
                reexport && exportsOf.get(f).add(localName)
              }
            }
        }
      }

  const counts = {}
  const bump = (k, file) => ((counts[k] ||= new Set()).add(file))
  for (const { f, p } of files) {
    const local = factories.get(f)
    for (const call of p.root.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = call.field('function')
      if (!fn || fn.kind() !== 'identifier' || !local.has(fn.text()))
        continue
      const object = call.field('arguments') && call.field('arguments').children().find(c => c.kind() === 'object')
      if (object)
        for (const pair of object.children().filter(c => c.kind() === 'pair' || c.kind() === 'shorthand_property_identifier')) {
          const key = pair.kind() === 'pair' ? pair.field('key').text().replace(/^['"]|['"]$/g, '') : pair.text()
          bump('option:' + key, f)
          if (pair.kind() === 'pair' && ['transform', 'types', 'connection'].includes(key) && pair.field('value').kind() === 'object')
            pair.field('value').children().filter(c => c.kind() === 'pair').forEach(c => bump('option:' + key + '.' + c.field('key').text(), f))
        }
    }
    for (const id of local)
      for (const m of p.root.findAll({ rule: { kind: 'member_expression', has: { field: 'object', regex: '^' + id + '$' } } }))
        bump('static:' + m.field('property').text(), f)
    const hs = handles.get(f)
    for (const call of p.root.findAll({ rule: { kind: 'call_expression', has: { field: 'function', kind: 'member_expression', has: { field: 'property', regex: '^(begin|savepoint|reserve)$' } } } })) {
      if (!hs.has(call.field('function').field('object').text()))
        continue
      const cb = call.field('arguments').children().find(c => ['arrow_function', 'function_expression', 'function'].includes(c.kind()))
      const param = cb && (cb.field('parameter') || (cb.field('parameters') && cb.field('parameters').find({ rule: { kind: 'identifier' } })))
      param && hs.add(param.text())
      const decl = call.parent() && call.parent().kind() === 'await_expression' && call.parent().parent()
      decl && decl.kind() === 'variable_declarator' && hs.add(decl.field('name').text())
    }
    for (const h of hs) {
      for (const m of p.root.findAll({ rule: { kind: 'member_expression', has: { field: 'object', regex: '^' + h + '$' } } }))
        bump('handle:' + m.field('property').text(), f)
      for (const t of p.root.findAll({ rule: { kind: 'call_expression', has: { field: 'function', regex: '^' + h + '$' } } })) {
        const isTemplate = t.field('arguments') && t.field('arguments').kind() === 'template_string'
        bump(isTemplate ? 'tagged-query' : 'helper:sql(...)', f)
        const parent = t.parent()
        if (parent && parent.kind() === 'member_expression' && queryMethods.has(parent.field('property').text()))
          bump('query:.' + parent.field('property').text() + '()', f)
      }
      for (const arg of p.root.findAll({ rule: { kind: 'identifier', regex: '^' + h + '$', inside: { kind: 'arguments' } } })) {
        const call = arg.parent().parent()
        const fn = call && call.field('function')
        fn && /^(drizzle|PostgresJSDialect|PostgresJsDialect|new)$/.test(fn.text()) && bump('passed-to:' + fn.text(), f)
      }
    }
    if (hs.size || local.size) {
      for (const c of p.root.findAll({ rule: { kind: 'catch_clause' } })) {
        const param = c.field('parameter')
        if (!param)
          continue
        for (const m of c.findAll({ rule: { kind: 'member_expression', has: { field: 'object', regex: '^' + param.text() + '$' } } }))
          errorFields.has(m.field('property').text()) && bump('error:.' + m.field('property').text(), f)
      }
    }
    for (const m of p.root.findAll({ rule: { kind: 'binary_expression', regex: 'instanceof\\s+(postgres\\.)?PostgresError' } }))
      bump('error:instanceof PostgresError', f)
  }
  return { handles: Object.fromEntries([...handles].filter(([, v]) => v.size).map(([k, v]) => [k, [...v]])), features: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, [...v]])) }
}

const repos = readdirSync(cache).filter(d => !only || only.has(d))
const all = {}
for (const repo of repos) {
  all[repo] = inventory(join(cache, repo))
  console.error(repo, Object.keys(all[repo].features).length, 'features', [...new Set(Object.values(all[repo].handles).flat())].join(','))
}
writeFileSync(new URL('./inventory.json', import.meta.url), JSON.stringify(all, null, 1))

const totals = {}
for (const [repo, inv] of Object.entries(all))
  for (const k of Object.keys(inv.features))
    (totals[k] ||= []).push(repo)
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1].length - a[1].length))
  console.log(String(v.length).padStart(3), k)

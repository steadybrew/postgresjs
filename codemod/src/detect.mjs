import { parse, Lang } from '@ast-grep/napi'
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join, extname, basename, dirname } from 'node:path'

const skipDirs = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', '.svelte-kit', '.vercel',
  '.wrangler', '.netlify', '.turbo', '.cache', 'out', 'coverage', 'vendor', '.yarn', '.pnpm-store'
])

const languages = {
  '.js': Lang.JavaScript, '.mjs': Lang.JavaScript, '.cjs': Lang.JavaScript, '.jsx': Lang.JavaScript,
  '.ts': Lang.TypeScript, '.mts': Lang.TypeScript, '.cts': Lang.TypeScript, '.tsx': Lang.Tsx
}

const maxBytes = 512 * 1024
const ltsNames = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 }
const callbackOptions = ['onnotice', 'onparameter', 'onnotify', 'onclose', 'debug', 'backoff']
const flippedEnv = /["']?\b(PG(?:SSL|PREPARE|FETCH_TYPES|DEBUG))\b["']?\s*[=:]\s*["']?(disable|false)\b/g
const errorCodes = /^(CONNECTION_CLOSED|CONNECTION_DESTROYED|CONNECT_TIMEOUT|COPY_IN_PROGRESS|UNSAFE_TRANSACTION)$/
const knownPatches = [
  [/function nextWrite[\s\S]{0,1500}?!socket|socket \? socket\.write/, 'write after close crash (#1208, #1154), fixed in 4.0.0'],
  [/connection\.onclose = (e|error|err) =>/, 'queries after a transaction connection closes (#1154, #1133), fixed in 4.0.0'],
  [/c\.onclose = (e|error|err) =>|CONNECTION_RELEASED/, 'queries on a reserved connection after close or release, fixed in 4.0.0'],
  [/result = new Result\(\)\s*\n\+\s*rows = 0/, 'state left over after a connection closes, fixed in 4.0.0']
]
const timerCalls = new Set(['setTimeout', 'setImmediate', 'setInterval', 'queueMicrotask'])
const functionKinds = new Set(['arrow_function', 'function_expression', 'function', 'function_declaration', 'method_definition', 'generator_function', 'generator_function_declaration'])
const sentryServer = /^@sentry\/(node|nextjs|remix|sveltekit|nuxt|astro|nestjs|aws-serverless|google-cloud-serverless|bun|solidstart|tanstackstart-react|react-router)$/

export function walk(root) {
  const files = []
  const visit = dir => {
    let entries
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = dir ? dir + '/' + entry.name : entry.name
      if (entry.isSymbolicLink())
        continue
      if (entry.isDirectory())
        skipDirs.has(entry.name) || visit(rel)
      else if (entry.isFile())
        files.push(rel)
    }
  }
  visit('')
  return files
}

function read(root, file) {
  try {
    const stat = lstatSync(join(root, file))
    return stat.size > maxBytes ? null : readFileSync(join(root, file), 'utf8')
  } catch {
    return null
  }
}

function json(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++)
    text.charCodeAt(i) === 10 && line++
  return line
}

function lineText(text, line) {
  return (text.split('\n')[line - 1] || '').trim().slice(0, 200)
}

function readLarge(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return null
  }
}

function pnpmGraph(text) {
  const importers = new Map()
  const nodes = new Map()
  let section = null
  let key = null
  let group = null
  let dep = null
  let index = 0
  for (const line of text.split('\n')) {
    const at = index
    index += line.length + 1
    if (!line.trim())
      continue
    const indent = line.length - line.trimStart().length
    const body = line.trim().replace(/^'|'(?=:)/g, '')
    if (indent === 0) {
      section = body.replace(/:.*$/, '')
      continue
    }
    if (indent === 2) {
      key = body.replace(/:$/, '').replace(/^'|'$/g, '').replace(/^\//, '')
      group = dep = null
      if (section === 'importers')
        importers.set(key, { prod: [], dev: [] })
      else if (section === 'snapshots' || section === 'packages')
        nodes.has(key) ? section === 'snapshots' && (nodes.get(key).at = at) : nodes.set(key, { deps: [], postgres: null, peerPostgres: false, at })
      continue
    }
    if (indent === 4) {
      group = body.replace(/:$/, '')
      continue
    }
    const pair = body.match(/^'?((?:@[^/@\s']+\/)?[^:'\s]+)'?:\s*(.*)$/)
    if (!pair)
      continue
    if (section === 'importers' && importers.has(key)) {
      const target = group === 'devDependencies' ? 'dev' : /^(dependencies|optionalDependencies)$/.test(group) ? 'prod' : null
      if (!target)
        continue
      if (indent === 6) {
        dep = pair[1]
        pair[2] && importers.get(key)[target].push([dep, pair[2]])
      } else if (indent === 8 && pair[1] === 'version' && dep) {
        importers.get(key)[target].push([dep, pair[2].replace(/^'|'$/g, '')])
      }
    } else if (indent === 6 && nodes.has(key)) {
      const node = nodes.get(key)
      if (group === 'dependencies' || group === 'optionalDependencies') {
        node.deps.push([pair[1], pair[2].replace(/^'|'$/g, '')])
        pair[1] === 'postgres' && (node.postgres = pair[2])
      }
      group === 'peerDependencies' && pair[1] === 'postgres' && (node.peerPostgres = true)
    }
  }
  const nameOf = id => id.match(/^((?:@[^/@]+\/)?[^@]+)@/)?.[1]
  const peerNames = new Set([...nodes].filter(([, n]) => n.peerPostgres).map(([id]) => nameOf(id)))
  const resolve = (from, [name, version]) => {
    if (version.startsWith('link:')) {
      const parts = (from === '.' ? [] : from.split('/'))
      for (const seg of version.slice(5).split('/'))
        seg === '..' ? parts.pop() : seg !== '.' && seg && parts.push(seg)
      return { importer: parts.join('/') || '.' }
    }
    const id = version.startsWith('/') ? version.slice(1) : /@/.test(version.replace(/\(.*$/, '').slice(1)) ? version : name + '@' + version
    return { id }
  }
  const reached = new Set()
  const seenImporters = new Set()
  const stack = []
  for (const [path, imp] of importers)
    for (const d of imp.prod)
      stack.push([path, d])
  while (stack.length) {
    const [from, d] = stack.pop()
    const r = resolve(from, d)
    if (r.importer) {
      if (seenImporters.has(r.importer) || !importers.has(r.importer))
        continue
      seenImporters.add(r.importer)
      for (const x of importers.get(r.importer).prod)
        stack.push([r.importer, x])
      continue
    }
    if (reached.has(r.id) || !nodes.has(r.id))
      continue
    reached.add(r.id)
    for (const x of nodes.get(r.id).deps)
      stack.push([null, x])
  }
  return [...nodes]
    .filter(([id, n]) => n.postgres && !peerNames.has(nameOf(id)))
    .map(([id, n]) => ({ name: nameOf(id), range: n.postgres, at: n.at, runtime: reached.has(id) }))
}

function dependentsInLock(name, text) {
  const out = []
  const push = (dep, range, index, runtime) => {
    if (!dep || dep === 'postgres')
      return
    const seen = out.find(o => o.name === dep)
    seen ? (seen.runtime = seen.runtime || runtime) : out.push({ name: dep, range, line: lineOf(text, index), runtime })
  }
  if (name === 'package-lock.json') {
    const lock = json(text)
    for (const [path, entry] of Object.entries((lock && lock.packages) || {}))
      if (path.includes('node_modules/') && entry.dependencies && entry.dependencies.postgres)
        push(path.replace(/^.*node_modules\//, ''), entry.dependencies.postgres, text.indexOf('"' + path + '"'), !entry.dev && !entry.devOptional)
  } else if (name === 'pnpm-lock.yaml') {
    for (const d of pnpmGraph(text))
      push(d.name, d.range, d.at, d.runtime)
  } else if (name === 'yarn.lock') {
    for (const m of text.matchAll(/^"?((?:@[^/@\s]+\/)?[^@\s"]+)@[^\n]*:\n((?:  .*\n)*)/gm)) {
      const deps = m[2].match(/^  (?:dependencies|optionalDependencies):\n((?:    .*\n)*)/m)
      const pg = deps && deps[1].match(/^    "?postgres"?:? "?([^"\s]+)"?/m)
      pg && push(m[1], pg[1], m.index, null)
    }
  } else if (name === 'bun.lock') {
    for (const m of text.matchAll(/^\s*"((?:@[^/"]+\/)?[^"]+)": \[[^\n]*"dependencies": \{[^}]*"postgres": "([^"]+)"/gm))
      push(m[1], m[2], m.index, null)
  }
  return out
}

function minMajor(range) {
  if (typeof range !== 'string')
    return null
  const lts = range.match(/lts\/(\w+)/i)
  if (lts)
    return ltsNames[lts[1].toLowerCase()] || null
  const majors = range.split('||')
    .map(part => part.match(/(\d+)/))
    .filter(Boolean)
    .map(m => +m[1])
    .filter(n => n >= 4 && n <= 40)
  return majors.length ? Math.min(...majors) : null
}

function unquote(node) {
  const text = node.text()
  return text.length >= 2 ? text.slice(1, -1) : text
}

function isString(node) {
  return node && (node.kind() === 'string' || (node.kind() === 'template_string' && !node.find({ rule: { kind: 'template_substitution' } })))
}

function lineOfNode(node) {
  return node.range().start.line + 1
}

function snippet(node) {
  return node.text().split('\n')[0].trim().slice(0, 200)
}

function trivialFunction(node) {
  if (!node || !functionKinds.has(node.kind()))
    return false
  if (node.children().some(c => c.kind() === 'async'))
    return true
  const body = node.field('body')
  if (!body)
    return true
  const target = body.kind() === 'statement_block'
    ? body.children().filter(c => c.kind() !== '{' && c.kind() !== '}' && c.kind() !== 'comment')
    : [body]
  if (target.length === 0)
    return true
  if (target.length > 1)
    return false
  const only = target[0].kind() === 'expression_statement' ? target[0].children()[0] : target[0]
  if (!only)
    return true
  if (only.kind() === 'try_statement') {
    const handler = only.field('handler')
    const finalizer = only.field('finalizer')
    return !!handler && !finalizer && !handler.find({ rule: { kind: 'throw_statement' } })
  }
  const risky = only.findAll({ rule: { any: [{ kind: 'call_expression' }, { kind: 'member_expression' }, { kind: 'subscript_expression' }, { kind: 'throw_statement' }, { kind: 'new_expression' }] } })
  const self = ['call_expression', 'member_expression', 'subscript_expression', 'throw_statement', 'new_expression'].includes(only.kind()) ? [only] : []
  return [...self, ...risky].every(n => n.kind() === 'call_expression'
    ? /^console\.(log|warn|error|info|debug)$/.test(n.field('function').text())
    : n.kind() === 'member_expression' && /^console\./.test(n.text()))
}

function enclosingFunction(node) {
  let current = node.parent()
  while (current && !functionKinds.has(current.kind()))
    current = current.parent()
  return current
}

function memberCalls(root, name) {
  return root.findAll({
    rule: {
      kind: 'call_expression',
      has: { field: 'function', kind: 'member_expression', has: { field: 'property', regex: '^' + name + '$' } }
    }
  })
}

function args(call) {
  const list = call.field('arguments')
  return list ? list.children().filter(c => !['(', ')', ',', 'comment'].includes(c.kind())) : []
}

function postgresBindings(root) {
  const names = new Set()
  const named = new Set()
  for (const node of root.findAll({ rule: { kind: 'import_statement' } })) {
    const source = node.field('source')
    if (!source || unquote(source) !== 'postgres')
      continue
    const clause = node.find({ rule: { kind: 'import_clause' } })
    if (!clause)
      continue
    for (const child of clause.children()) {
      if (child.kind() === 'identifier')
        names.add(child.text())
      if (child.kind() === 'namespace_import') {
        const id = child.find({ rule: { kind: 'identifier' } })
        id && names.add(id.text())
      }
      if (child.kind() === 'named_imports')
        for (const spec of child.findAll({ rule: { kind: 'import_specifier' } })) {
          const imported = spec.field('name')
          const alias = spec.field('alias')
          imported && imported.text() === 'default'
            ? alias && names.add(alias.text())
            : imported && named.add(imported.text())
        }
    }
  }
  for (const node of root.findAll({ rule: { kind: 'variable_declarator' } })) {
    const value = node.field('value')
    const name = node.field('name')
    if (!value || !name)
      continue
    const call = value.kind() === 'await_expression' ? value.children().find(c => c.kind() === 'call_expression') : value
    if (!call || call.kind() !== 'call_expression')
      continue
    const fn = call.field('function')
    const first = args(call)[0]
    if (!fn || !['require', 'import'].includes(fn.text()) || !isString(first) || unquote(first) !== 'postgres')
      continue
    if (name.kind() === 'identifier')
      names.add(name.text())
    for (const pair of name.kind() === 'object_pattern' ? name.children().filter(c => c.kind() === 'pair_pattern') : []) {
      const key = pair.field('key')
      const local = pair.field('value')
      key && local && local.kind() === 'identifier' && (key.text() === 'default' ? names.add(local.text()) : named.add(key.text()))
    }
  }
  return { names, named }
}

function optionPairs(object) {
  return object.children()
    .filter(c => c.kind() === 'pair')
    .map(pair => ({ key: pair.field('key'), value: pair.field('value'), pair }))
    .filter(x => x.key && x.value)
    .map(x => ({ ...x, name: ['string', 'template_string'].includes(x.key.kind()) ? unquote(x.key) : x.key.text() }))
}

function scanCode(file, text, lang, project, add) {
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]((?:@[^/'"]+\/)?[^/.'"][^/'"]*)/g))
    project.imported.add(m[1])
  for (const m of text.matchAll(/([A-Za-z_$#][\w$.#]*)`\s*(?:\$\{|select\b|insert\b|update\b|delete\b|with\b|create\b|alter\b|drop\b|truncate\b|set\b|show\b|begin\b|commit\b|rollback\b|listen\b|notify\b|copy\b|values\b|lock\b|grant\b|do\b|explain\b|vacuum\b|analyze\b|refresh\b|call\b|prepare\b|execute\b|discard\b|reset\b)/gi))
    project.tags.add(m[1])

  const has = {
    postgres: /['"]postgres['"]/.test(text),
    pairs: /fetch_types|target_session_attrs/.test(text),
    reserve: /\.reserve\s*\(/.test(text),
    begin: /\.begin\s*\(/.test(text),
    copy: /\b(writable|readable)\s*\(/.test(text) && /\bcopy\b/i.test(text),
    subscribe: /\.subscribe\s*\(/.test(text),
    listen: /\.listen\s*\(/.test(text),
    race: /Promise\.race/.test(text),
    postgresError: /PostgresError/.test(text),
    codes: /CONNECTION_|CONNECT_TIMEOUT|COPY_IN_PROGRESS|UNSAFE_TRANSACTION/.test(text)
  }
  if (!Object.values(has).some(Boolean))
    return

  let root
  try {
    root = parse(lang, text).root()
  } catch {
    return
  }
  const { names, named } = has.postgres ? postgresBindings(root) : { names: new Set(), named: new Set() }
  names.size && project.importers.push(file)
  named.has('PostgresError') && project.namedErrorImport.push(file)
  for (const name of names)
    project.tags.add(name)

  for (const call of names.size ? root.findAll({ rule: { kind: 'call_expression' } }) : []) {
    const fn = call.field('function')
    if (!fn || fn.kind() !== 'identifier' || !names.has(fn.text()))
      continue
    project.clients++
    for (const object of args(call).filter(a => a.kind() === 'object')) {
      for (const { name, value, pair } of optionPairs(object)) {
        if (name === 'max' && value.text() === '1')
          project.maxOne.push({ file, line: lineOfNode(pair) })
        if (name === 'prepare' && value.text() === 'false')
          add('prepare-false', file, lineOfNode(pair), snippet(pair))
        if (name === 'onnotice' && value.text() === 'false')
          add('onnotice-false', file, lineOfNode(pair), snippet(pair))
        if (name === 'transform')
          project.transform = true
        if (callbackOptions.includes(name) && functionKinds.has(value.kind()) && !trivialFunction(value))
          add('callback-can-throw', file, lineOfNode(pair), name)
      }
    }
  }

  for (const pair of has.pairs ? root.findAll({ rule: { kind: 'pair' } }) : []) {
    const key = pair.field('key')
    const value = pair.field('value')
    if (!key || !value)
      continue
    const name = ['string'].includes(key.kind()) ? unquote(key) : key.text()
    if (name === 'fetch_types' && value.text() === 'false')
      add('fetch-types-false', file, lineOfNode(pair), snippet(pair))
    if (name === 'target_session_attrs')
      add('target-session-attrs', file, lineOfNode(pair), snippet(pair))
  }

  for (const call of has.reserve ? memberCalls(root, 'reserve') : []) {
    if (args(call).length)
      continue
    project.reserves++
    const declarator = call.parent() && call.parent().kind() === 'await_expression' ? call.parent().parent() : call.parent()
    if (!declarator || declarator.kind() !== 'variable_declarator')
      continue
    const handle = declarator.field('name')
    const owner = enclosingFunction(call)
    const scope = owner || root
    if (!handle || handle.kind() !== 'identifier')
      continue
    const releases = memberCalls(scope, 'release')
      .filter(r => r.field('function').field('object').text() === handle.text())
      .filter(r => enclosingFunction(r) === owner || (enclosingFunction(r) && owner && enclosingFunction(r).range().start.index === owner.range().start.index))
    if (!releases.length)
      continue
    const firstRelease = Math.min(...releases.map(r => r.range().end.index))
    const later = scope.findAll({ rule: { kind: 'identifier', regex: '^' + handle.text() + '$' } })
      .filter(id => id.range().start.index > firstRelease)
      .filter(id => !(id.parent() && id.parent().kind() === 'member_expression' && id.parent().field('property') && id.parent().field('property').text() === 'release'))
    later.length && add('reserved-used-after-release', file, lineOfNode(later[0]), snippet(later[0].parent() || later[0]))
  }

  for (const call of has.begin ? memberCalls(root, 'begin') : []) {
    const callback = args(call).find(a => functionKinds.has(a.kind()))
    if (!callback)
      continue
    const params = callback.field('parameters') || callback.field('parameter')
    const first = params && (params.kind() === 'identifier' ? params : params.find({ rule: { kind: 'identifier' } }))
    if (!first)
      continue
    project.begins++
    const tx = first.text()
    const body = callback.field('body')
    if (!body)
      continue
    for (const prepare of memberCalls(body, 'prepare')) {
      const object = prepare.field('function').field('object')
      if (object.text() !== tx)
        continue
      const name = args(prepare)[0]
      if (!isString(name) || unquote(name) === '')
        add('transaction-prepare-name', file, lineOfNode(prepare), snippet(prepare))
    }
    for (const timer of body.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = timer.field('function')
      if (!fn || !timerCalls.has(fn.text().replace(/^(globalThis|window|process)\./, '')) && fn.text() !== 'process.nextTick')
        continue
      const inner = args(timer).find(a => functionKinds.has(a.kind()))
      if (inner && inner.find({ rule: { kind: 'identifier', regex: '^' + tx + '$' } }))
        add('transaction-handle-escapes', file, lineOfNode(timer), snippet(timer))
    }
    for (const assign of body.findAll({ rule: { kind: 'assignment_expression' } })) {
      const right = assign.field('right')
      right && right.kind() === 'identifier' && right.text() === tx && add('transaction-handle-escapes', file, lineOfNode(assign), snippet(assign))
    }
  }

  for (const kind of has.copy ? ['writable', 'readable'] : []) {
    for (const call of memberCalls(root, kind)) {
      const object = call.field('function').field('object')
      const inner = object && object.kind() === 'await_expression' ? object.children().find(c => c.kind() === 'call_expression') : object
      const template = inner && inner.kind() === 'call_expression' && inner.field('arguments')
      if (template && template.kind() === 'template_string' && /\bcopy\b/i.test(template.text()))
        project.copies.push({ file, line: lineOfNode(call) })
    }
  }

  for (const call of has.subscribe ? memberCalls(root, 'subscribe') : []) {
    const list = args(call)
    if (!isString(list[0]) || !/^(\*|insert|update|delete)(:|$)/i.test(unquote(list[0])))
      continue
    project.subscribes++
    list.length < 4 && add('subscribe-without-onerror', file, lineOfNode(call), snippet(call))
    list[1] && functionKinds.has(list[1].kind()) && !trivialFunction(list[1]) && add('callback-can-throw', file, lineOfNode(call), 'subscribe')
  }

  for (const call of has.listen ? memberCalls(root, 'listen') : []) {
    const list = args(call)
    if (!list[0] || !list[1] || !functionKinds.has(list[1].kind()))
      continue
    const object = call.field('function').field('object')
    if (!object || object.kind() === 'this')
      continue
    project.listenCandidates.push({ file, line: lineOfNode(call), object: object.text(), trivial: trivialFunction(list[1]) })
  }

  for (const race of !has.race ? [] : root.findAll({ rule: { kind: 'call_expression', has: { field: 'function', regex: '^Promise\\.race$' } } })) {
    const list = args(race)[0]
    if (list && /setTimeout|timeout|delay|sleep/i.test(list.text()) && (names.size || /\b(sql|tx|db)`/.test(text)))
      add('promise-race-timeout', file, lineOfNode(race), snippet(race))
  }

  for (const node of !has.postgresError ? [] : root.findAll({ rule: { kind: 'new_expression', has: { field: 'constructor', regex: '(^|\\.)PostgresError$' } } }))
    add('new-postgres-error', file, lineOfNode(node), snippet(node))

  for (const node of !has.codes ? [] : root.findAll({ rule: { kind: 'string', regex: 'CONNECTION_|CONNECT_TIMEOUT|COPY_IN_PROGRESS|UNSAFE_TRANSACTION' } })) {
    const value = unquote(node)
    errorCodes.test(value) && add('error-code-check', file, lineOfNode(node), value)
    value === 'CONNECTION_ENDED' && add('connection-ended-check', file, lineOfNode(node), value)
  }
}

function scanText(file, text, add) {
  for (const m of text.matchAll(flippedEnv)) {
    const line = lineOf(text, m.index)
    add('env-false-flips', file, line, m[1] + '=' + m[2])
  }
  for (const m of text.matchAll(/[?&]fetch_types=false\b/g))
    add('fetch-types-false', file, lineOf(text, m.index), lineText(text, lineOf(text, m.index)))
  for (const m of text.matchAll(/[?&]target_session_attrs=[\w-]+|\bPGTARGETSESSIONATTRS\s*[=:]\s*["']?[\w-]+/g))
    add('target-session-attrs', file, lineOf(text, m.index), m[0].replace(/^[?&]/, ''))
}

function nodeVersions(file, text, add) {
  const name = basename(file)
  const report = (major, line, what) => major && add(major < 22 ? 'node-below-22' : 'node-version', file, line, what + ' → ' + major, text)
  if (name === '.nvmrc' || name === '.node-version')
    report(minMajor(text.trim()), 1, text.trim())
  if (name === '.tool-versions')
    for (const m of text.matchAll(/^nodejs\s+(\S+)/gm))
      report(minMajor(m[1]), lineOf(text, m.index), m[0])
  if (/^Dockerfile/i.test(name) || /\.dockerfile$/i.test(name))
    for (const m of text.matchAll(/^FROM\s+(?:--\S+\s+)*(?:\S+\/)?node:(\d+)/gim))
      report(+m[1], lineOf(text, m.index), m[0].trim())
  if (/^\.github\/workflows\//.test(file))
    for (const m of text.matchAll(/^\s*(?:node-version|node_version|node)\s*:\s*(.+)$/gm)) {
      const majors = [...m[1].matchAll(/(?<![\w.])(\d{1,2})(?:\.[\dx]+)*(?![\w])/g)].map(x => +x[1]).filter(n => n >= 4 && n <= 40)
      const major = majors.length && Math.min(...majors)
      major && add(major < 22 ? 'node-below-22-ci' : 'node-version', file, lineOf(text, m.index), m[0].trim() + ' → ' + major, text)
    }
  if (/(^|\/)(vercel\.json|serverless\.ya?ml|template\.ya?ml|netlify\.toml|app\.ya?ml)$/.test(file) || /\.(ts|js|mjs)$/.test(file) && /cdk|infra|stack/i.test(file))
    for (const m of text.matchAll(/nodejs(\d+)\.x|NODEJS_(\d+)_X|\bnodejs(\d+)\b/g))
      report(+(m[1] || m[2] || m[3]), lineOf(text, m.index), m[0])
}

export function scanProject(root) {
  const files = walk(root)
  const findings = []
  const seen = new Set()
  const versions = []
  const record = (id, file, line, text) => {
    const key = id + '\0' + file + '\0' + line
    seen.has(key) || (seen.add(key), findings.push({ id, file, line, text }))
  }
  const add = (id, file, line, text, source) => /^node-(below-22|below-22-ci|version)$/.test(id)
    ? versions.push({ id, file, line, text, source })
    : record(id, file, line, text)
  const project = {
    packages: [], postgres: [], fork: [], deps: new Set(), engines: [], patched: [],
    importers: [], namedErrorImport: [], clients: 0, maxOne: [], transform: false,
    reserves: 0, begins: 0, copies: [], subscribes: 0, listens: 0, listenCandidates: [], tags: new Set(),
    typesNode: [], skipLibCheck: false, tsconfig: false, lockfiles: [], postgresNames: [], viaDependency: [], imported: new Set()
  }

  for (const file of files) {
    const name = basename(file)
    if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/.test(name) && !file.includes('/')) {
      project.lockfiles.push(name)
      const lock = name === 'bun.lockb' ? null : readLarge(root, file)
      lock && project.viaDependency.push(...dependentsInLock(name, lock).map(dep => ({ file, ...dep })))
    }
    if (/(^|\/)patches\/postgres[+@]/.test(file)) {
      const patch = read(root, file) || ''
      const covered = knownPatches.filter(([re]) => re.test(patch)).map(([, note]) => note)
      add('patched-postgres', file, 1, covered.length ? name + ': ' + covered.join('; ') : name + ': not a known fix')
    }

    const lang = languages[extname(file)]
    const textual = lang || /^(\.env.*|Dockerfile.*|.*\.dockerfile|docker-compose.*|compose.*|\.nvmrc|\.node-version|\.tool-versions|Makefile|Procfile)$/i.test(name)
      || /\.(json|ya?ml|toml|sh|ini|conf)$/i.test(name)
    if (!textual || /\.min\.js$/.test(name))
      continue
    const text = read(root, file)
    if (text === null)
      continue

    if (name === 'package.json') {
      const pkg = json(text)
      if (pkg) {
        project.packages.push(file)
        const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }
        for (const dep of Object.keys(all))
          project.deps.add(dep)
        if (all.postgres) {
          project.postgres.push({ file, range: all.postgres })
          if (/npm:@steadybrew\/postgresjs/.test(all.postgres))
            project.fork.push(file)
        }
        all['@steadybrew/postgresjs'] && project.fork.push(file)
        all['@types/node'] && project.typesNode.push({ file, range: all['@types/node'] })
        if (pkg.engines && pkg.engines.node) {
          const major = minMajor(pkg.engines.node)
          project.engines.push({ file, range: pkg.engines.node })
          major && add(major < 22 ? 'node-below-22' : 'node-version', file, lineOf(text, text.indexOf('"node"')), 'engines.node ' + pkg.engines.node, text)
        }
        if (pkg.volta && pkg.volta.node) {
          const major = minMajor(pkg.volta.node)
          major && add(major < 22 ? 'node-below-22' : 'node-version', file, lineOf(text, text.indexOf('"volta"')), 'volta.node ' + pkg.volta.node, text)
        }
        pkg.name && all.postgres && project.postgresNames.push(pkg.name)
        const patchedDeps = (pkg.pnpm && pkg.pnpm.patchedDependencies) || pkg.patchedDependencies || {}
        for (const key of Object.keys(patchedDeps))
          /^postgres@/.test(key) && add('patched-postgres', file, lineOf(text, text.indexOf(key)), key)
        for (const [key, value] of Object.entries({ ...pkg.resolutions, ...all }))
          /^postgres(@|$)/.test(key) && /patch:/.test(String(value)) && add('patched-postgres', file, lineOf(text, text.indexOf(key)), key + ': ' + value)
      }
    }
    if (/^tsconfig.*\.json$/.test(name)) {
      project.tsconfig = true
      ;/"skipLibCheck"\s*:\s*true/.test(text) && (project.skipLibCheck = true)
    }

    nodeVersions(file, text, add)
    scanText(file, text, add)
    lang && scanCode(file, text, lang, project, add)
  }

  for (const c of project.listenCandidates) {
    if (!project.tags.has(c.object))
      continue
    project.listens++
    c.trivial || add('callback-can-throw', c.file, c.line, 'listen')
  }

  const postgresDirs = project.postgres.map(p => dirname(p.file))
  const related = (file, source) => {
    if (/^\.github\/workflows\//.test(file))
      return postgresDirs.includes('.') || postgresDirs.some(d => source.includes(d)) || project.postgresNames.some(n => source.includes(n))
    const dir = dirname(file)
    return postgresDirs.some(d => dir === '.' || d === dir || d.startsWith(dir + '/') || dir.startsWith(d + '/'))
  }
  for (const v of versions)
    related(v.file, v.source || '') && record(v.id, v.file, v.line, v.text)

  const workspace = new Set(project.packages.length ? project.postgresNames : [])
  for (const dep of project.viaDependency)
    workspace.has(dep.name) || add(
      dep.runtime === false ? 'postgres-via-tooling' : project.imported.has(dep.name) ? 'postgres-via-dependency' : 'postgres-via-transitive',
      dep.file, dep.line,
      dep.name + ' depends on postgres ' + dep.range + (project.imported.has(dep.name) ? ', imported by your code' : '') + (dep.runtime === null ? '; this lockfile does not say whether it ships to production' : ''))

  if (project.copies.length && project.maxOne.length)
    for (const copy of project.copies)
      add('copy-with-max-1', copy.file, copy.line, 'COPY with max: 1 at ' + project.maxOne[0].file + ':' + project.maxOne[0].line)

  for (const { file, range } of project.typesNode) {
    const major = minMajor(range.replace(/^[\^~>=<\s]+/, ''))
    if (project.tsconfig && major && major < 22 && !project.skipLibCheck)
      add('types-node-below-22', file, 1, '@types/node ' + range)
  }

  const deps = project.deps
  const facts = {
    postgres: project.postgres,
    fork: project.fork.length > 0,
    lockfiles: project.lockfiles,
    importers: project.importers.length,
    clients: project.clients,
    reserves: project.reserves,
    begins: project.begins,
    copies: project.copies.length,
    subscribes: project.subscribes,
    listens: project.listens,
    maxOne: project.maxOne.length,
    orm: ['drizzle-orm', 'drizzle-kit', 'kysely', 'kysely-postgres-js', 'postgres-shift', 'ley'].filter(d => deps.has(d)),
    tracers: [...deps].filter(d => d === 'dd-trace' || sentryServer.test(d) || d === 'newrelic' || /^@opentelemetry\/(sdk-node|auto-instrumentations-node)$/.test(d)),
    runtimes: [
      (deps.has('wrangler') || deps.has('@cloudflare/workers-types')) && 'cloudflare',
      (deps.has('vercel') || [...deps].some(d => d.startsWith('@vercel/'))) && 'vercel',
      deps.has('next') && 'next',
      project.lockfiles.some(l => l.startsWith('bun.lock')) && 'bun',
      deps.has('@types/bun') && 'bun-types',
      files.some(f => /^(deno\.jsonc?|deno\.lock)$/.test(f)) && 'deno',
      [...deps].some(d => /^(aws-cdk-lib|serverless|@aws-sdk\/client-lambda|sst)$/.test(d)) && 'aws'
    ].filter(Boolean),
    typescript: project.tsconfig
  }
  return { facts, findings }
}

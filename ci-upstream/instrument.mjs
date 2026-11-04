import fs from 'fs'

const file = process.argv[2]
let s = fs.readFileSync(file, 'utf8')

const swap = (a, b) => {
  if (s.split(a).length !== 2)
    throw new Error('anchor not found exactly once: ' + a)
  s = s.replace(a, b)
}

swap(
  "import util from 'util'",
  "import util from 'util'\nimport fs from 'fs'\nconst record = x => process.env.RESULTS && fs.appendFileSync(process.env.RESULTS, JSON.stringify(x) + '\\n')"
)
swap(
  'const x = tests[line + \' \' + name] = { fn, line, name }',
  'const x = tests[line + \' \' + name] = { fn, line, name }\n  record({ event: \'registered\', line, name })'
)
swap(
  '    current = x\n',
  '    current = x\n    x.started = Date.now()\n'
)
swap(
  'x.succeeded = true',
  'x.succeeded = true\n      record({ event: \'pass\', line: x.line, name: x.name, ms: Date.now() - x.started })'
)
swap(
  'x.error = err instanceof Error ? err : new Error(util.inspect(err))',
  'x.error = err instanceof Error ? err : new Error(util.inspect(err))\n      record({ event: \'fail\', line: x.line, name: x.name, ms: Date.now() - x.started, error: util.inspect(x.error, { depth: 4 }).slice(0, 6000) })'
)
swap(
  'function stray(err) {',
  'function stray(err) {\n  record({ event: \'stray\', current: current && current.name, error: util.inspect(err, { depth: 4 }).slice(0, 4000) })'
)
swap(
  'function exit() {',
  'function exit() {\n  record({ event: \'exit\' })\n  setTimeout(() => process.exit(), 3000).unref()'
)

fs.writeFileSync(file, s)

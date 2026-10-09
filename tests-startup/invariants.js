const allowed = {
  Closed: ['closed'],
  Backoff: ['connecting', 'ended'],
  Connecting: ['connecting', 'ended'],
  Initializing: ['connecting', 'ended'],
  Ready: ['open', 'busy', 'full'],
  ReadyOwned: ['reserved', 'full'],
  Draining: ['ended'],
  DrainingOwned: ['reserved', 'full'],
  Closing: ['ended']
}

const edges = {
  Closed: ['Backoff', 'Connecting'],
  Backoff: ['Connecting', 'Closed'],
  Connecting: ['Initializing', 'Backoff', 'Closed'],
  Initializing: ['Ready', 'Backoff', 'Closed'],
  Ready: ['Draining', 'Closing', 'Closed'],
  Draining: ['Closing', 'Closed'],
  Closing: ['Closed']
}

export const violations = []

const connections = []
const phase = c => c[Symbol.for('postgres.js:phase')]
const where = () => new Error().stack.split('\n').slice(4, 7).join(' <- ')

function inspect(c, queues) {
  const name = Object.keys(queues).find(x => queues[x] === c.queue)
  const key = phase(c) + (c.owner && allowed[phase(c) + 'Owned'] ? 'Owned' : '')
  const label = phase(c) + (c.owner ? '+owner' : '') + ' in ' + name
  allowed[key].includes(name) || violations.push(label + ' at ' + where())
}

export function install() {
  globalThis[Symbol.for('postgres.js:check')] = (kind, c, a, b) => {
    if (kind === 'created')
      return a.closed && connections.push([c, a])

    if (kind === 'unhandled')
      return violations.push('unhandled ' + b + ' in ' + a + ' at ' + where())

    if (kind === 'settled')
      return a.closed && inspect(c, a)

    edges[a].includes(b) || violations.push('illegal edge ' + a + ' -> ' + b + ' at ' + where())
  }
}

export function verify() {
  connections.forEach(([c, queues]) => inspect(c, queues))
  if (violations.length)
    throw new Error('Invariant violated: ' + violations.join('; '))
}

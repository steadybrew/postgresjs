const allowed = {
  Closed: ['closed'],
  Backoff: ['connecting', 'ended'],
  Connecting: ['connecting', 'ended'],
  Ready: ['open', 'busy', 'full'],
  ReadyOwned: ['reserved', 'full'],
  Draining: ['ended'],
  DrainingOwned: ['reserved', 'full'],
  Closing: ['ended']
}

const edges = {
  Closed: ['Backoff', 'Connecting'],
  Backoff: ['Connecting', 'Closed'],
  Connecting: ['Ready', 'Backoff', 'Closed'],
  Ready: ['Draining', 'Closing', 'Closed'],
  Draining: ['Closing', 'Closed'],
  Closing: ['Closed']
}

export const violations = []

const connections = []
const phase = c => c[Symbol.for('postgres.js:phase')]
const where = () => new Error().stack.split('\n').slice(4, 7).join(' <- ')

function inspect() {
  for (const [c, queues] of connections) {
    const name = Object.keys(queues).find(x => queues[x] === c.queue)
    const key = phase(c) + (c.owner && allowed[phase(c) + 'Owned'] ? 'Owned' : '')
    const label = phase(c) + (c.owner ? '+owner' : '') + ' in ' + name
    allowed[key].includes(name) || violations.includes(label) || violations.push(label)
  }
}

export function install() {
  globalThis[Symbol.for('postgres.js:check')] = (kind, c, a, b) => {
    if (kind === 'created')
      return a.closed && connections.push([c, a])

    edges[a].includes(b) || violations.push('illegal edge ' + a + ' -> ' + b + ' at ' + where())
  }
  setInterval(inspect, 1).unref()
}

export function verify() {
  inspect()
  if (violations.length)
    throw new Error('Invariant violated: ' + violations.join('; '))
}

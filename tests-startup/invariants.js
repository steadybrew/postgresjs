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

const requestEdges = {
  New: ['Queued', 'Opening', 'Sent', 'Active', 'Settled'],
  Queued: ['Opening', 'Sent', 'Active', 'Settled'],
  Opening: ['Sent', 'Active', 'Settled'],
  Sent: ['Active', 'Settled'],
  Active: ['Sent', 'Settled']
}

export const violations = []

const routed = new Set()
const handed = new Set()

export const handovers = []
export const seen = []
export const history = new WeakMap()

const visit = (request, stage) => (history.get(request) || history.set(request, ['New']).get(request)).push(stage)
const stages = ['New', 'Queued', 'Opening', 'Sent', 'Active', 'Settled']

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

    if (kind === 'routed')
      return seen.push(c), stages[c.stage] === 'Settled' || routed.add(c)

    if (kind === 'requestSettled') {
      routed.delete(c)
      visit(c, 'Settled')
      return requestEdges[a].includes('Settled') || violations.push('illegal request edge ' + a + ' -> Settled at ' + where())
    }

    if (kind === 'handover') {
      handed.has(c) && violations.push('request handed over twice at ' + where())
      handed.add(c)
      handovers.push({ request: c, fresh: a, behind: b })
      return (stages[c.stage] === 'Opening') === a || violations.push('hand-over fresh=' + a + ' for stage ' + c.stage + ' at ' + where())
    }

    if (kind === 'step')
      return visit(c, b), requestEdges[a].includes(b) || violations.push('illegal request edge ' + a + ' -> ' + b + ' at ' + where())

    if (kind === 'unhandled')
      return violations.push('unhandled ' + b + ' in ' + a + ' at ' + where())

    if (kind === 'settled')
      return a.closed && inspect(c, a)

    edges[a].includes(b) || violations.push('illegal edge ' + a + ' -> ' + b + ' at ' + where())
  }
}

const describe = q => [(q.strings || []).join('?'), q.executed, !!q.state, !!q.queue, q.cancelled].join(' ')

export function verify() {
  connections.forEach(([c, queues]) => inspect(c, queues))
  routed.size && violations.push(routed.size + ' routed request(s) never settled: ' + [...routed].map(describe).join('; '))
  if (violations.length)
    throw new Error('Invariant violated: ' + violations.join('; '))
}

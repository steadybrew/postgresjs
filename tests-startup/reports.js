import assert from 'assert'

const scenarios = {}

export const reportNames = Object.keys(scenarios)

export async function reports(name, postgres) {
  assert(scenarios[name], 'Unknown report scenario ' + name)
  await scenarios[name](postgres)
}

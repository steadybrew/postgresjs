import postgres from 'postgres'

export const sql = postgres({
  max: 1,
  prepare: false,
  onnotice: false,
  fetch_types: false,
  onclose: (id: number) => {
    metrics.increment(id.toString())
  },
  debug: () => undefined
})

declare const metrics: { increment(name: string): void }

import { main, tracer } from './harness.mjs'

const events = []
const t = await tracer(process.env.TRACER, events)
const { default: postgres } = await import('postgres')
await main(t, postgres, events)

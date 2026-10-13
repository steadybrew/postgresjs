(async() => {
  const { main, tracer } = await import('./harness.mjs')
  const events = []
  const t = await tracer(process.env.TRACER, events)
  const postgres = require('postgres')
  await main(t, postgres, events)
})()

import postgres from '../types/index'
import { Duplex, PassThrough } from 'node:stream'

postgres({ sslnegotiation: 'direct', ssl: 'require' })
postgres({ sslnegotiation: 'postgres' })
postgres({ sslnegotiation: null })
// @ts-expect-error
postgres({ sslnegotiation: 'nope' })

postgres({ socket: o => { const hosts: string[] = o.host; return new PassThrough() as Duplex } })
postgres({ socket: async () => new PassThrough() })
// @ts-expect-error
postgres({ socket: () => 5 })

const sql = postgres({
  types: { big: postgres.BigInt },
  socket: o => {
    const types: {} = o.types
    return new PassThrough()
  }
})
sql.options.socket?.(sql.options)
postgres().options.socket?.(postgres().options)

new postgres.PostgresError({ message: 'x', code: '23505', severity: 'ERROR' })
new postgres.PostgresError({ code: '23505' })
// @ts-expect-error
new postgres.PostgresError('boom')

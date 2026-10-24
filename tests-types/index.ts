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
new postgres.PostgresError('boom')
// @ts-expect-error
new postgres.PostgresError(42)

const queryTrace: postgres.QueryTraceContext = { query: undefined, values: undefined, database: 'a', user: 'b', serverAddress: undefined, serverPort: undefined, connectionId: undefined }
const connectionTrace: postgres.ConnectionTraceContext = { connectionId: 1, database: 'a', user: 'b', serverAddress: 'localhost', serverPort: 5432 }
const transactionTrace: postgres.TransactionTraceContext = { database: 'a', user: 'b', options: 'read write', savepoint: undefined, prepared: undefined, result: { committed: true } }
const closeMessage: postgres.ConnectionCloseMessage = { connectionId: 1, error: undefined }
void [queryTrace, connectionTrace, transactionTrace, closeMessage]

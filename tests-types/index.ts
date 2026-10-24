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

const client: postgres.TraceClient = { database: 'a', host: 'localhost', port: 5432, user: 'b', ssl: false, processID: undefined }
const queryTrace: postgres.QueryTraceContext = { query: { text: undefined, name: undefined }, client }
const connectTrace: postgres.ConnectTraceContext = { connection: { database: 'a', host: 'localhost', port: 5432, user: 'b', ssl: false } }
const poolConnectTrace: postgres.PoolConnectTraceContext = { pool: { totalCount: 1, idleCount: 0, waitingCount: 0, maxSize: 10 }, handoverTime: 1, queuedBehind: 0, client: { processID: 1, reused: true } }
const transactionTrace: postgres.TransactionTraceContext = { client, options: 'read write', savepoint: undefined, prepared: undefined, result: { committed: true } }
const releaseMessage: postgres.PoolReleaseMessage = { client: { processID: 1 }, error: undefined }
const removeMessage: postgres.PoolRemoveMessage = { client: { processID: 1 }, error: undefined }
void [queryTrace, connectTrace, poolConnectTrace, transactionTrace, releaseMessage, removeMessage]

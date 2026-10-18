import { sql } from './db'

declare function handle(row: unknown): void
declare function work(payload: unknown): void

sql.subscribe('insert:events', row => handle(row))
sql.listen('jobs', payload => work(JSON.parse(payload)))

class Socket {
  listen(event: string, fn: (e: unknown) => void) {}
  open() {
    this.listen('open', e => handle(e))
  }
}

declare const emitter: Socket
emitter.listen('message', e => handle(e))

sql.listen('async-jobs', async payload => work(JSON.parse(payload)))

sql.listen('guarded', payload => {
  try {
    work(JSON.parse(payload))
  } catch {
    handle(payload)
  }
})

sql.listen('rethrown', payload => {
  try {
    work(JSON.parse(payload))
  } catch (e) {
    throw new Error('bad payload', { cause: e })
  }
})

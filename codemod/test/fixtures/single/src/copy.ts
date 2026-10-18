import { sql } from './db'

export async function load() {
  const stream = await sql`copy t from stdin`.writable()
  stream.end()
}

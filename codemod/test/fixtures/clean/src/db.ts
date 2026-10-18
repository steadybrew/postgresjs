import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

const client = postgres(process.env.DATABASE_URL!, { max: 10, idle_timeout: 20 })

export const db = drizzle(client)

export async function health() {
  return client`select 1`
}

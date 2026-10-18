import { createClient } from 'client-lib'
import { start } from 'framework-y'

export const db = createClient(process.env.DATABASE_URL)
start(db)

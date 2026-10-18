import { sql } from './db'

declare function timeout(ms: number): Promise<never>

export const first = () => Promise.race([sql`select 1`, timeout(5000)])

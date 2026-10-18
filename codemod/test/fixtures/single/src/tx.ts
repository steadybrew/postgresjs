import { sql } from './db'

let saved: unknown

export async function run(name: string) {
  await sql.begin(async tx => {
    await tx`insert into t values (1)`
    setTimeout(() => tx`select 1`, 10)
    saved = tx
    await tx.prepare(name)
  })
}

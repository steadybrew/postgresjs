import { sql } from './db'

export async function leaky() {
  const reserved = await sql.reserve()
  await reserved`select 1`
  reserved.release()
  await reserved`select 2`
}

export async function tidy() {
  const reserved = await sql.reserve()
  async function cleanup() {
    reserved.release()
  }
  try {
    await reserved`select 1`
  } finally {
    await cleanup()
  }
}

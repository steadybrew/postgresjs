import postgres from 'postgres'

export const transient = new Set(['CONNECTION_CLOSED', 'CONNECTION_ENDED'])

class UnsupportedPostgresError extends Error {}

export function fail(version: string) {
  if (version < '14')
    throw new UnsupportedPostgresError(version)
  throw new postgres.PostgresError('boom')
}

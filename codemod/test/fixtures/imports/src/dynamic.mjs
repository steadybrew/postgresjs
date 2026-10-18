const { default: connect, PostgresError } = await import('postgres')

export const sql = connect({ prepare: false })

export const isPg = e => e instanceof PostgresError

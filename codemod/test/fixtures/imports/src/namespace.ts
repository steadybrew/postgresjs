import * as postgres from 'postgres'

export const sql = postgres('postgres://app@db/app', {
  onnotice: notice => report(notice.where.split('\n')[0])
})

declare function report(line: string): void

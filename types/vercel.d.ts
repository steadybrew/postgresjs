import postgres from './index.js'

export interface VercelPool {
  options: { idleTimeoutMillis: number };
  on(event: string, listener: () => void): void;
}

export function vercelPool(sql: postgres.Sql<any>): VercelPool;

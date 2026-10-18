import * as postgres from 'postgres'

const db = postgres()

class Queue {
  #sql = db
  #channel = 'jobs'

  async start() {
    await this.#sql`select 1`
    await this.#sql.listen(this.#channel, payload => JSON.parse(payload))
  }
}

export const queue = new Queue()

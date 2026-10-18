# Postgres.js by Steady Brew

A maintained fork of [Postgres.js](https://github.com/porsager/postgres), the PostgreSQL client created by [Rasmus Porsager](https://github.com/porsager), with the same API.

- **Fixes reported Postgres.js bugs:** 40 open upstream issues, from queries receiving another query's rows to hung pools and crashed processes, each covered by a regression test. See [the list](#fixed-postgresjs-issues).
- **Built for serverless and connection poolers:** bounded connection retries with backoff, idle connections replaced when a frozen instance resumes, pool statistics from `sql.stats()`, and an adapter for Vercel Fluid. Query timeouts and cancellable pool waits are next on the [roadmap](ROADMAP.md).
- **Switch with one line:** your code and the libraries that import `postgres` keep working. See [Switching from Postgres.js](#switching-from-postgresjs).

---

<img align="left" width="440" height="180" alt="Fastest full PostgreSQL nodejs client" src="https://raw.githubusercontent.com/porsager/postgres/master/postgresjs.svg?sanitize=true">

- [🚀 Fastest full-featured node & deno client](https://github.com/porsager/postgres-benchmarks#results)
- 🏷 ES6 Tagged Template Strings at the core
- 🏄‍♀️ Simple surface API
- 🖊️ Dynamic query support

<br clear="all">

## Compatibility

[![test](https://github.com/steadybrew/postgresjs/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/steadybrew/postgresjs/actions/workflows/test.yml?query=branch%3Amain)

**Version 4 runs on Node.js 22 or newer** and supports PostgreSQL 15–18. Every release passes the full test matrix before it is published.

| Runtime | PostgreSQL | Notes |
| --- | --- | --- |
| Node 22, 24 and 26, ESM and CJS | 15–18 | |
| Deno 1.46.3 | 17 | No Deno 2 claim |
| Cloudflare Workers (workerd) | 17 | A "Stream was cancelled" rejection on socket close remains ([#1196](https://github.com/porsager/postgres/issues/1196), [#1202](https://github.com/porsager/postgres/issues/1202)) |
| Bun | | Best effort, not tested in CI |

[The test workflow](https://github.com/steadybrew/postgresjs/blob/main/.github/workflows/test.yml) defines which pairs run on each push. Supabase PostgreSQL and Supabase Edge are separate environments; Deno 1.46.3 coverage does not imply Deno 2 or hosted Supabase Edge.

## Switching from Postgres.js

```sh
npm install postgres@npm:@steadybrew/postgresjs@^4
```

This installs the fork under the name `postgres`, so `import postgres from 'postgres'` stays as it is, and so do libraries that import it, such as `drizzle-orm/postgres-js`, `drizzle-kit` and `kysely-postgres-js`. Then read [Upgrading to 4.0.0](#upgrading-to-400) for the behaviour changes.

Tracing: from 4.5.0, dd-trace records the same database spans as with Postgres.js when the fork is installed under the `postgres` name. Sentry's automatic integration instruments `postgres` versions below 4 only, so widen its range before Sentry loads:

```js
// sentry-postgres.mjs
import { SENTRY_RUNTIME_INSTRUMENTATIONS } from '@sentry/server-utils/orchestrion/config'

for (const instrumentation of SENTRY_RUNTIME_INSTRUMENTATIONS) {
  if (instrumentation.module.name === 'postgres')
    instrumentation.module.versionRange = '>=3.0.0 <5'
}
```

```sh
node --import ./sentry-postgres.mjs --import @sentry/node/import app.js
```

This covers Sentry's runtime hook, not its bundler plugins. With pnpm, add `@sentry/server-utils` at the same version as `@sentry/node` so the file can import it.

## Upgrading to 4.0.0

Version 4.0.0 fixes connection startup, reservations, reconnects, shutdown, transaction ownership, and built-in array handling. When upgrading from Postgres.js 3.4 or `@steadybrew/postgresjs` 3.x:

- Upgrade to **Node.js 22 or newer** before installing.
- Keep queries within the reservation or transaction that owns them. Reserved handles used after `release()`, and transaction handles used after completion, reject with `CONNECTION_ENDED`. A handle whose connection has closed cannot run queries on a reconnected session.
- Pass a non-empty string without NUL characters to transaction `sql.prepare(name)`. Invalid names throw `INVALID_TRANSACTION_NAME`.
- If you use `fetch_types: false`, review code that expects built-in arrays as raw strings: supported built-in arrays are now decoded as JavaScript arrays. SQL `NULL` elements become JavaScript `null`; quoted `"NULL"` text remains a string.

See the [changelog](./CHANGELOG.md#breaking-changes-and-migration) for the full migration notes and fixes.

## Fixed Postgres.js issues

Bugs and feature requests from [porsager/postgres](https://github.com/porsager/postgres) that this fork fixes, whether reported in an issue or in a pull request suggesting a fix, and the version that fixed them. Each fix has a test that reproduces the report, except [#1100](https://github.com/porsager/postgres/issues/1100), which rests on a production measurement, and [#1154](https://github.com/porsager/postgres/issues/1154), whose test reproduces the reported stack without a known trigger. The [changelog](./CHANGELOG.md) has the details.

<details>
<summary>54 bugs and 7 feature requests</summary>

**Wrong results and data safety**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#1082](https://github.com/porsager/postgres/issues/1082), [#729](https://github.com/porsager/postgres/issues/729) | A query whose values fail to serialize rejects on its own; the query running alongside no longer gets its error, and the next query no longer gets another query's rows | 4.3.0 |
| [#1216](https://github.com/porsager/postgres/issues/1216) | A transaction handle whose connection closed rejects with `CONNECTION_CLOSED` instead of running inside the next user's transaction, so it can't read their rows through row-level security. | 4.0.0 |
| [#1248](https://github.com/porsager/postgres/issues/1248) | Statements in a `sql.begin()` callback after its connection closes reject instead of running outside the transaction | 4.0.0 |
| [#1204](https://github.com/porsager/postgres/issues/1204) | A transaction's connection is not handed to another `sql.begin()` when its socket drains late, so one transaction's `COMMIT` can't commit another's unfinished writes. | 4.0.0 |
| [#1217](https://github.com/porsager/postgres/issues/1217) | `sql.begin()` rejects with `TRANSACTION_ROLLED_BACK` when the server rolled back the COMMIT | 4.4.0 |
| [#1249](https://github.com/porsager/postgres/issues/1249), [#1226](https://github.com/porsager/postgres/issues/1226), [#1223](https://github.com/porsager/postgres/issues/1223) | The first query after a reconnect no longer rejects with an error from the closed session | 4.0.0 |
| [#789](https://github.com/porsager/postgres/issues/789) | `sql.array()` infers the right array type on first use | 4.0.0 |
| [#1049](https://github.com/porsager/postgres/issues/1049), [#1124](https://github.com/porsager/postgres/issues/1124) | `NULL` elements in arrays parse as `null`, not `NaN` or the string `"NULL"` | 4.0.0 |
| [#1252](https://github.com/porsager/postgres/issues/1252) | Cancelling a pipelined query that hasn't started no longer gives the next query its result | 4.1.0 |
| [#1253](https://github.com/porsager/postgres/issues/1253), [#1181](https://github.com/porsager/postgres/issues/1181), [#1119](https://github.com/porsager/postgres/issues/1119) | A query no longer gets empty slots at the start of its result after the previous query on the connection failed or was cancelled partway through its rows | 4.5.0 |

**Hangs**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#751](https://github.com/porsager/postgres/issues/751), [#1219](https://github.com/porsager/postgres/issues/1219), [#1203](https://github.com/porsager/postgres/issues/1203) | `sql.reserve()` on a pool that hasn't opened a connection yet resolves, with or without `fetch_types` and on Cloudflare Workers | 4.0.0 |
| [#1195](https://github.com/porsager/postgres/issues/1195), [#1199](https://github.com/porsager/postgres/issues/1199) | A reservation survives its connection being terminated by the server, and the pool recovers after it is released | 4.0.0 |
| [#1186](https://github.com/porsager/postgres/issues/1186) | Queries queued on a reserved or transaction handle settle when its connection closes | 4.0.0 |
| [#1097](https://github.com/porsager/postgres/issues/1097), [#1130](https://github.com/porsager/postgres/issues/1130), [#1242](https://github.com/porsager/postgres/issues/1242), [#861](https://github.com/porsager/postgres/issues/861) | `sql.end()` resolves after a disconnect, after a failed query and after a connection closes inside `sql.begin()`, and waits for queries queued in the pool | 4.0.0 |
| [#1246](https://github.com/porsager/postgres/issues/1246) | A query sent between a socket error and its close settles, and a transaction reset mid-statement no longer loses a pool connection | 4.1.0 |
| [#1193](https://github.com/porsager/postgres/issues/1193) | A connection closed during startup settles its first query instead of reconnecting in a tight loop | 4.0.0 |
| [#1234](https://github.com/porsager/postgres/issues/1234) | Concurrent queries in `sql.begin()` after a column type change roll the transaction back and return the connection to the pool | 4.4.0 |
| [#1255](https://github.com/porsager/postgres/issues/1255), [#1261](https://github.com/porsager/postgres/issues/1261) | A reserved connection whose `max_lifetime` passed is closed when released, and `sql.end()` called before the release resolves | 4.0.0 |
| [#1016](https://github.com/porsager/postgres/pull/1016) | Queries no longer hang after a `COPY ... TO STDOUT` whose reader fell behind | 4.5.0 |

**Crashes**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#1154](https://github.com/porsager/postgres/issues/1154), [#1208](https://github.com/porsager/postgres/issues/1208), [#1133](https://github.com/porsager/postgres/issues/1133) | A reserved or transaction connection that the server or network closes rejects its later statements, and `sql.begin()`'s own `ROLLBACK` or `COMMIT`, with `CONNECTION_CLOSED` instead of crashing the process with `Cannot read properties of null (reading 'write')`. | 4.0.0 |
| [#1192](https://github.com/porsager/postgres/issues/1192), [#1205](https://github.com/porsager/postgres/issues/1205), [#1086](https://github.com/porsager/postgres/issues/1086) | A failed or cancelled type query at startup rejects the query instead of crashing the process | 4.0.0 |
| [#1088](https://github.com/porsager/postgres/issues/1088) | Timers no longer fail on Cloudflare Workers | 4.0.0 |
| [#1227](https://github.com/porsager/postgres/issues/1227) | Assigning `err.stack` on a query error no longer throws on Node 22 and newer | 4.5.0 |
| [#1009](https://github.com/porsager/postgres/pull/1009) | The `camel` and `pascal` transforms no longer throw on a column name ending with an underscore | 4.5.0 |

**Reconnects and failover**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#1179](https://github.com/porsager/postgres/issues/1179) | Failed connection attempts back off instead of the whole pool retrying at once | 4.0.0 |
| [#1250](https://github.com/porsager/postgres/issues/1250) | A connection closed with a statement still buffered reconnects, instead of failing every later statement with `CONNECT_TIMEOUT` | 4.0.0 |
| [#1174](https://github.com/porsager/postgres/issues/1174), [#815](https://github.com/porsager/postgres/issues/815), [#988](https://github.com/porsager/postgres/issues/988) | With several hosts, retries move to the next host, a connect timeout fails over, and `prefer-standby` falls back to a primary | 4.0.0 |

**Transactions, notices and subscriptions**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#823](https://github.com/porsager/postgres/issues/823), [#1189](https://github.com/porsager/postgres/issues/1189), [#1210](https://github.com/porsager/postgres/issues/1210) | `sql.begin()` no longer fails with `UNSAFE_TRANSACTION` or sends a second `BEGIN` on a busy connection when transactions and queries run concurrently, at the pipeline limit, under write backpressure or with `max_pipeline: 0` | 4.0.0 |
| [#1063](https://github.com/porsager/postgres/issues/1063) | `onnotice: false` silences notices | 4.4.0 |
| [#1087](https://github.com/porsager/postgres/issues/1087) | `sql.subscribe()` no longer adds a listener on each subscribe or loses changes after a transform throws | 4.4.0 |

**TypeScript**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#1158](https://github.com/porsager/postgres/issues/1158), [#1177](https://github.com/porsager/postgres/pull/1177) | `sslnegotiation` is in the option types | 4.5.0 |
| [#968](https://github.com/porsager/postgres/pull/968) | `socket` is in the option types | 4.5.0 |
| [#703](https://github.com/porsager/postgres/issues/703), [#1194](https://github.com/porsager/postgres/pull/1194) | `new PostgresError('message')` sets the message, as with `Error`, and the types declare both the message and the fields forms | 4.5.0 |

**Feature requests**

| Issue | What you get | Since |
| --- | --- | --- |
| [#443](https://github.com/porsager/postgres/issues/443), [#908](https://github.com/porsager/postgres/issues/908) | `sql.stats()` reports connections in use and idle, and queries waiting | 4.3.0 |
| [#1100](https://github.com/porsager/postgres/issues/1100) | An `onidle` callback and the `@steadybrew/postgresjs/vercel` adapter | 4.2.0 |
| [#1164](https://github.com/porsager/postgres/issues/1164) | Built-in array types are decoded, and plain JavaScript arrays are sent, with `fetch_types: false` | 4.0.0 |
| [#886](https://github.com/porsager/postgres/issues/886), [#1094](https://github.com/porsager/postgres/issues/1094) | `await using` ends a pool and releases a reserved connection when it goes out of scope | 4.5.0 |
| [#1225](https://github.com/porsager/postgres/issues/1225) | Queries with values in one round trip instead of two, opt-in with `parameter_types: 'client'` | 4.5.0 |

Bun isn't tested here, so Bun-only reports such as [#1066](https://github.com/porsager/postgres/issues/1066) aren't listed; the same crash on Node is [#1208](https://github.com/porsager/postgres/issues/1208).

</details>

## Getting started

<br>
<img height="220" width="458" alt="Good UX with Postgres.js" src="https://raw.githubusercontent.com/porsager/postgres/master/demo.gif">
<br>

### Installation
```bash
$ npm install @steadybrew/postgresjs
```

### Usage
Create your `sql` database instance
```js
// db.js
import postgres from '@steadybrew/postgresjs'

const sql = postgres({ /* options */ }) // will use psql environment variables

export default sql
```

Simply import for use elsewhere
```js
// users.js
import sql from './db.js'

async function getUsersOver(age) {
  const users = await sql`
    select
      name,
      age
    from users
    where age > ${ age }
  `
  // users = Result [{ name: "Walter", age: 80 }, { name: 'Murray', age: 68 }, ...]
  return users
}


async function insertUser({ name, age }) {
  const users = await sql`
    insert into users
      (name, age)
    values
      (${ name }, ${ age })
    returning name, age
  `
  // users = Result [{ name: "Murray", age: 68 }]
  return users
}
```

#### ESM dynamic imports

The library can be used with ESM dynamic imports as well as shown here.

```js
const { default: postgres } = await import('@steadybrew/postgresjs')
```

## Documentation

The API reference is in [docs/api.md](docs/api.md), and the changes in each release are in the [changelog](CHANGELOG.md).

## Thank you

A really big thank you to [@JAForbes](https://twitter.com/jmsfbs) who introduced me to Postgres and still holds my hand navigating all the great opportunities we have.

Thanks to [@ACXgit](https://twitter.com/andreacoiutti) for initial tests and dogfooding.

Also thanks to [Ryan Dahl](https://github.com/ry) for letting me have the `postgres` npm package name.

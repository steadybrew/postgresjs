# Fixed Postgres.js issues

Bugs from [porsager/postgres](https://github.com/porsager/postgres) that this fork fixes, whether reported in an issue or in a pull request suggesting a fix. Each fix has a test that reproduces the report and fails on Postgres.js 3.4.9, except [#1154](https://github.com/porsager/postgres/issues/1154), whose test reproduces the reported stack without a known trigger. The [changelog](../CHANGELOG.md) has the details.

## Correctness

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

**TypeScript**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#1158](https://github.com/porsager/postgres/issues/1158), [#1177](https://github.com/porsager/postgres/pull/1177) | `sslnegotiation` is in the option types | 4.5.0 |
| [#968](https://github.com/porsager/postgres/pull/968) | `socket` is in the option types | 4.5.0 |
| [#703](https://github.com/porsager/postgres/issues/703), [#1194](https://github.com/porsager/postgres/pull/1194) | `new PostgresError('message')` sets the message, as with `Error`, and the types declare both the message and the fields forms | 4.5.0 |

## Reliability

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
| [#1213](https://github.com/porsager/postgres/issues/1213) | On Cloudflare Workers, connecting over TLS to a server whose certificate chains to a private CA, such as Supabase's, rejects at once with `TLS_CLOSED` instead of hanging or waiting out `connect_timeout` | 4.6.0-rc1 |

**Crashes**

| Issue | What happens now | Since |
| --- | --- | --- |
| [#1154](https://github.com/porsager/postgres/issues/1154), [#1208](https://github.com/porsager/postgres/issues/1208), [#1133](https://github.com/porsager/postgres/issues/1133) | A reserved or transaction connection that the server or network closes rejects its later statements, and `sql.begin()`'s own `ROLLBACK` or `COMMIT`, with `CONNECTION_CLOSED` instead of crashing the process with `Cannot read properties of null (reading 'write')`. | 4.0.0 |
| [#1192](https://github.com/porsager/postgres/issues/1192), [#1205](https://github.com/porsager/postgres/issues/1205), [#1086](https://github.com/porsager/postgres/issues/1086) | A failed or cancelled type query at startup rejects the query instead of crashing the process | 4.0.0 |
| [#1088](https://github.com/porsager/postgres/issues/1088) | Timers no longer fail on Cloudflare Workers | 4.0.0 |
| [#975](https://github.com/porsager/postgres/issues/975) | `COPY ... TO STDOUT` streams and `sql.subscribe()` no longer fail on Cloudflare Workers with `socket.resume is not a function` | 4.6.0-rc1 |
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

Bun isn't tested here, so Bun-only reports such as [#1066](https://github.com/porsager/postgres/issues/1066) aren't listed; the same crash on Node is [#1208](https://github.com/porsager/postgres/issues/1208).


[Back to the README](../README.md)

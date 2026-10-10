# Changelog

## v4.2.0 - 2026-10-10

### Features

- **`onidle(connId)` option,** called each time a connection returns to the pool idle and its idle timer starts. It can also be set after creation through `sql.options.onidle`. If it throws, the error is rethrown as an uncaught exception and the connection is not affected. The internal listen and subscribe connections do not call it. Based on porsager/postgres#1147.
- **`@steadybrew/postgresjs/vercel` exports `vercelPool(sql)`** for `attachDatabasePool` from `@vercel/functions`, so Vercel Fluid Compute keeps an instance alive until idle connections have closed. It requires `idle_timeout`. Closes porsager/postgres#1100.

## v4.1.0 - 2026-10-09

Reworks the connection lifecycle for reliability: every connection event goes through one phase table, leases have explicit states, and startup retries are decided in one place. These changes are relative to `@steadybrew/postgresjs@4.0.0`, and the contract is described in [docs/lifecycle.md](docs/lifecycle.md).

There are no breaking changes: APIs and error codes are the same as in 4.0.0. Where an error now carries more detail, it is in `err.cause`.

### Behavior changes

- **A `target_session_attrs` mismatch says why.** The query still rejects with `CONNECTION_CLOSED`, now with a `TARGET_SESSION_ATTRS` error as its cause that names each host and why it was rejected. With several hosts, a round in which every host answered and none matched fails at once instead of retrying until `connect_timeout`. A single host still retries until `connect_timeout`, which rides out a failover behind one DNS name such as an Aurora cluster endpoint. See [8e01447](https://github.com/steadybrew/postgresjs/commit/8e01447), [13cecc3](https://github.com/steadybrew/postgresjs/commit/13cecc3) and [7c00564](https://github.com/steadybrew/postgresjs/commit/7c00564).
- **`prefer-standby` tries every host for a standby before accepting a primary,** and starts the standby pass again after each backoff round, as libpq does. Two primaries now take three attempts instead of two. See [8f917eb](https://github.com/steadybrew/postgresjs/commit/8f917eb).
- **Idle connections past `idle_timeout` or `max_lifetime` are terminated when handed out,** and the request is served from a new session. This covers timers that could not fire while a serverless instance was frozen. Such a connection closes without sending Terminate, so the server may log an unexpected EOF. See [006e2bb](https://github.com/steadybrew/postgresjs/commit/006e2bb).
- **A graceful close is bounded by `connect_timeout`.** If the server does not close the socket within that many seconds after Terminate, the connection is closed anyway, so `sql.end()` without a timeout resolves. `connect_timeout: 0` leaves it unbounded. See [006e2bb](https://github.com/steadybrew/postgresjs/commit/006e2bb).
- **Work arriving between a socket error and the close event runs on the reconnected connection** instead of rejecting with `CONNECTION_CLOSED`; the connection now closes as soon as its socket fails. See [2226c81](https://github.com/steadybrew/postgresjs/commit/2226c81).
- **Statements on a transaction handle while its COMMIT or ROLLBACK is in flight reject with `CONNECTION_ENDED`** instead of running inside that transaction. See [b3446d1](https://github.com/steadybrew/postgresjs/commit/b3446d1).

### Fixes

- **Lost sessions say why:** when the server ends a session with FATAL (for example 57P01 from `pg_terminate_backend` or a failover), in-flight work still rejects with `CONNECTION_CLOSED`, now with the server's error as `err.cause`. A reserved handle or transaction whose connection is lost rejects with `CONNECTION_CLOSED` whose cause is the FATAL or socket error. Retry logic keyed on `CONNECTION_CLOSED` keeps working. See [2662ff9](https://github.com/steadybrew/postgresjs/commit/2662ff9).
- **Cancelled pipelined queries:** cancelling a query pipelined behind another left it unsettled and gave its response to the next query. A TLS configuration error while sending a CancelRequest now rejects the cancel instead of throwing from an event callback. See [ab0b431](https://github.com/steadybrew/postgresjs/commit/ab0b431).
- **Pool queue drift:** the first query after startup now pipelines like any other, and a reserved connection released while the pool is ending no longer stays in `reserved` with no owner. See [6b41c92](https://github.com/steadybrew/postgresjs/commit/6b41c92).
- **`Query.cancel()`** returns a promise that settles when the CancelRequest finishes, so a failed cancel can be awaited and an unawaited one is no longer an unhandled rejection. Its declared type is now `Promise<void>`, so lint rules such as `no-floating-promises` may flag a bare `query.cancel()`. See [ab0b431](https://github.com/steadybrew/postgresjs/commit/ab0b431) and [5c6ee31](https://github.com/steadybrew/postgresjs/commit/5c6ee31).
- **Queued queries during `end()`:** a plain query queued when the last connection is lost during a graceful `end()` gets one reconnect and runs, and `end()` waits for it, as the README promises. If the reconnect fails, the queued queries reject with its error. See [db7f619](https://github.com/steadybrew/postgresjs/commit/db7f619).
- **Short `max_lifetime`:** the lifetime now counts from hand-off, so a `max_lifetime` shorter than connection startup no longer makes `sql.begin()` or `sql.reserve()` on a fresh connection reject with `CONNECTION_ENDED`. See [7520b1e](https://github.com/steadybrew/postgresjs/commit/7520b1e).
- **Long delays:** `idle_timeout`, `max_lifetime`, `connect_timeout`, the backoff and `sql.end({ timeout })` above about 24.8 days no longer collapse to 1 ms, which closed connections after every query or timed out every attempt. See [fe5e774](https://github.com/steadybrew/postgresjs/commit/fe5e774).
- **Leases:** a statement cancelled while queued on a reserved or transaction handle, or before it was sent, no longer hangs the rest of the handle. A raw `BEGIN` sent through the pool rejects with `UNSAFE_TRANSACTION` even if a lease takes its connection first, and a prepared-statement retry runs only under the owner it was sent with. See [b3446d1](https://github.com/steadybrew/postgresjs/commit/b3446d1).
- **FATAL during startup queries:** a FATAL arriving between two internal startup queries fails the attempt with the server's error and retries, instead of being ignored. See [6208d20](https://github.com/steadybrew/postgresjs/commit/6208d20).
- **Socket factories returning a non-socket** fail the attempt instead of causing an unhandled rejection and a later `CONNECT_TIMEOUT`. See [fb67b83](https://github.com/steadybrew/postgresjs/commit/fb67b83).
- **Deno:** a socket paused for backpressure (COPY TO, subscribe) emits `close` after `destroy()` or `end()`. See [28d8f5a](https://github.com/steadybrew/postgresjs/commit/28d8f5a).
- **Memory per pool:** the element-to-array type map took about 35 KB per pool; it is now a `Map` of under 1 KB. See [3031e0f](https://github.com/steadybrew/postgresjs/commit/3031e0f).
- **Types:** `GenericError` declares `SSL_NOT_SUPPORTED`, `TARGET_SESSION_ATTRS`, `COPY_IN_PROGRESS` and `INVALID_TRANSACTION_NAME`. See [5c6ee31](https://github.com/steadybrew/postgresjs/commit/5c6ee31).

### Upstream issue cross-check

Checked against `porsager/postgres` on 2026-10-09, with upstream `master` at [`411429e`](https://github.com/porsager/postgres/commit/411429e7bd7a3d61155ca9a70a97c111823702ea). Each test below fails on that upstream source for the reason its report gives and passes on this release. These links identify matching reported failures; they do not imply upstream has merged or endorsed this fork's implementation.

| Behavior | Upstream reports | Fixed by | Evidence |
| --- | --- | --- | --- |
| Work arriving between a socket error and its close runs once on the reconnected connection; 4.0.0 rejected it with `CONNECTION_CLOSED` | [#1246](https://github.com/porsager/postgres/issues/1246) | [2226c81](https://github.com/steadybrew/postgresjs/commit/2226c81) | `phase:gap-query`, `gap-query-pool`, `gap-listen`, `lease:reserve-release-after-error` |
| A late socket `drain` no longer hands a transaction's connection to another query or `begin()` | [#1204](https://github.com/porsager/postgres/issues/1204), listed as "likely addresses" in 4.0.0 | 4.0.0 ([c064619](https://github.com/steadybrew/postgresjs/commit/c064619)); test added in [a4313d2](https://github.com/steadybrew/postgresjs/commit/a4313d2) | `lease:begin-late-drain` |
| The first query after a reconnect no longer rejects with an ErrorResponse from the closed session | [#1249](https://github.com/porsager/postgres/issues/1249) | 4.0.0 ([c064619](https://github.com/steadybrew/postgresjs/commit/c064619)); test added in [e59d0cd](https://github.com/steadybrew/postgresjs/commit/e59d0cd) | `phase:error-close-reconnect` |
| `end()` waits for queries queued in the pool and leaves no connection open | [#861](https://github.com/porsager/postgres/issues/861) | 4.0.0 ([c064619](https://github.com/steadybrew/postgresjs/commit/c064619)); test added in [e2a71dc](https://github.com/steadybrew/postgresjs/commit/e2a71dc) | `phase:end-queued-cold` |
| A FATAL answering the type query rejects the query instead of crashing the process | [#1086](https://github.com/porsager/postgres/issues/1086) | 4.0.0 ([c064619](https://github.com/steadybrew/postgresjs/commit/c064619)); test added in [eae5a72](https://github.com/steadybrew/postgresjs/commit/eae5a72) | `phase:fatal-catalog` |

Not claimed: [#925](https://github.com/porsager/postgres/issues/925) does not reproduce on the upstream source either, and [#1234](https://github.com/porsager/postgres/issues/1234) is still open (see below).

### Compatibility and validation

- All ten [CI jobs](https://github.com/steadybrew/postgresjs/actions/runs/37943516565) passed: Node 24/26 with PostgreSQL 15/16/17/18, plus separate Deno 1.46.3 and Cloudflare workerd jobs against PostgreSQL 17.
- In disposable Docker containers on Node 24.21.0 with PostgreSQL 17.11, the startup protocol suite (223 cases), the ESM and CommonJS integration suites (279 assertions each, plus the real PostgreSQL ownership matrix) and the Deno 1.46.3 suite passed.
- Each test that pins an upstream report was run against upstream `411429e`, 4.0.0 and every commit of this release: it fails upstream and passes from its fixing commit onward.

### Known limitations

- Concurrent queries inside `begin()` that hit a cached-plan error (0A000) leave the transaction aborted: later statements reject with `25P02` and the connection returns to the pool idle in an aborted transaction ([#1234](https://github.com/porsager/postgres/issues/1234)). Upstream hangs instead.
- There is still no client-side query timeout. A query on a socket that died silently waits until TCP gives up ([#1089](https://github.com/porsager/postgres/issues/1089)).
- A CancelRequest always goes to the first configured host, which is wrong after a multi-host failover moved the session elsewhere.
- Cloudflare workerd can still emit an unhandled `"Stream was cancelled"` rejection on socket close ([#1196](https://github.com/porsager/postgres/issues/1196), [#1202](https://github.com/porsager/postgres/issues/1202)).

## v4.0.0 - 2026-10-08

Promotes the runtime changes validated in `4.0.0-rc1`; see the candidate entry below for fixes, migration instructions and known limitations. Node.js 24 or newer is required. Later lifecycle refactors remain deferred.

- All ten release-candidate tag CI jobs passed: Node 24/26 × PostgreSQL 15–18, Deno 1.46.3 and workerd.
- Noise passed 992 unit tests, 349 integration tests, typechecking and a Vercel preview build using the candidate tarball. Deployed login and repeated read-only database lookup smoke checks passed. Full authenticated application flows have not been exercised.

## v4.0.0-rc1 - 2026-10-08

First release candidate for the next major version of `@steadybrew/postgresjs`, the independently maintained Steady Brew fork of Postgres.js. These changes are relative to `@steadybrew/postgresjs@3.4.9`.

### Breaking changes and migration

- **Node.js 24 or newer is required**, up from Node.js 12. Upgrade the runtime before installing this release. The supported PostgreSQL matrix is now versions 15–18.
- Reserved handles used after `release()`, and transaction handles used after their transaction finishes, reject with `CONNECTION_ENDED`. Handles whose connection has closed reject rather than running statements on a reconnected session. Keep statements within the reservation or transaction that owns them.
- Transaction `sql.prepare(name)` requires a non-empty string without NUL characters; invalid names throw `INVALID_TRANSACTION_NAME`. Names containing quotes or backslashes are preserved correctly.
- With `fetch_types: false`, supported built-in PostgreSQL arrays are now decoded as JavaScript arrays instead of raw strings. SQL `NULL` array elements become JavaScript `null`; quoted `"NULL"` text remains a string. Review code that depended on the previous representations.

### Fixes

- **Reservations and startup:** cold and queued `reserve()` calls acquire a connection without a warm-up query. Discovered array types are registered before the first user query, and internal catalog/session queries are isolated from user transforms. Internal initialization rejections are handled. See [c064619](https://github.com/steadybrew/postgresjs/commit/c064619).
- **Reconnects and timeouts:** startup attempts discard stale asynchronous results, failed attempts back off, and multi-host connection timeouts advance to the next host. `prefer-standby` can fall back to a primary. See [c064619](https://github.com/steadybrew/postgresjs/commit/c064619).
- **Shutdown:** disconnects during startup or queries no longer leave shutdown waiting indefinitely in the covered cases. Graceful shutdown drains accepted plain queries; forced shutdown rejects remaining work with `CONNECTION_DESTROYED`. See [c064619](https://github.com/steadybrew/postgresjs/commit/c064619) and [3d3f7b4](https://github.com/steadybrew/postgresjs/commit/3d3f7b4).
- **Reservation and transaction ownership:** stale handles cannot execute on another session, queued statements settle when their handle closes, and repeated or late `release()` calls cannot return a connection owned by someone else. `begin()` works with `max_pipeline: 0` and write backpressure. A failed rollback closes the connection instead of returning an open transaction to the pool. See [3d3f7b4](https://github.com/steadybrew/postgresjs/commit/3d3f7b4).
- **Arrays without catalog discovery:** register 22 built-in element/array type pairs locally, preserve explicit parser and serializer overrides independently, and handle SQL `NULL` elements before scalar parsing. See [47854d1](https://github.com/steadybrew/postgresjs/commit/47854d1).
- **Prepared transaction names:** escape quotes and backslashes correctly regardless of `standard_conforming_strings`, and reject invalid names. See [713f8a5](https://github.com/steadybrew/postgresjs/commit/713f8a5).
- **Cloudflare timers and socket cleanup:** timers no longer pass extra arguments to `setTimeout`. The socket adapter emits close once, closes sockets that arrive after destruction, and handles EOF during TLS negotiation. The cancellation rejection described below remains unresolved. See [713f8a5](https://github.com/steadybrew/postgresjs/commit/713f8a5) and its validation correction in [260d036](https://github.com/steadybrew/postgresjs/commit/260d036).
- **Deno socket cleanup:** pending TCP/TLS connections cannot revive a socket after it has been destroyed. See [c064619](https://github.com/steadybrew/postgresjs/commit/c064619).

### Upstream issue cross-check

Checked against `porsager/postgres` on 2026-10-08, with upstream `master` at [`411429e`](https://github.com/porsager/postgres/commit/411429e7bd7a3d61155ca9a70a97c111823702ea). The issue reports and related pull requests below remain open upstream. These links identify matching reported failures; they do not imply upstream has merged or endorsed this fork's implementation. The test references describe coverage in this release baseline, not a fresh execution of every upstream reproduction.

| Included behavior | Upstream reports | Evidence in this fork |
| --- | --- | --- |
| Cold reservations work with `fetch_types: false` | [#751](https://github.com/porsager/postgres/issues/751), reservation portion of [#1219](https://github.com/porsager/postgres/issues/1219), [#1203](https://github.com/porsager/postgres/issues/1203) | `cold-reserve-no-fetch`, ownership tests and workerd cold-reservation coverage. Catalog caching/egress optimization with fetching enabled is not included. |
| Queued reservations survive reconnect | [#1195](https://github.com/porsager/postgres/issues/1195) | `ownership:queued-reconnect` and real PostgreSQL backend-termination tests. |
| First-query array types are ready; failed catalog queries do not escape as unhandled rejections | [#789](https://github.com/porsager/postgres/issues/789), [#1192](https://github.com/porsager/postgres/issues/1192), [#1205](https://github.com/porsager/postgres/issues/1205) | `startup:first-types`, `catalog-error-query`, `catalog-error-reserve` and workerd catalog-failure coverage. |
| Failed startup settles and stale backend errors do not leak into the next session | [#1193](https://github.com/porsager/postgres/issues/1193), [#1223](https://github.com/porsager/postgres/issues/1223), [#1226](https://github.com/porsager/postgres/issues/1226) | Startup retry-budget/stale-error cases and real PostgreSQL reconnect coverage. |
| Shutdown settles after disconnect, including inside a transaction | [#1097](https://github.com/porsager/postgres/issues/1097), [#1130](https://github.com/porsager/postgres/issues/1130), [#1242](https://github.com/porsager/postgres/issues/1242) | `phase:fin-inflight`, `phase:rst-inflight`, `lease:begin-end`. |
| Work arriving between socket error and close does not strand the pool | [#1246](https://github.com/porsager/postgres/issues/1246) | `phase:gap-query`. |
| Multi-host timeouts fail over; `prefer-standby` can accept a primary | [#1174](https://github.com/porsager/postgres/issues/1174), [#988](https://github.com/porsager/postgres/issues/988), [#815](https://github.com/porsager/postgres/issues/815) | `phase:all-down`, `failover-timeout`, `prefer-standby-first` and `prefer-standby-last`, plus PostgreSQL session-selection tests. |
| Releasing a terminated reservation keeps the pool usable | [#1199](https://github.com/porsager/postgres/issues/1199) | `lease:reserve-release-close` and `staleReservation()` integration coverage. |
| Statements from a disconnected transaction reject; queued statements settle | [#1248](https://github.com/porsager/postgres/issues/1248), [#1186](https://github.com/porsager/postgres/issues/1186) | `lease:begin-stale`, `begin-queued` and `staleTransaction()` integration coverage. |
| `begin()` reserves ownership despite pipeline limits or write backpressure | [#1210](https://github.com/porsager/postgres/issues/1210), [#1189](https://github.com/porsager/postgres/issues/1189) | `lease:begin-pipeline-zero`, `begin-backpressure` and `ownedTransaction()` integration coverage. |
| Built-in arrays work without catalog discovery | [#1164](https://github.com/porsager/postgres/issues/1164) | Built-in OID mapping, roundtrip, NULL and custom-handler tests in `tests/index.js`. |
| Timers use the Cloudflare-compatible `setTimeout` signature | [#1088](https://github.com/porsager/postgres/issues/1088) | Strict timer shim in the compatibility and workerd suites; local workerd accepts extra arguments, so the restriction is emulated. |

Related upstream proposals include [#1220](https://github.com/porsager/postgres/pull/1220), [#1229](https://github.com/porsager/postgres/pull/1229), [#1230](https://github.com/porsager/postgres/pull/1230), [#1231](https://github.com/porsager/postgres/pull/1231), [#1241](https://github.com/porsager/postgres/pull/1241), [#1240](https://github.com/porsager/postgres/pull/1240), [#1215](https://github.com/porsager/postgres/pull/1215), [#1218](https://github.com/porsager/postgres/pull/1218) and [#1247](https://github.com/porsager/postgres/pull/1247). Matching scope does not mean the patches are identical.

### Compatibility and validation

- The candidate at `f9dbd1d` passed [all ten CI jobs](https://github.com/steadybrew/postgresjs/actions/runs/37812371141): Node 24/26 with PostgreSQL 15/16/17/18, plus separate Deno 1.46.3 and Cloudflare workerd jobs against PostgreSQL 17.
- Regression coverage includes bounded startup/ownership protocol tests, real PostgreSQL integration tests, pending Deno socket tests, and workerd timer, shutdown and TLS scenarios. See [the test guide](tests-startup/README.md) for commands and coverage limits.
- Local package checks passed on Node 26.7.0 with npm 11.19.0: all generated builds matched the checked-in files, lint passed, and the packed tarball installed offline into a clean consumer. ESM and CommonJS imports, client creation/shutdown without a database, and strict TypeScript consumer checks passed.
- Candidate runtime checks passed on Node 24.21.0 / PostgreSQL 17.11 (Linux ARM64) in disposable Docker containers, run by the maintainer on 2026-10-08: regenerated builds, startup/protocol regressions and watchdog self-checks in ESM and CommonJS, and both real PostgreSQL ownership matrices and integration suites. Both test commands exited successfully; the checkout was mounted read-only and test execution used isolated networking.
- Additional Docker validation passed on Node 26.7.0 / PostgreSQL 16.15. The `connect_timeout` timing assertion now accepts a bounded elapsed-time window to avoid rounding failures under CI scheduling.
- The Noise application passed 990 unit tests, typechecking and a production build using the packed candidate, plus 349 integration tests across 28 files on Node 24.21.0 against its isolated PostgreSQL test database. Deployment validation against the published package remains pending.

### Known limitations

- Cloudflare workerd can still emit an unhandled `"Stream was cancelled"` rejection on socket close. The workerd gate tolerates that exact message; this release does not claim to fix upstream [#1196](https://github.com/porsager/postgres/issues/1196) or [#1202](https://github.com/porsager/postgres/issues/1202).
- Bun remains best effort without dedicated CI. Deno 1.46.3 coverage does not establish Deno 2 or hosted Supabase Edge compatibility.
- Startup retries now back off, addressing the tight-loop mechanism in [#1179](https://github.com/porsager/postgres/issues/1179). Pool-wide single-probe throttling and the `reject_throttle` option proposed in [#1180](https://github.com/porsager/postgres/pull/1180) are not implemented; this is not a claim to eliminate every connection storm.
- The stale-handle fix addresses the connection-reuse mechanism behind [#1216](https://github.com/porsager/postgres/issues/1216), but this baseline does not include that report's exact RLS reproduction. The production incident in [#1204](https://github.com/porsager/postgres/issues/1204) is not independently reproduced here.
- The null-socket reports [#1208](https://github.com/porsager/postgres/issues/1208), [#1133](https://github.com/porsager/postgres/issues/1133), [#1154](https://github.com/porsager/postgres/issues/1154) and [#1066](https://github.com/porsager/postgres/issues/1066), and the concurrent-transaction report [#823](https://github.com/porsager/postgres/issues/823), describe related failure paths covered by the ownership changes. Their exact runtime/production scenarios are not all independently reproduced here; in particular, no Bun validation is claimed.
- Catalog discovery caching from [#903](https://github.com/porsager/postgres/issues/903) and the egress portion of [#1219](https://github.com/porsager/postgres/issues/1219) are not implemented. Using `fetch_types: false` avoids discovery for applications that can use built-in or explicitly configured types.

### Release scope

This candidate uses `main` at `260d036` as its runtime code baseline. The later phase-table and lease-state refactors, and uncommitted work on the `lifecycle` branch, are deferred. The startup and ownership fixes already in that baseline remain included.

## v3.4.9 - Steady Brew package baseline

Initial `@steadybrew/postgresjs` package based on upstream Postgres.js 3.4.9. Includes Nikita Glazunov's upstream fix that preserves original query parameters when retrying a prepared query, avoiding double serialization of JSON, booleans and byte buffers. See upstream [411429e](https://github.com/porsager/postgres/commit/411429e7bd7a3d61155ca9a70a97c111823702ea). This is inherited upstream work already included in the Steady Brew 3.4.9 package, not a new 4.0.0 fix.

The entries below are retained from the upstream changelog; they are not a complete history of the intervening upstream releases.

## v3.2.4 - 25 May 2022
- Allow setting keep_alive: false  bee62f3
- Fix support for null in arrays - fixes #371  b04c853

## v3.2.3 - 23 May 2022
- Fix Only use setKeepAlive in Deno if available  28fbbaf
- Fix wrong helper match on multiple occurances  02f3854

#### Typescript related
- Fix Deno assertRejects compatibility (#365)  0f0af92
- Fix include missing boolean type in JSONValue union (#373)  1817387

## v3.2.2 - 15 May 2022
- Properly handle errors thrown on commit  99ddae4

## v3.2.1 - 15 May 2022
- Exclude target_session_attrs from connection obj  43f1442

## v3.2.0 - 15 May 2022
- Add `sslmode=verify-full` support  e67da29
- Add support for array of fragments  342bf55
- Add uri decode of host in url - fixes #346 1adc113
- Add passing of rest url params to connection (ootb support cockroach urls)  41ed84f
- Fix Deno partial writes  452a30d
- Fix `as` dynamic helper  3300c40
- Fix some nested fragments usage  9bfa902
- Fix missing columns on `Result` when using simple protocol - fixes #350  1e2e298
- Fix fragments in transactions - fixes #333  75914c7

#### Typescript related
- Upgrade/fix types (#357)  1e6d312
- Add optional `onlisten` callback to `listen()` on TypeScript (#360)  6b749b2
- Add implicit custom type inference (#361)  28512bf
- Fix and improve sql() helper types (#338)  c1de3d8
- Fix update query type def for `.writable()` and `.readable()` to return promises (#347)  51269ce
- Add bigint to typescript Serializable - fixes #330  f1e41c3

## v3.1.0 - 22 Apr 2022
- Add close method to close but not end connections forever  94fea8f
- Add .values() method to return rows as arrays of values  56873c2
- Support transform.undefined - fixes #314  eab71e5
- Support nested fragments values and dynamics - fixes #326  86445ca
- Fix deno close sequence  f76af24
- Fix subscribe reconnect and add onsubscribe method - fixes #315  5097345
- Deno ts fix - fixes #327  50403a1

## v3.0.6 - 19 Apr 2022
- Properly close connections in Deno  cbc6a75
- Only write end message if socket is open  13950af
- Improve query cancellation  01c2c68
- Use monotonically increasing time for timeout - fixes #316  9d7a21d
- Add support for dynamic columns with `returning` - fixes #317  04644c0
- Fix type errors in TypeScript deno projects (#313)  822fb21
- Execute forEach instantly  44e9fbe

## v3.0.5 - 6 Apr 2022
- Fix transaction execution timing  28bb0b3
- Add optional onlisten function to listen  1dc2fd2
- Fix dynamic in helper after insert #305  4d63a59

## v3.0.4 - 5 Apr 2022
- Ensure drain only dequeues if ready - fixes #303  2e5f017

## v3.0.3 - 4 Apr 2022
- Run tests with github actions  b536d0d
- Add custom socket option - fixes #284  5413f0c
- Fix sql function overload type inference (#294)  3c4e90a
- Update deno std to 0.132 and enable last tests  50762d4
- Send proper client-encoding - Fixes #288  e5b8554

## v3.0.2 - 31 Mar 2022
- Fix BigInt handling  36a70df
- Fix unsubscribing  (#300)  b6c597f
- Parse update properly with identity full - Fixes #296  3ed11e7

## v3.0.1 - 30 Mar 2022
 - Improve connection queue handling + fix leak cee1a57
 - Use publications option - fixes #295 b5ceecc
 - Throw proper query error if destroyed e148a0a
 - Transaction rejects with rethrown error - fixes #289 f7c8ae6
 - Only create origin stacktrace for tagged and debug - fixes #290 a782edf
 - Include types and readme in deno release - fixes #287 9068820
 - Disable fetch_types for Subscribe options 72e0cdb
 - Update TypeScript types with v3 changes (#293) db05836

## v3.0.0 - 24 Mar 2022
This is a complete rewrite to better support all the features that I was trying to get into v2. There are a few breaking changes from v2 beta, which some (myself included) was using in production, so I'm skipping a stable v2 release and going straight to v3.

Here are some of the new things available, but check the updated docs.
- Dynamic query builder based on raw sql
- Realtime subscribe to db changes through logical replication
- Multi-host support for High Availability setups
- Postgres input parameter types from `ParameterDescription`
- Deno support
- Cursors as async iterators
- `.describe()` to only get query input types and column definitions
- Support for Large Objects
- `max_lifetime` for connections
- Cancellation of requests
- Converted to ESM (with CJS support)
- Typescript support (Credit @minigugus)

### Breaking changes from v2 -> v3
- Cursors are always called with `Result` arrays (previously cursor 1 would return a row object, where > 1 would return an array of rows)
- `.writable()` and `.readable()` is now async (returns a Promise that resolves to the stream)
- Queries now returns a lazy promise instead of being executed immediately. This means the query won't be sent until awaited (.then, .catch, .finally is called) or until `.execute()` is manually called.
- `.stream()` is renamed to `.forEach`
- Returned results are now it's own `Result` class extending `Array` instead of an Array with extra properties (actually shouldn't be breaking unless you're doing something funny)
- Parameters are now cast using the types returned from Postgres ParameterDescription with a fallback to the previously inferred types
- Only tested with node v12 and up
- Implicit array value to multiple parameter expansion removed (use sql([...]) instead)

### Breaking changes from v1 -> v2 (v2 never moved on from beta)
- All identifiers from `sql()` in queries are now always quoted
- Undefined parameters are no longer allowed
- Rename timeout option to `idle_timeout`
- Default to 10 connections instead of number of CPUs
- Numbers that cannot be safely cast to JS Number are returned as string. This happens for eg, `select count(*)` because `count()` returns a 64 bit integer (int8), so if you know your `count()` won't be too big for a js number just cast in your query to int4 like `select count(*)::int`

## v1.0.2 - 21 Jan 2020

- Fix standard postgres user env var (#20)  cce5ad7
- Ensure url or options is not falsy  bc549b0
- Add support for dynamic password  b2ab9fb
- Fix hiding pass from options  3f76b98


## v1.0.1 - 3 Jan 2020

- Fix #3 url without db and trailing slash  45d4233
- Fix stream promise - resolve with correct result  730df2c
- Fix return value of unsafe query with multiple statements  748f198
- Fix destroy before connected  f682ca1
- Fix params usage for file() call without options  e4f12a4
- Various Performance improvements

## v1.0.0 - 22 Dec 2019

- Initial release

# Connection and lease lifecycle

This is the contract that `src/connection.js` (one connection), `src/index.js` (the pool and leases) and `tests-startup/invariants.js` (the legal states, checked in tests) implement together. It describes what each part guarantees and why. For how a phase handles a particular event, read the phase table `on` in `src/connection.js`: each row lists everything one phase does. If this document and the code disagree, the code is right and this document needs fixing.

The generated copies in `cjs/`, `deno/` and `cf/` follow `src/` and are not described separately.

## Phases

A connection is always in exactly one phase. Only `transition()` changes the phase, and every transition also increments `generation`, which is how late asynchronous results from an earlier phase are recognised and dropped (see [Stale events](#stale-events)).

| Phase | Meaning | Socket | Pool queues | Can be owned |
|---|---|---|---|---|
| Closed | No session and no acquisition in progress. Every connection starts here. | none | `closed` | no |
| Backoff | An acquisition is waiting before its next attempt: 0 ms before the next host, the backoff delay between rounds, or the remainder of a delay inherited from the previous session. | none | `connecting`, or `ended` if `end()` was requested | no |
| Connecting | One attempt on one host: socket creation, SSL negotiation or direct TLS, StartupMessage and authentication, up to the first ReadyForQuery. | being created, then open | `connecting`, `ended` | no |
| Initializing | The server has accepted the session. Internal startup queries run (session state for `target_session_attrs`, array type discovery for `fetch_types`) before hand-off. | open | `connecting`, `ended` | no |
| Ready | The session is usable and accepts queries. | open | unowned: `open`, `busy`, `full`; owned: `reserved`, `full` | yes |
| Draining | `end()` was requested; in-flight and owned work finishes, then the connection closes. | open | unowned: `ended`; owned: `reserved`, `full` | yes |
| Closing | Terminate was sent and the connection waits for the server to close the socket. It is entered only when the connection is idle and unowned. | closing | `ended` | no |

Legal transitions. They are enforced by the `edges` table in `tests-startup/invariants.js`; `src/` reports every edge to the test hook but does not check it.

| From | To |
|---|---|
| Closed | Backoff, Connecting |
| Backoff | Connecting, Closed |
| Connecting | Initializing, Backoff, Closed |
| Initializing | Ready, Backoff, Closed |
| Ready | Draining, Closing, Closed |
| Draining | Closing, Closed |
| Closing | Closed |

There is no Connecting → Connecting edge. Moving to the next host or retrying always goes through Backoff, with a delay of 0 between hosts. Closed is entered only through `enterClosed()`.

The difference between Connecting and Initializing matters in two places:

- A FATAL error that arrives with no query in flight means the server refused the session in Connecting (cause `rejected`). In Initializing it means an accepted session was dropped (cause `dropped`), which a single-host acquisition retries. See the table under [Acquisition](#acquisition).
- Only internal startup queries may run in Initializing. User queries are refused with `CONNECTION_CLOSED` until hand-off.

## Events

Everything that can change a connection's state arrives as an event through `dispatch(event, arg)`, which looks up `on[phase][event]`. This includes the public methods, socket listeners, timers, the socket factory, authentication, ReadyForQuery and ErrorResponse. No code outside `transition()` and `dispatch()` reads the phase.

| Event | Source |
|---|---|
| `acquire` | the pool's `connect(c, request)` |
| `execute` | `connection.execute(q)`: pool, lease and internal queries |
| `end` | `connection.end()`: pool `end()`/`close()`, the idle timer, the lifetime timer |
| `terminate` | `connection.terminate()`: forced shutdown, a discarded lease, hand-out expiry |
| `release` | `connection.release()`: a released lease |
| `backoffElapsed`, `deadline`, `attemptTimeout`, `closeTimeout` | the acquisition and close timers |
| `socketCreated`, `factoryFailed` | the socket factory (or `new net.Socket()`) resolving or throwing |
| `socketReady`, `sslReply`, `secure` | socket `connect`, the one-byte SSL answer, TLS `secureConnect` |
| `socketError`, `socketClose`, `writable` | socket `error`, `close`, `drain` |
| `authFailed` | an authentication step rejecting, or a SASL server signature mismatch |
| `serverError` | ErrorResponse with no query in flight (a FATAL the server sends before closing) |
| `protocolError` | an exception while handling a backend message |
| `ready` | ReadyForQuery |
| `initFailed` | ReadyForQuery that ends an internal startup query with an error |

An event with no entry for the current phase is ignored in production and reported as `unhandled` by the test hook. So every missing pair should be one that cannot happen in that phase, and a test that hits one fails.

## Acquisition

An acquisition starts when the pool hands a Closed connection a request (a query or a reservation) and ends at hand-off or in Closed. It owns three timers:

| Timer | Armed | Bound |
|---|---|---|
| attempt | each attempt, only with several hosts | `connect_timeout` per attempt; on expiry the next host is tried |
| deadline | once per acquisition, at the first attempt | `connect_timeout` × number of hosts; on expiry the acquisition fails with the last attempt's error, or `CONNECT_TIMEOUT` if there was none |
| backoff | each Backoff | the delay for that wait |

Time spent waiting out an inherited delay is not counted against the deadline. With `connect_timeout: 0` neither the attempt nor the deadline timer is armed.

Every failed attempt goes through `afterFailure(err, cause)`, which decides whether to try again:

| Cause | Meaning |
|---|---|
| `socket` | the socket emitted an error during the attempt |
| `factory` | the socket factory threw, or resolved to something that is not a socket |
| `protocol` | SSL negotiation, the TLS upgrade, writing the StartupMessage or handling a message failed |
| `timeout` | the attempt timer fired; the earlier error, if any, is kept as the reported one |
| `rejected` | the server sent a FATAL before accepting the session |
| `dropped` | the socket closed during the attempt, or the server sent a FATAL after accepting the session |
| `mismatch` | the host did not satisfy `target_session_attrs` |

Retry policy:

- **Between hosts:** after each failed attempt the next host is tried at once.
- **After a full round:** once every host has failed, the round counts as one retry and the next round starts after the backoff delay.
- **Single host:** the acquisition fails after one round with that attempt's error. The exceptions are `dropped` and `mismatch`, which retry with backoff until the deadline: a session closing during startup is usually a restart or failover in progress, and a single endpoint that is read-only is often a cluster DNS name still pointing at the demoted primary. When the deadline passes after a mismatch, the acquisition fails with `CONNECTION_CLOSED` whose `cause` is a `TARGET_SESSION_ATTRS` error.
- **No host matches `target_session_attrs`:** with several hosts, when every host in a round answered but none matched, the acquisition fails at once with `CONNECTION_CLOSED` whose `cause` is a `TARGET_SESSION_ATTRS` error naming each host and why it did not match. If any host failed for another reason, the acquisition keeps retrying until the deadline instead.
- **`prefer-standby`:** a round first tries every host for a standby, then every host for any server, with no delay between the two passes. After a backoff the standby pass starts again, as in libpq.
- **Authentication and startup queries:** an authentication failure (`authFailed`) or an error in an internal startup query (`initFailed`) closes the connection without retrying.

The backoff delay is `backoff(retries)` seconds; by default `(0.5..1) × min(3^retries / 100, 20)`. `retries` is shared by all connections in a pool, and a successful hand-off resets it to 0.

### Inherited backoff

When a session is lost (a socket error, the peer closing the socket, or a FATAL with no query in flight), when a single-host acquisition fails, or when none of several hosts matches `target_session_attrs`, the connection records the backoff delay at that moment. The next acquisition of that connection waits out whatever is left of it in Backoff. A planned close is not paced: a Closing connection whose socket closes cleanly, or whose close timer fires, leaves no delay. So `end()`, `idle_timeout` and `max_lifetime` never slow down the next acquisition.

### `end()` during an acquisition

- **Reservation request:** the reservation rejects with `CONNECTION_ENDED` and the connection closes.
- **In Backoff after a failed attempt:** the acquisition stops and the request rejects with that attempt's error.
- **Otherwise:** the acquisition is marked as ending and the connection is filed in `ended`. If the attempt still succeeds, the request runs and the connection drains and closes. If it fails, the request rejects with the attempt's error and no retry is made.

## Teardown

Three functions tear a connection down, each with a different scope:

| Function | Does | Leaves to others |
|---|---|---|
| `endSession(err)` | Stops the session: cancels the lifetime, close and write timers; clears the protocol buffers; removes every socket listener, destroys the socket and drops it; ends a COPY stream with `err`; rejects the current query and every pipelined one with `err`. | The phase, the acquisition and its timers, end waiters, the pool |
| `enterClosed(err)` | The only way into Closed: clears the acquisition timers, calls `endSession(err)`, rejects the acquisition's request with `err`, resolves `end()` waiters and calls the pool's `onclose`. With no `err` given it uses `CONNECTION_CLOSED`. | The idle timer and lease settlement, which are the pool's |
| `closing()` | The graceful path: moves to Closing, sends Terminate and arms the close timer for `connect_timeout` seconds. If the server never closes the socket, the timer closes the connection as a clean close would. With `connect_timeout: 0` the close is unbounded. | Cleanup, which happens when the resulting `socketClose` or `closeTimeout` calls `enterClosed()` |

A failed attempt that will be retried calls `endSession` and moves to Backoff, keeping the acquisition. An attempt that gives up calls `enterClosed` directly, so nothing is torn down twice.

Which error in-flight work receives:

- **The server ended the session with a FATAL** (e.g. 57P01 from `pg_terminate_backend` or a failover): `CONNECTION_CLOSED`, with that `PostgresError` as its `cause`.
- **A socket error** (e.g. ECONNRESET): that error, as upstream does.
- **The peer closed the socket without either:** `CONNECTION_CLOSED`.

A reserved handle or transaction whose connection is lost this way rejects with `CONNECTION_CLOSED`, with the FATAL or socket error as its `cause`. The code stays `CONNECTION_CLOSED` because applications retry on it, as they did with upstream and 4.0.0; the cause adds the reason without changing that contract. A FATAL during startup is different: it fails the acquisition with the server's error, since nothing has run yet.
- **Forced termination** of a connection that is busy or still acquiring: `CONNECTION_DESTROYED`. Terminating an idle open connection closes it with `CONNECTION_CLOSED`, which reaches only the pool's `onclose`.

A protocol error while handling a message on an open session fails only the current query and any COPY stream; the connection stays open.

## Stale events

An asynchronous result can arrive after the phase or attempt that started it is gone. Each source is handled in one of these ways:

- **Generation checks.** The socket factory result, authentication continuations and internal startup queries capture `generation` when they start and are dropped if it has moved. A socket created for a stale attempt is destroyed.
- **Timers.** Acquisition timers are cleared on hand-off and in `enterClosed`, and the attempt timer in `afterFailure`. The lifetime, close and write timers are cleared in `endSession`. None of them is generation-checked.
- **Socket listeners.** `endSession` removes every listener before destroying the socket, so a dead session's socket cannot dispatch events.
- **Socket identity.** The message loop in `data()` stops if handling a message replaced the socket. A suspended cursor's continuation checks that both the query and the socket are still current.
- **The idle timer** belongs to the pool, which starts it when it files a connection in `open` and cancels it on any other move.

## Requests

A request is what the pool routes: a `Query`, or a lease waiting for a connection. A `Query` is also the unit a connection runs. There is no wrapper object, because the tracers read the query itself, so both kinds carry the same fields:

| Field | Query | Lease |
|---|---|---|
| `stage` | set in the constructor | set when the lease is created |
| `resolve`, `reject` | the arrows set in the constructor | from the promise it waits on; no-ops when a connection is handed over at once |
| `reserve` | absent | `true`, the marker that tells a lease from a query |
| `queue` | the lease queue it waits in, if any | its own statement queue |

`Stage`, `step`, `succeed` and `fail` are exported from `src/query.js`. `step` writes the stage unless the request is Settled. `succeed` and `fail` settle a request once: they do nothing for a request that is already Settled, and they look `resolve` and `reject` up when called.

| Stage | A query is | A lease is |
|---|---|---|
| New | built, not routed | created |
| Queued | in the pool queue, or in a lease's queue | in the pool queue |
| Opening | the opener of a connection | the same |
| Sent | admitted by a connection and waiting for its turn | not used |
| Active | the connection's current query | not used |
| Settled | resolved or rejected | handed a connection, or refused |

| From | To | Caused by |
|---|---|---|
| New | Queued | `route()` finds no free connection; a lease statement queues behind a full or non-accepting connection |
| New, Queued | Opening | `connect()` starts an acquisition for it |
| New, Queued, Opening | Sent or Active | the connection admits it (`submit`): Active when nothing is current, Sent otherwise |
| Sent | Active | its turn (`pipelined` calls `activate`) |
| Active | Sent | a stale-plan retry sends it again at the back |
| any but Settled | Settled | `succeed` or `fail` |

`route(r)` decides where a request goes and does not settle it. It takes a connection (an idle one, or for a plain query a closed slot first and then a busy one; for a lease that may use a busy connection, only when no slot is closed), starts an acquisition, or queues the request, and writes the Queued or Opening stage when it does. It returns the connection to use, `null` when the request now waits, or the refusal error (`CONNECTION_ENDED` while the pool is ending, `COPY_IN_PROGRESS` when every connection holds a COPY). `handler()` and `lease()` commit after it returns: they hand the connection over with `assign`, or settle the request with the refusal. That is the contract: **`route` never settles a request**, and nothing in it can execute or activate one, so everything that can settle or activate synchronously runs after it. Anything that withdraws a waiting request, such as an abort or a pool-wait timeout, belongs next to that commit step or in `cancel()`, not in `route`.

`assign(c, r, fresh)` is the one place a pool request gets a connection. `fresh` is true only for the opener of `c` (`onopen`'s `initial`), and the number of requests already on the connection is read before the request is executed. A lease takes its connection and settles through the same call. Lease statements are not pool requests: `send` and the lease's `next` stay its own dispatcher.

**Early settle while holding the slot.** `describe()`, closing a cursor, a protocol error, `UNSAFE_TRANSACTION` and a build failure settle the request before ReadyForQuery. The connection keeps the query as current until ReadyForQuery, which calls `succeed` or `fail` again and does nothing. The abort statement, `retried` and the barrier are untouched.

**COPY.** `deliver(q, stream)` hands out the stream with a direct `q.resolve(stream)`, then calls `owner.next()`. The request stays Active and is settled at its ReadyForQuery or by `endSession`, so `resolve` runs twice for COPY. dd-trace ends a COPY span on the second call, so folding the hand-out into `succeed` would leave every COPY span open.

**Settled requests are still routed.** A query cancelled before it is awaited, or while `file()` reads its file, is routed when it is awaited: `step` leaves the stage Settled, and the connection skips it (`submit` returns early for a cancelled query without an owner and not at `max: 1`) or, at `max: 1` and on leases, writes the refused statement in its place.

**Errors.** `queryError` decorates an error with the query's details and fails the request. It wraps a thrown non-object in an `Error`, which covers a query that fails while being built or sent. Pool-side failures, a cursor callback that throws and the queries rejected after a failed reconnect while ending are raw, and `fail` wraps nothing.

## Leases

`reserve()` and `begin()` take a connection out of the pool through a lease. The lease's state says what the handle is doing now.

| State | The handle is | A statement on it |
|---|---|---|
| Active | in use | Runs, or waits in the lease's queue while the connection is `full` or not accepting; rejects with `COPY_IN_PROGRESS` while the connection's COPY stream is open |
| Closed | in use, but its connection closed | `CONNECTION_CLOSED` |
| Settling | a transaction finishing its COMMIT, ROLLBACK or PREPARE TRANSACTION; only that statement runs | `TRANSACTION_ENDED` |
| Ended | a transaction that is over | `TRANSACTION_ENDED` |
| Released | a reservation that has been released | `CONNECTION_RELEASED` |

A reservation ends at `release()` or dispose. A transaction ends when its callback has finished, even if `begin()` already rejected because the connection closed. Statements still waiting in the lease's queue when it ends reject with its code, and so does a savepoint callback still running when its transaction ended.

`own(c, l)` makes a lease Active before `reserve()` or `begin()` resolve. `finish()` makes an Active transaction lease Settling. When a connection closes, the pool's `onclose` marks an Active lease Closed, records the error, clears the connection's owner, rejects the statements waiting in the lease's queue with `CONNECTION_CLOSED` and tells `begin()`, which rejects with that error: `CONNECTION_CLOSED` with the FATAL or socket error as `cause`, or `CONNECTION_DESTROYED` after a forced `end({ timeout })` with a statement in flight.

Ending a lease goes through `stop(l, state)`, which sets Ended or Released, rejects the statements still waiting in its queue, and returns the connection only if the lease still holds it. The caller then returns the connection to the pool with `c.release()` or closes it with `c.terminate()`:

| Situation | State | Connection |
|---|---|---|
| `sql.release()` or dispose on a reserved handle | Released | returned to the pool |
| `begin()`: COMMIT, ROLLBACK or PREPARE TRANSACTION succeeded | Ended | returned to the pool |
| `begin()`: the server refused BEGIN with a `PostgresError` | Ended | returned to the pool; the session is healthy |
| `begin()`: the settle statement failed | Ended | closed, and the error is rethrown |
| `begin()`: the callback finished in any other way | Ended | closed, so the server rolls back anything open |

A query records its owner when it is sent. `UNSAFE_TRANSACTION` is decided by that owner, so a raw `BEGIN` sent through the pool rejects even if a lease takes the same connection before it completes. A prepared statement is retried after a plan-invalidation error only under the same owner it was sent with.

## Pool

Each connection sits in exactly one pool queue, and the queue it is in must be one its phase and ownership allow (see [Phases](#phases)).

| Situation | Queue |
|---|---|
| Never used, or closed | `closed` |
| Acquisition in progress | `connecting` |
| Acquisition in progress with `end()` requested | `ended` |
| Ready, unowned and idle | `open` |
| Ready, unowned, running queries and able to take more; briefly also a connection that stopped accepting after a retry, until the next query is routed | `busy` |
| Ready, unowned, pipeline full, under write backpressure, or not accepting (see [Admission](#admission)) | `full` |
| Owned, idle or waiting for queued statements | `reserved` |
| Owned, statement in flight | `full`; `reserved` while a COPY is running, once the server has opened its stream |
| Draining or Closing, unowned | `ended` |

**Admission.** Replies are matched to queries by position, so nothing may be written while the server is partway through an exchange. The connection records the one query nothing may be written behind, its barrier: a statement that asks for its parameter types first (one with a value whose type is not known; with `parameter_types: 'client'`, one with an untyped array), a named statement's first run on a connection when it has values (so identical queries pipelined behind it reuse the statement instead of each preparing their own; a first run without values holds nothing, as in Postgres.js, because a round trip on every first run costs more than the duplicate statements a burst of identical queries leaves open until the connection closes; a prepared re-run that hits a stale-plan error is retried only when nothing is held behind it, so with `prepare: true` a re-run with an unrelated first run pipelined behind it rejects instead of retrying, once per statement per connection), a cursor, or a simple query whose text contains the word `copy`, set when it is written and cleared at its ReadyForQuery (and in `endSession`). `connection.accepting` is true when the connection is idle, or has no barrier and room under `max_pipeline`, and `execute()` returns false when the connection stops accepting or the socket needs draining (and true after the COPY guard rejects a statement). The pool reads it: `route()` takes a `busy` connection only if it accepts and files the others in `full`, and a lease sends only to a connection that accepts, otherwise queues the statement and files the connection in `full`. A barrier is always the last query in the line, so it lifts when the connection goes idle, and the existing `onopen` and `owner.next()` calls are the signal that it accepts again. A retry after a plan-invalidation error is made only when no barrier is queued behind the failing statement; otherwise the statement rejects with its plan error.

COPY is recognised from the text because the client cannot know a simple query is a COPY until the server answers. A false positive only stops pipelining behind that query. When the server opens a COPY stream the connection calls `owner.next()`, so statements a lease queued before that are rejected with `COPY_IN_PROGRESS`, as are statements sent while the stream is open. Queries sent through the pool never go to a connection with a COPY in flight. When every connection has an open COPY stream whose writable has not been ended (`connection.copyHeld`), `route()` refuses with `COPY_IN_PROGRESS` instead of queueing, since only that COPY finishing could free a connection; work already queued keeps waiting. `release()` of a handle whose connection is partway through an exchange files it in `full` instead of handing it pool queries; the next ReadyForQuery picks it up.

The connection drives its own queue through four callbacks:

| Callback | When | The pool |
|---|---|---|
| `onopen(c, request, draining)` | hand-off; a ReadyForQuery with nothing pipelined and no owner; a released lease; socket `drain` | hands `c` to a waiting reservation, files it in `open`, or runs the request and up to its share of queued queries and files it `busy` or `full`. With `draining` set, the request is the opener of a connection that was told to end while opening: it is handed over fresh and nothing else happens, so the connection is not moved and takes no queued queries |
| `onend(c)` | the connection starts ending | files it in `ended` |
| `ondrain(c)` | a Draining connection has gone idle | if the pool is ending, runs queued plain queries on it (rejecting queued reservations with `CONNECTION_ENDED`) and keeps it Draining; otherwise lets it close |
| `onclose(c, err)` | `enterClosed` | files it in `closed`, marks its lease Closed, and either starts the next queued request on it or, while ending, handles the queue as described below |

**User callbacks.** Filing a connection in `open` starts its idle timer and calls the user's `onidle(c.id)`. The internal listen and subscribe pools do not inherit `onidle`. These user callbacks (`onidle`, `onclose`, `onnotice`, `onparameter`, `onnotify`, `debug`, and the `sql.listen()` and `sql.subscribe()` callbacks and `onlisten`, `onsubscribe` and `onerror`) go through the `callback` helper in `src/errors.js`, which calls them synchronously and rethrows anything they throw in a microtask, so a user error cannot reach the phase table. A transform or type parser that throws while `src/subscribe.js` decodes a change is caught there: the change is skipped and the error goes to the matching subscribers' `onerror`, so it does not reach `protocolError`, unless the change's relation is unknown or the message is not an insert, update or delete, in which case the stream restarts as before. The error is rethrown as an uncaught exception when a matching subscription has no `onerror`.

**Hand-out expiry.** An idle connection leaves `open` only through `takeOpen()`. Before handing one out, it checks `idle_timeout` and `max_lifetime` against wall-clock due times (`Date.now()`). Any connection past either limit is terminated and the next one is tried. The check exists because timers cannot fire while a serverless instance is frozen, so on thaw an expired connection, often with a dead socket, could otherwise be handed out first. Terminating, rather than closing gracefully, frees the slot at once instead of holding it until the server answers Terminate.

**Ending the pool.**

- **`end()`:** stops new work (`CONNECTION_ENDED` for anything submitted later) and ends every connection.
  - Queries accepted before the call still run. Plain queries waiting in the pool are taken by draining connections.
  - If the last connection is lost while queries are still waiting, the pool reconnects once to run them, and `end()` waits for that. If the reconnect fails, the waiting queries reject with its error.
  - Waiting reservations reject with `CONNECTION_ENDED`.
- **`end({ timeout })`:** at the timeout, rejects everything still queued with `CONNECTION_DESTROYED` and terminates every connection.
- **`close()`:** ends the connections without stopping new work.

**Cancel.**

- **Stages:** a cancel before the query is sent settles it (`fail`, stage Settled) whatever its stage was; a Sent query is only marked and keeps its stage until its own response; the current query is Active until its response.
- **A query not yet written:** rejected with 57014 at once. If it belongs to a lease, or the pool has `max: 1`, it stays in its queue, and when it reaches the connection the connection writes the refused statement from a failed build in its place, so an open transaction fails. Otherwise it is removed from the pool queue, or skipped if it reaches a connection.
- **A query pipelined behind another:** marked, and its CancelRequest is sent once it becomes the current query. It is settled by its own response.
- **The current query:** the CancelRequest is sent at once.

`Query.cancel()` returns a promise that settles when the CancelRequest finishes. A CancelRequest opens its own socket and is not a connection; it does not go through any phase or pool queue.

## Test hook

`globalThis[Symbol.for('postgres.js:check')]` is read once when a connection is created. When it is unset, each reporting site costs one falsy check. When it is set, the connection calls `check(kind, connection, a, b)`:

| Kind | Reported | Checked by `tests-startup/invariants.js` |
|---|---|---|
| `created` | each new connection | records the connection for a final check |
| `edge` | every transition | the edge is in `edges` |
| `unhandled` | `dispatch` found no entry | always a violation |
| `settled` | after each outermost `dispatch` | the connection's queue is one its phase and owner allow |

`src/query.js` and `src/index.js` read the hook once when they load and report requests with the request as the second argument:

| Kind | Reported | Checked by `tests-startup/invariants.js` |
|---|---|---|
| `routed` | a query starts being handled, or a lease is created | records an unsettled request for a final check; a scenario fails if one never settles |
| `step` | a request changes stage | the edge is one of the request edges above |
| `requestSettled` | `succeed` or `fail` settles a request | the stage it settles from allows Settled |
| `handover` | `assign` gives a request a connection, with whether it was fresh and how many requests were already on the connection | a request is handed over once, and fresh exactly when it was Opening |

The checker keeps the hand-overs in `handovers` for scenarios that assert them.

With the hook set, `connection[Symbol.for('postgres.js:phase')]` returns the phase name. Every scenario in `tests-startup` installs the hook and fails if any violation was recorded.

## Kinds of tests

A test is only evidence for the claim it makes, so each test should fit one of these kinds:

- **Bug tests** reproduce a specific defect. They fail on the upstream source the fork started from (porsager/postgres 411429e7) for the reason they name, and pass here. Commits that claim an upstream issue (`porsager/postgres#N`) should point to one.
- **Contract tests** pin behaviour where the fork deliberately differs from upstream, such as error codes or retry counts. They are not evidence of an upstream bug.
- **Defensive tests** inject a failure, for example an error emitted on a destroyed socket, that no real socket has been shown to produce.
- **Refactor guards** check only fork-internal state: the invariant hook, the phase getter, and timers left behind after a connection closes.

To check a test against upstream, copy the tree, replace `src/` with `git show 411429e7:src/<file>` for each file, and run the same harness. The fake peer in `tests-startup/peer.js` speaks the simple-query protocol, and answers extended-query exchanges with empty results while recording the types each Parse declares, the statement names and the Bind values, and filling in described types when a scenario asks for them. Cloudflare stub cases (`cf:*`) only show behaviour against the in-repo stub; `npm run test:workerd` is the evidence for real workerd.

## Open questions

1. `cancelRequest` always dials the first host and port, which is wrong after a multi-host failover has moved the session to another host.
2. `onopen` takes a share of queued queries as `ceil(queries / (connecting + 1))` while the handed-off connection is still counted in `connecting`, so it counts itself twice. The formula comes from upstream.
3. A function-valued `idle_timeout` or `max_lifetime` is evaluated once per connection, not once per session.
4. A query cancelled before it is awaited is still routed when it is awaited. With several connections it can open a closed slot for nothing or be skipped by `submit`, and at `max: 1` it writes the refused statement.
5. `go()` files an idle connection `busy` after `submit` skipped a cancelled query, so a connection with nothing on it counts as busy until the next query.
6. `cancel()` on a `for await` cursor after the loop ended returns a promise that never settles, because the cursor arrows never set `settled` and the query is no longer in any line.
7. `sql.end({ timeout: 0 })` can resolve before the listen pool's own destroy timer has fired, so the listen pool's re-listen query settles after `end()` returned.

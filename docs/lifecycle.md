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
- **Single host:** the acquisition fails after one round with that attempt's error. The exception is `dropped`, which retries with backoff until the deadline, because a session closing during startup is usually a restart or failover in progress.
- **No host matches `target_session_attrs`:** when every host in a round answered but none matched, the acquisition fails at once with `TARGET_SESSION_ATTRS`, naming each host and why it did not match. If any host failed for another reason, the acquisition keeps retrying until the deadline instead.
- **`prefer-standby`:** a round first tries every host for a standby, then every host for any server, with no delay between the two passes. After a backoff the standby pass starts again, as in libpq.
- **Authentication and startup queries:** an authentication failure (`authFailed`) or an error in an internal startup query (`initFailed`) closes the connection without retrying.

The backoff delay is `backoff(retries)` seconds; by default `(0.5..1) × min(3^retries / 100, 20)`. `retries` is shared by all connections in a pool, and a successful hand-off resets it to 0.

### Inherited backoff

When a session is lost (a socket error, the peer closing the socket, or a FATAL with no query in flight), when a single-host acquisition fails, or when no host matches `target_session_attrs`, the connection records the backoff delay at that moment. The next acquisition of that connection waits out whatever is left of it in Backoff. A planned close is not paced: a Closing connection whose socket closes cleanly, or whose close timer fires, leaves no delay. So `end()`, `idle_timeout` and `max_lifetime` never slow down the next acquisition.

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

- **The server ended the session with a FATAL** (e.g. 57P01 from `pg_terminate_backend` or a failover): that `PostgresError`.
- **A socket error** (e.g. ECONNRESET): that error.
- **The peer closed the socket without either:** `CONNECTION_CLOSED`.
- **Forced termination** of a connection that is busy or still acquiring: `CONNECTION_DESTROYED`. Terminating an idle open connection closes it with `CONNECTION_CLOSED`, which reaches only the pool's `onclose`.

A protocol error while handling a message on an open session fails only the current query and any COPY stream; the connection stays open.

## Stale events

An asynchronous result can arrive after the phase or attempt that started it is gone. Each source is handled in one of these ways:

- **Generation checks.** The socket factory result, authentication continuations and internal startup queries capture `generation` when they start and are dropped if it has moved. A socket created for a stale attempt is destroyed.
- **Timers.** Acquisition timers are cleared on hand-off and in `enterClosed`, and the attempt timer in `afterFailure`. The lifetime, close and write timers are cleared in `endSession`. None of them is generation-checked.
- **Socket listeners.** `endSession` removes every listener before destroying the socket, so a dead session's socket cannot dispatch events.
- **Socket identity.** The message loop in `data()` stops if handling a message replaced the socket. A suspended cursor's continuation checks that both the query and the socket are still current.
- **The idle timer** belongs to the pool, which starts it when it files a connection in `open` and cancels it on any other move.

## Leases

`reserve()` and `begin()` take a connection out of the pool through a lease. The lease is the only owner of that connection until it settles.

| State | Entered by | Meaning |
|---|---|---|
| Active | `own(c, l)`, before `reserve()`/`begin()` resolve | The connection is owned; statements run, or wait in the lease's queue under backpressure. |
| Settling | `begin()` sending COMMIT, ROLLBACK or PREPARE TRANSACTION | Only that statement may run. |
| Released | `settle(l, Released)` | Terminal. The connection returns to the pool. |
| Discarded | `settle(l, Discarded)` | Terminal. The connection is terminated, so the server rolls back anything open. |
| Closed | `settle(l, Closed, err)` from the pool's `onclose` | Terminal. The connection is already gone; the lease only records why. |

`settle` does nothing for a lease that is already terminal. Otherwise it clears the connection's owner, rejects every statement still waiting in the lease's queue, and then releases the connection, terminates it, or records the error.

Who decides the outcome:

| Situation | Outcome |
|---|---|
| `sql.release()` on a reserved handle | Released |
| `begin()`: COMMIT, ROLLBACK or PREPARE TRANSACTION succeeded | Released |
| `begin()`: the server refused BEGIN with a `PostgresError` | Released; the connection is healthy |
| `begin()`: the settle statement failed | Discarded, and the error is rethrown |
| `begin()`: any other way out of the callback | Discarded (no effect if the lease is already terminal) |
| The connection closed while owned | Closed; `begin()` rejects with the cause (e.g. ECONNRESET or 57P01) |

What a statement sent on a lease handle gets:

| Lease state | Result |
|---|---|
| Active | Runs, or waits in the lease's queue while the connection is `full` |
| Settling | `CONNECTION_ENDED`, except the settle statement itself |
| Released, Discarded | `CONNECTION_ENDED` |
| Closed | `CONNECTION_CLOSED` |

A query records its owner when it is sent. `UNSAFE_TRANSACTION` is decided by that owner, so a raw `BEGIN` sent through the pool rejects even if a lease takes the same connection before it completes. A prepared statement is retried after a plan-invalidation error only under the same owner it was sent with.

## Pool

Each connection sits in exactly one pool queue, and the queue it is in must be one its phase and ownership allow (see [Phases](#phases)).

| Situation | Queue |
|---|---|
| Never used, or closed | `closed` |
| Acquisition in progress | `connecting` |
| Acquisition in progress with `end()` requested | `ended` |
| Ready, unowned and idle | `open` |
| Ready, unowned, running queries and able to take more | `busy` |
| Ready, unowned, pipeline full or under write backpressure | `full` |
| Owned, idle or waiting for queued statements | `reserved` |
| Owned, statement in flight | `full` |
| Draining or Closing, unowned | `ended` |

The connection drives its own queue through four callbacks:

| Callback | When | The pool |
|---|---|---|
| `onopen(c, request)` | hand-off; a ReadyForQuery with nothing pipelined and no owner; a released lease; socket `drain` | hands `c` to a waiting reservation, files it in `open`, or runs the request and up to its share of queued queries and files it `busy` or `full` |
| `onend(c)` | the connection starts ending | files it in `ended` |
| `ondrain(c)` | a Draining connection has gone idle | if the pool is ending, runs queued plain queries on it (rejecting queued reservations with `CONNECTION_ENDED`) and keeps it Draining; otherwise lets it close |
| `onclose(c, err)` | `enterClosed` | files it in `closed`, settles its lease as Closed, and either starts the next queued request on it or, while ending, handles the queue as described below |

**Hand-out expiry.** An idle connection leaves `open` only through `takeOpen()`. Before handing one out, it checks `idle_timeout` and `max_lifetime` against wall-clock due times (`Date.now()`). Any connection past either limit is terminated and the next one is tried. The check exists because timers cannot fire while a serverless instance is frozen, so on thaw an expired connection, often with a dead socket, could otherwise be handed out first. Terminating, rather than closing gracefully, frees the slot at once instead of holding it until the server answers Terminate.

**Ending the pool.**

- **`end()`:** stops new work (`CONNECTION_ENDED` for anything submitted later) and ends every connection.
  - Queries accepted before the call still run. Plain queries waiting in the pool are taken by draining connections.
  - If the last connection is lost while queries are still waiting, the pool reconnects once to run them, and `end()` waits for that. If the reconnect fails, the waiting queries reject with its error.
  - Waiting reservations reject with `CONNECTION_ENDED`.
- **`end({ timeout })`:** at the timeout, rejects everything still queued with `CONNECTION_DESTROYED` and terminates every connection.
- **`close()`:** ends the connections without stopping new work.

**Cancel.**

- **A query still waiting in the pool:** removed and rejected with 57014.
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

With the hook set, `connection[Symbol.for('postgres.js:phase')]` returns the phase name. Every scenario in `tests-startup` installs the hook and fails if any violation was recorded.

## Kinds of tests

A test is only evidence for the claim it makes, so each test should fit one of these kinds:

- **Bug tests** reproduce a specific defect. They fail on the upstream source the fork started from (porsager/postgres 411429e7) for the reason they name, and pass here. Commits that claim an upstream issue (`porsager/postgres#N`) should point to one.
- **Contract tests** pin behaviour where the fork deliberately differs from upstream, such as error codes or retry counts. They are not evidence of an upstream bug.
- **Defensive tests** inject a failure, for example an error emitted on a destroyed socket, that no real socket has been shown to produce.
- **Refactor guards** check only fork-internal state: the invariant hook, the phase getter, and timers left behind after a connection closes.

To check a test against upstream, copy the tree, replace `src/` with `git show 411429e7:src/<file>` for each file, and run the same harness. The fake peer in `tests-startup/peer.js` only speaks the simple-query protocol with empty catalog results. Cloudflare stub cases (`cf:*`) only show behaviour against the in-repo stub; `npm run test:workerd` is the evidence for real workerd.

## Open questions

1. `cancelRequest` always dials the first host and port, which is wrong after a multi-host failover has moved the session to another host.
2. `onopen` takes a share of queued queries as `ceil(queries / (connecting + 1))` while the handed-off connection is still counted in `connecting`, so it counts itself twice. The formula comes from upstream.
3. A function-valued `idle_timeout` or `max_lifetime` is evaluated once per connection, not once per session.

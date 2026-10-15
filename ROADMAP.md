# Roadmap

What this fork is working on, in order. Each item names the [porsager/postgres](https://github.com/porsager/postgres/issues) issues it answers and how many reactions they have, and links to its issue here, where the design and progress are discussed. The same items are on the [Roadmap project](https://github.com/orgs/steadybrew/projects/1). Comments and reactions on those issues help decide the order.

## Shipped

Releases are in the [changelog](CHANGELOG.md); the upstream bugs they fix are listed in the [README](README.md#fixed-postgresjs-issues).

- **One round trip for queries with values:** `parameter_types: 'client'`, opt-in, with `'warn'` to check a workload first (4.5.0-rc1, on npm `next`). Answers [#1225](https://github.com/porsager/postgres/issues/1225), and with it JSON strings and booleans store what was sent ([#1139](https://github.com/porsager/postgres/issues/1139), [#858](https://github.com/porsager/postgres/issues/858)). Becomes the default in 5.0 ([steadybrew#41](https://github.com/steadybrew/postgresjs/issues/41)).
- **`await using`** for the pool and reserved connections (4.5.0-rc1). Answers [#886](https://github.com/porsager/postgres/issues/886) (9 reactions) and [#1094](https://github.com/porsager/postgres/issues/1094).
- **Pool statistics:** `sql.stats()` (4.3.0). Answers [#443](https://github.com/porsager/postgres/issues/443) and [#908](https://github.com/porsager/postgres/issues/908).
- **Vercel Fluid:** the `onidle` callback and the `@steadybrew/postgresjs/vercel` adapter (4.2.0). Answers [#1100](https://github.com/porsager/postgres/issues/1100).
- **Correctness:** queries no longer receive another query's rows ([#1082](https://github.com/porsager/postgres/issues/1082), 4.3.0), `sql.begin()` no longer reports a rolled-back commit as committed ([#1217](https://github.com/porsager/postgres/issues/1217), 4.4.0), and a cached-plan error inside a transaction no longer leaves it aborted ([#1234](https://github.com/porsager/postgres/issues/1234), 4.4.0).

## Next: serverless reliability and visibility

- **Driver events through `diagnostics_channel`:** connect, query, pool wait and close, published only when something subscribes. The items below are measured with them.
- **OpenTelemetry tracing and metrics,** built on those events. Answers [#461](https://github.com/porsager/postgres/issues/461) (40 reactions).
- **Query timeout** for sockets that died silently ([steadybrew#9](https://github.com/steadybrew/postgresjs/issues/9)). Answers [#1089](https://github.com/porsager/postgres/issues/1089), [#513](https://github.com/porsager/postgres/issues/513) and [#394](https://github.com/porsager/postgres/issues/394).
- **AbortSignal and a timeout for waiting on the pool** in `sql.reserve()` and `sql.begin()` ([steadybrew#10](https://github.com/steadybrew/postgresjs/issues/10)). Answers [#824](https://github.com/porsager/postgres/issues/824) and [#1036](https://github.com/porsager/postgres/issues/1036), and turns the [#893](https://github.com/porsager/postgres/issues/893) hang into an error.
- **Idle connections no longer keep the process alive.** Answers [#869](https://github.com/porsager/postgres/issues/869) (10 reactions) and [#918](https://github.com/porsager/postgres/issues/918).
- **No `cloudflare:` build errors in Next.js and other bundlers.** Answers [#810](https://github.com/porsager/postgres/issues/810), [#822](https://github.com/porsager/postgres/issues/822), [#781](https://github.com/porsager/postgres/issues/781) and [#930](https://github.com/porsager/postgres/issues/930) (55 reactions together).
- **Connection retry backoff resets after a quiet period** ([steadybrew#11](https://github.com/steadybrew/postgresjs/issues/11)).
- **Documented serverless and pooler settings,** with measured numbers ([steadybrew#12](https://github.com/steadybrew/postgresjs/issues/12)).

## Later

- **Transaction-mode poolers:** hangs and swapped results through Supavisor and PgBouncer. Answers [#970](https://github.com/porsager/postgres/issues/970), [#1033](https://github.com/porsager/postgres/issues/1033) and [#827](https://github.com/porsager/postgres/issues/827).
- **Pool dispatch:** a long query no longer holds up the queries queued behind it ([steadybrew#18](https://github.com/steadybrew/postgresjs/issues/18)).
- **Cloudflare Workers:** no unhandled rejection on socket close, `sql.subscribe()` and COPY TO on Workers, the real TLS error instead of a timeout, and Hyperdrive prepared statements ([steadybrew#1](https://github.com/steadybrew/postgresjs/issues/1), [steadybrew#15](https://github.com/steadybrew/postgresjs/issues/15)). Answers [#1196](https://github.com/porsager/postgres/issues/1196), [#1202](https://github.com/porsager/postgres/issues/1202), [#975](https://github.com/porsager/postgres/issues/975), [#1213](https://github.com/porsager/postgres/issues/1213) and [#960](https://github.com/porsager/postgres/issues/960).
- **Faster cold starts:** types fetched once per pool, not per connection ([steadybrew#7](https://github.com/steadybrew/postgresjs/issues/7)). Answers [#903](https://github.com/porsager/postgres/issues/903) and [#952](https://github.com/porsager/postgres/issues/952).
- **Correct results after a failed query:** no sparse result arrays, failed COPY and cursor errors settle. Answers [#1181](https://github.com/porsager/postgres/issues/1181), [#1119](https://github.com/porsager/postgres/issues/1119), [#795](https://github.com/porsager/postgres/issues/795), [#1173](https://github.com/porsager/postgres/issues/1173) and [#1166](https://github.com/porsager/postgres/issues/1166).
- **`TransactionSql` types** with a call signature. Answers [#1150](https://github.com/porsager/postgres/issues/1150) (13 reactions) and [#1163](https://github.com/porsager/postgres/issues/1163).
- **Credential rotation** with a username or password that changes per connection. Answers [#881](https://github.com/porsager/postgres/issues/881).

Other upstream reports not fixed yet are tracked in [steadybrew#5](https://github.com/steadybrew/postgresjs/issues/5).

## Not planned for now

- Deno 2 and JSR ([steadybrew#17](https://github.com/steadybrew/postgresjs/issues/17); [#839](https://github.com/porsager/postgres/issues/839)). Deno 1.46 stays tested.
- Node.js versions older than 22.
- `sql.listen()` and `sql.subscribe()` recovery after an outage ([#757](https://github.com/porsager/postgres/issues/757), [#1243](https://github.com/porsager/postgres/issues/1243)).

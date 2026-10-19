<p align="center">
  <img width="440" height="180" alt="Postgres.js" src="postgresjs.svg">
</p>

# Postgres.js by Steady Brew

[![test](https://github.com/steadybrew/postgresjs/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/steadybrew/postgresjs/actions/workflows/test.yml?query=branch%3Amain)

**Keep the [Postgres.js](https://github.com/porsager/postgres) API by [Rasmus Porsager](https://github.com/porsager) and get critical fixes and new features:**

- **Correctness fixes.** Queries get the right results, transactions stay isolated, and rollbacks are reported as failures.
- **Fewer hangs and crashes.** Fixes for stuck queries, shutdown hangs and crashes after disconnects.
- **Pool monitoring.** See busy connections, idle connections and waiting queries with `sql.stats()`.
- **Faster queries behind poolers.** Removes an extra network round trip for supported values (opt-in).
- **Vercel Fluid Compute support.** Reuse connections between requests and close idle ones before suspension to avoid connection leaks.
- **Cloudflare Workers on the cheapest path.** Connects through Cloudflare's own `cloudflare:sockets` API, which costs less CPU per connection than workerd's `node:net`, tested locally and on Cloudflare's network with Neon, Supabase and Hyperdrive.

**[50+ reported upstream bugs fixed](docs/fixed-issues.md)**, with regression tests.

[Start a new project](#start-a-new-project) · [Switch from Postgres.js](#switching-from-postgresjs) · [Why this fork](#why-this-fork) · [API reference](docs/api.md) · [Roadmap](ROADMAP.md)

<a id="install"></a>

## Start a new project

```sh
npm install @steadybrew/postgresjs
```

Or, for Drizzle or Kysely, use the alias:

```sh
npm install postgres@npm:@steadybrew/postgresjs@^4
```

```js
import postgres from '@steadybrew/postgresjs' // or 'postgres' with the alias

const sql = postgres(process.env.DATABASE_URL)

const minAge = 18
const users = await sql`select name, age from users where age >= ${ minAge }`
```

## Switching from Postgres.js

**Check first.** The [migration codemod](codemod/README.md) reports required changes, behaviour differences to review and useful fixes, with file and line. It changes nothing:

```sh
npx @steadybrew/postgresjs-migrate .
```

**Then migrate with Codemod:**

```sh
npx codemod @steadybrew/postgresjs-migrate
```

Run it from your project root. It checks again, switches dependencies and overrides to the fork, and removes patches already covered by the fork. Your source code and imports stay unchanged. Run your package manager's install afterwards to update the lockfile.

<a id="upgrading-to-400"></a>

See the [migration guide](docs/upgrading.md) for behaviour changes, manual installation and the direct npm CLI.

### Drizzle, Kysely and tracing

The alias above works with `drizzle-orm/postgres-js`, `drizzle-kit`, `kysely-postgres-js` and dd-trace. Drizzle's and Kysely's own tests pass on the fork as they do on 3.4.9 ([results](https://github.com/steadybrew/postgresjs-compat/blob/main/results/4.5.1.md)). The codemod sets it up for existing projects, preserving `import postgres from 'postgres'`.

**Sentry needs an extra step:** add the [tracing preload](docs/upgrading.md#tracing) to retain automatic database spans. The codemod flags Sentry but does **not** apply this adjustment.

## Security

Maintained by [Oleg Komarov](https://github.com/okomarov). Since 4.5.0, every version is published from GitHub Actions through npm trusted publishing, with provenance and maintainer approval using two-factor authentication. No stored npm token, runtime dependencies or registry install scripts. Verify with `npm audit signatures`, or under Provenance at the bottom of the [npm page](https://www.npmjs.com/package/@steadybrew/postgresjs).

[Driver changes since Postgres.js 3.4.9](docs/changes-since-3.4.9.diff) · [Report a vulnerability](SECURITY.md) · [Unlicense](UNLICENSE)

## Compatibility

Releases pass the [test matrix](.github/workflows/test.yml) before publishing:

| Runtime | PostgreSQL tested |
| --- | --- |
| Node.js 22, 24 and 26, ESM and CommonJS | 15–18 |
| Deno 1.46.3 | 18 |
| Cloudflare Workers, compatibility dates 2025-01-01 to 2026-10-12, in local workerd and on Cloudflare's network | 18; Neon directly, pooled and through Hyperdrive; Supabase through Hyperdrive |

TypeScript declarations are included; use `@types/node` 22+ or `skipLibCheck`.

Older Node.js versions may work but aren't tested. The package declares `engines.node: >=22`, so package managers may warn or reject installation on older versions.

Hosted Supabase Edge Functions are deployed in production with this fork, outside the CI matrix. Standalone Deno 2 is unverified. Bun is best effort, without CI coverage. On Cloudflare Workers the driver connects through Cloudflare's `cloudflare:sockets` API, which costs less CPU per connection than workerd's `node:net`; the Worker needs Node.js compatibility, which is on by default from compatibility date 2026-08-04 and is otherwise the `nodejs_compat` flag. `sql.end()` closes connections without an unhandled rejection on every compatibility date ([#1196](https://github.com/porsager/postgres/issues/1196), [#1202](https://github.com/porsager/postgres/issues/1202)); on dates before 2026-03-03, a close forced by a timeout still reports one unless the Worker sets the `unhandled_rejection_after_microtask_checkpoint` flag. See [Cloudflare Workers support](docs/api.md#cloudflare-workers-support).

## Why this fork

As many of my deployments are on serverless, I ran into some Postgres.js limitations that made it harder to use it reliably. I moved a couple of projects off it and patched others to compare the pros and cons.

But I also realised that even for a small team of one, there is a clear path to updating and fixing Postgres.js, and I decided to bring those changes, whether from local patches, parked issues or PRs, to the benefit of the wider community.

The aim of this fork is to move faster while keeping rigorous review, automate broader, tedious testing, welcome community contributions, and make a library I enjoy using work better for everyone.

### Fixed Postgres.js issues

- **Transactions keep their own connection.** Fixes connection reuse that could commit another transaction's unfinished writes or let a disconnected handle read another user's rows through RLS. [#1204](https://github.com/porsager/postgres/issues/1204), [#1216](https://github.com/porsager/postgres/issues/1216)
- **Each query gets its own result.** Fixes pipelined queries receiving another query's rows or error, and results with empty slots after a failed query. [#1082](https://github.com/porsager/postgres/issues/1082), [#1252](https://github.com/porsager/postgres/issues/1252), [#1253](https://github.com/porsager/postgres/issues/1253)
- **Rollbacks aren't reported as successful commits.** `sql.begin()` rejects when the server rolls back the commit. [#1217](https://github.com/porsager/postgres/issues/1217)
- **Fewer hangs and crashes.** Fixes reservations and shutdown hanging after disconnects, queries stuck after a slow `COPY` reader, and closed transaction handles crashing the process. [#1195](https://github.com/porsager/postgres/issues/1195), [#1097](https://github.com/porsager/postgres/issues/1097), [#1016](https://github.com/porsager/postgres/pull/1016), [#1208](https://github.com/porsager/postgres/issues/1208)
- **Recover after outages.** Failed connections [wait before retrying](docs/api.md#connection-timeout), avoiding a burst of simultaneous retries. With [multiple hosts](docs/api.md#multi-host-connections---high-availability-ha), the client tries another server and can wait for a writable primary.

[50+ bug fixes and test coverage →](docs/fixed-issues.md)

### Faster queries behind poolers

With `prepare: false`, parameterized queries can pay for an extra network round trip. The opt-in [`parameter_types: 'client'`](docs/api.md#parameter-types) removes it for supported values. In one production app behind the Supabase pooler, median query time fell from **5.3 ms to 3.1 ms** over a day on each mode. Results depend on your workload; p99 was unchanged. Use `'warn'` first to check for serialization differences.

### New features

- **See pool pressure.** [`sql.stats()`](docs/api.md#pool-stats) reports busy and idle connections and waiting queries.
- **Handle serverless suspension.** Expired idle connections are replaced on resume; the [Vercel Fluid Compute adapter](docs/api.md#vercel-fluid-compute) keeps instances alive until idle connections close.
- **Automatic cleanup.** [`await using`](docs/api.md#teardown--cleanup) closes a pool and `using` releases a reserved connection when its scope ends. Requires Node.js 24+ or TypeScript 5.2+.
- **Cloudflare Workers fixes.** On [Workers](docs/api.md#cloudflare-workers-support), `COPY TO` streams and `subscribe()` pause and resume the socket ([#975](https://github.com/porsager/postgres/issues/975)), and `ssl: 'prefer'` falls back to plaintext when the server declines TLS.
- **Arrays without startup discovery.** With [`fetch_types: false`](docs/api.md#auto-fetching-of-array-types), common built-in arrays still parse and serialize without a catalog query.

## Documentation

- [API reference](docs/api.md) — queries, transactions, types, options and errors. Also shipped in the npm package at `docs/api.md` for editors and code assistants.
- [Migration guide](docs/upgrading.md) — switching, behaviour changes and tracing.
- [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

Based on [Postgres.js](https://github.com/porsager/postgres) by [Rasmus Porsager](https://github.com/porsager). Thank you to its creator and everyone contributing fixes and reproductions.

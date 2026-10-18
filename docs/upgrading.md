# Switching from Postgres.js

Check the project first. The report lists, with file and line, what to change before switching, what to review and what is worth knowing; it changes nothing:

```sh
npx @steadybrew/postgresjs-migrate .
```

Then switch. This points every `postgres` dependency at the fork through an npm alias, adds overrides for dependencies that bring their own copy, and removes a `postgres@3.4.9` patch the fork already contains. It doesn't touch your code or lockfile, so run your package manager's install afterwards:

```sh
npx @steadybrew/postgresjs-migrate . --switch
```

The same check and switch run from the [Codemod](https://codemod.com) registry with `npx codemod @steadybrew/postgresjs-migrate`. The tool's [README](../codemod/README.md) has the full list of findings. To switch by hand instead:

```sh
npm install postgres@npm:@steadybrew/postgresjs@^4
```

Either way the fork is installed under the name `postgres`, so `import postgres from 'postgres'` stays as it is, and so do libraries that load `postgres` by name, such as `drizzle-orm/postgres-js`, `drizzle-kit` and `kysely-postgres-js`.

## Tracing

From 4.5.0, dd-trace records the same database spans as with Postgres.js when the fork is installed under the `postgres` name. Sentry's automatic integration instruments `postgres` versions below 4 only, so widen its range before Sentry loads:

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

What changes for code written against Postgres.js 3.4 or `@steadybrew/postgresjs` 3.x. Version 4.0.0 holds the breaking changes; the later items are behaviour changes in 4.x releases.

- **Node.js compatibility.** Tested on Node.js 22, 24 and 26. Older versions may work but aren't tested; the package declares `engines.node: >=22`, so package managers may warn or reject installation on older versions. With TypeScript, the declarations need `@types/node` 22 or newer, or `skipLibCheck`.
- **Handles stay with their owner.** A reserved handle used after `release()`, and a transaction handle used after its transaction finished or while its `COMMIT` is in flight, rejects with `CONNECTION_ENDED`. A handle whose connection closed rejects with `CONNECTION_CLOSED` instead of running on a reconnected session.
- **`sql.prepare(name)`** in a transaction takes a non-empty string without NUL characters; other names throw `INVALID_TRANSACTION_NAME`.
- **`fetch_types: false`** now decodes built-in arrays as JavaScript arrays instead of raw strings. SQL `NULL` elements become `null`; quoted `"NULL"` text remains a string.
- **Callbacks that throw** (`onnotice`, `onparameter`, `onnotify`, `onclose`, `onidle`, `debug`, `backoff`, and the `sql.listen()` and `sql.subscribe()` callbacks) surface as uncaught exceptions, which end the process under Node's default handling. Since 4.4.0.
- **`COPY`** keeps its connection; other queries use another connection or wait. Since 4.4.1, when every connection is held by a `COPY`, queries and reservations reject with `COPY_IN_PROGRESS` instead of hanging. Finish writing or reading your own `COPY` before awaiting another query with `max: 1`. Queries on a reserved or transaction handle still reject during `COPY`.
- **Environment values `false` and `disable` turn options off**, so `PGSSL=disable` means no TLS, where 3.4.9 read it as "require TLS". The same goes for `PGPREPARE`, `PGFETCH_TYPES` and `PGDEBUG`. Since 4.5.0.
- **`target_session_attrs: 'read-write'`** no longer connects to a hot standby, and `'read-only'` accepts one, as in libpq. A mismatch rejects with `CONNECTION_CLOSED` whose `cause` is a `TARGET_SESSION_ATTRS` error naming each host. Since 4.1.0 and 4.5.0.
- **Idle connections past `idle_timeout` or `max_lifetime`** are closed when handed out instead of being used, and a graceful close is bounded by `connect_timeout`. Since 4.1.0.

The [changelog](../CHANGELOG.md) has every change, release by release.

[Back to the README](../README.md)

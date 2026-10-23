# @steadybrew/postgresjs-migrate

Checks a project that uses [Postgres.js](https://github.com/porsager/postgres) 3.x and switches it to [`@steadybrew/postgresjs`](https://github.com/steadybrew/postgresjs).

```sh
npx @steadybrew/postgresjs-migrate .            # report only, changes nothing
npx @steadybrew/postgresjs-migrate . --switch   # report, then switch
```

From the [Codemod](https://codemod.com) registry, run `npx codemod @steadybrew/postgresjs-migrate` in the project's root directory; it runs the same check and switch.

Requires Node.js 18 or newer to run. The fork declares Node.js 22 or newer; older versions may work but aren't tested. The report flags projects that set an older version.

## The report

Every finding has a file and line, grouped by what to do about it:

- **Change before switching:** the project would break or behave differently. Examples: Node.js older than 22 in `engines`, `.nvmrc` or a Dockerfile; a `postgres@3.4.9` patch; a package your code imports that brings its own Postgres.js; `PGSSL=disable`, which 3.4.9 read as "require TLS" and the fork reads as "no TLS".
- **Review:** code whose behaviour changes in a way that may matter. Examples: a reserved handle used after `release()`; `fetch_types: false`, which now decodes arrays; code that checks for `CONNECTION_ENDED`; a CI job on Node.js older than 22.
- **Worth knowing:** changes that need no action, or workarounds the fork makes unnecessary. Examples: `prepare: false` behind a pooler; `Promise.race` timeouts; callbacks that throw, which now surface as uncaught exceptions.

`--json` prints the findings and the facts behind them (clients, ORMs, tracers, lockfiles) instead.

The full list of behaviour changes is in the fork's [migration guide](https://github.com/steadybrew/postgresjs/blob/main/docs/upgrading.md#upgrading-to-4x) and [changelog](https://github.com/steadybrew/postgresjs/blob/main/CHANGELOG.md).

## What `--switch` changes

- Each `package.json` that depends on `postgres` gets `"postgres": "npm:@steadybrew/postgresjs@^4"`. Your imports stay as they are, and so do Drizzle, Kysely and tracers, which all load `postgres` by name. A pnpm `catalog:` reference is switched in `pnpm-workspace.yaml` instead.
- If a production dependency brings its own `postgres`, the alias does not reach it, so the switch also writes `overrides` (npm), pnpm `overrides` or yarn `resolutions`.
- A `postgres@3.4.9` patch whose every change is already in the fork is deleted, with its `patchedDependencies` entry. A patch with any other change stops the switch before anything is written.

It does not change Node.js versions, your code, or your lockfile. Afterwards, run your package manager's install and commit the updated lockfile with the changes.

Tested with npm, pnpm and yarn. Bun lockfiles are read and bun projects get `overrides`, but no bun install is tested.

## Sentry

Sentry's automatic integration only instruments `postgres` 3.x. The report lists Sentry under tracing, and `--switch` reminds you to add a preload; it does not apply the adjustment. The preload is in the fork's [migration guide](https://github.com/steadybrew/postgresjs/blob/main/docs/upgrading.md#tracing).

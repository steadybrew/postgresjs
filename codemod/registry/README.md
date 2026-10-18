# @steadybrew/postgresjs-migrate

Checks a project that uses [Postgres.js](https://github.com/porsager/postgres) 3.x, then switches it to [`@steadybrew/postgresjs`](https://github.com/steadybrew/postgresjs).

```sh
npx codemod @steadybrew/postgresjs-migrate
```

Run it in the project's root directory. It runs [`@steadybrew/postgresjs-migrate`](https://www.npmjs.com/package/@steadybrew/postgresjs-migrate) from npm with `--switch`. Before changing anything, it reports what to change first, what to review and what is worth knowing. If a patch of `postgres` holds changes that aren't in the fork, it stops without changing anything.

To see the report without switching, run `npx @steadybrew/postgresjs-migrate .` instead. The [full README](https://github.com/steadybrew/postgresjs/tree/main/codemod#readme) describes the report and the switch.

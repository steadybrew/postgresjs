# Contributing

Issues and pull requests get a reply within a week. Questions and ideas go to [Discussions](https://github.com/steadybrew/postgresjs/discussions); security issues go through [SECURITY.md](SECURITY.md).

## Reporting a bug

Open an issue with the version, the runtime, the PostgreSQL version, any pooler or platform in between (PgBouncer, Supavisor, Hyperdrive, Vercel, Lambda), and the smallest code that reproduces it. If the bug is already reported on [porsager/postgres](https://github.com/porsager/postgres/issues), link that issue, since many of them apply here too.

Check the [roadmap](ROADMAP.md) and [the list of fixed upstream issues](README.md#fixed-postgresjs-issues) first.

## Pull requests

- Open an issue first for anything larger than a small fix, so the approach is agreed before the work.
- A fix comes with a test that fails without it.
- Commit messages start with `fix:`, `feat:`, `test:`, `docs:`, `ci:`, `perf:`, `refactor:` or `chore:`, and the body explains why. If the change fixes an upstream report, cite it as `porsager/postgres#N` in the commit message.
- `main` has a linear history, so pull requests are merged by fast-forward, not through GitHub's merge buttons.
- Run `npm run lint` before pushing.

## Running the tests

CI skips Markdown-only changes. Client changes run the Node.js, Deno and Cloudflare workerd suites; codemod changes run the separate migration checks. Release tags always run their full test matrix. See [the client workflow](.github/workflows/test.yml) and [codemod workflow](.github/workflows/codemod.yml).

Locally:

- `npm run test:startup` runs the connection protocol suite against a fake server and needs no database.
- `npm run test:esm` and `npm run test:cjs` need the PostgreSQL clusters CI sets up in [.github/actions/setup-postgres](.github/actions/setup-postgres). [tests-startup/README.md](tests-startup/README.md) has a Docker recipe for a disposable setup.
- `npm run test:tracing` compares dd-trace and Sentry spans with Postgres.js 3.4.9 and starts its own PostgreSQL, so it needs the PostgreSQL binaries installed. Run it when a change touches `src/index.js`, `src/query.js` or `src/connection.js`.

## License

Contributions are released under the [Unlicense](UNLICENSE), like the rest of the project.

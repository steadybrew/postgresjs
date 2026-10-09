# Startup regression harness

`node tests-startup/run.js` runs passing protocol controls and verifies the
watchdog itself. Each child runs with strict unhandled rejections, a parent
wall-clock deadline, and an explicit completion message. A zero exit code alone
cannot pass. Children must exit naturally; deadline kills always fail.

`node tests-startup/run.js --startup-failures` (also `--regressions`) runs the
startup/type discovery/reconnect scenarios separately. These cases now pass and
are included in the default suite. `--ownership` isolates acquisition cases.
The scenarios reject uncaught internal-query failures, premature ownership,
stale backend state, unbounded retries, and late socket-factory completion.

Add `--cjs` to either command to test the generated CommonJS library after
`npm run build:cjs`. The fixture and watchdog stay in Node; the existing Deno
suite is the Deno integration gate.

`node tests-startup/run.js --integration` runs the real PostgreSQL acquisition
matrix against the disposable primary cluster (with `--cjs` for CommonJS).
It covers pool sizes 1/3, fetching on/off, prepared/unprepared queries, concurrent
cold acquisitions, backend termination with queued reservations, and two rounds
of exclusive full-capacity acquisition after recovery. Both `test:esm` and
`test:cjs` run this matrix before their existing integration suites.

The peer parses startup and tagged PostgreSQL frames, including split/coalesced
TCP chunks. It implements only the simple-query path and empty catalog results
in the extended-query path. Real PostgreSQL tests remain necessary for type
semantics, authentication, and recovery capacity. It does not emulate PostgreSQL
in general.

## Disposable integration baseline

Build the checked-in recipe from the repository root. Version selectors default
to Node 24.21.0 and PostgreSQL 17.11, both within the existing CI matrix:

```sh
docker build -f tests-startup/Dockerfile \
  --build-arg NODE_VERSION=24.21.0 --build-arg POSTGRES_VERSION=17.11 \
  -t postgresjs-startup-tests .
docker run --rm --network none -v "$PWD:/repo:ro" postgresjs-startup-tests
```

For another supported combination, change the build arguments and use a distinct
image tag. The image supports Linux ARM64 and AMD64 and checks the downloaded
Node archive against its published SHA256 checksum. Image construction needs
network access; test execution does not.

To run the generated CommonJS integration suite and protocol controls:

```sh
docker run --rm --network none -v "$PWD:/repo:ro" postgresjs-startup-tests \
  sh /repo/tests-startup/isolated.sh \
  sh -c 'npm run test:cjs && npm run test:startup && node tests-startup/run.js --cjs'
```

The script copies the checkout into container temporary storage, initializes two
independent clusters on container-only loopback ports 5432/5433, and removes them
on exit. The primary uses the existing test authentication rules; both enable
TLS, logical WAL, and prepared transactions as CI does. Nothing is mounted
writable and no host server is altered. Supply another command after the script
path to run CommonJS tests/builds or focused startup controls in the same setup.
Run supported image/runtime versions when recording compatibility coverage.

Graceful `end()` runs every query accepted before the call, including plain queries still queued in the pool, which an idle draining connection takes before it closes. A reservation owner that is still starting, or a queued reservation, rejects with `CONNECTION_ENDED`. A plain query still queued when the last connection is lost during shutdown gets one reconnect, which runs it and the rest of the queue, and `end()` waits for it; if that reconnect fails, every queued plain query rejects with its error. A connection backing off after a failed attempt rejects a query owner with the last attempt error. If a connection is lost during startup the owner rejects with the error that ended the attempt, usually `CONNECTION_CLOSED`. Forced shutdown (`end({ timeout })` expiring) rejects remaining and queued work with `CONNECTION_DESTROYED`; new queries submitted after shutdown reject with `CONNECTION_ENDED`.

The portable integration suite checks all 22 built-in element/array OID pairs against PostgreSQL, roundtrips built-in arrays with fetching on/off, preserves independent custom parser/serializer overrides, and covers transforms, SQL NULL positions, quoted NULL text, and user-defined arrays. Numeric NULL assertions use strict null checks so JSON serialization cannot hide NaN. Before this change, discovery returned text NULL as a string, integer NULL as NaN, and JSON NULL threw; the shared parser now recognizes unquoted NULL before applying scalar parsers.

`npm run test:workerd -- . <isolated-postgres-port>` runs the actual generated Cloudflare library in local workerd through pinned Wrangler 4.123.0 (requires Node 22 or newer). It covers cold reservation, built-in arrays/NULL values with fetching on/off, handled catalog failure, and the Cloudflare timer and socket-close fixes: `timers` (idle_timeout and max_lifetime firing, then a query on a recycled connection), `connect-timeout` (a server that accepts and never answers), `end-timeout` (`sql.end({ timeout: 0.2 })` over an in-flight `pg_sleep`), `end-plain` (several clients each ending within a bound), `end-while-connecting` (`sql.end({ timeout: 0 })` before the socket opens) and `end-tls`. `end-tls` runs only when `WORKERD_TLS_PORT` points at an SSL-enabled PostgreSQL and `WORKERD_TLS_CA` at its certificate (which needs a `subjectAltName` for `127.0.0.1`); the runner exports it to workerd as `SSL_CERT_FILE`. Each scenario uses a dedicated worker process, bounded requests, an external watchdog, and an observation window that rejects unhandled worker errors and unhandled rejections. The "Stream was cancelled" rejection that workerd reports on every socket close is tolerated: it is the open [#1202](https://github.com/porsager/postgres/issues/1202) / [#1196](https://github.com/porsager/postgres/issues/1196) defect, which the polyfill does not yet fix in real workerd. The worker replaces `setTimeout` with a version that throws on extra arguments, as the Cloudflare runtime does ([#1088](https://github.com/porsager/postgres/issues/1088)); local workerd 4.123.0 accepts them. The runner retains logs under its printed temporary artifact directory. Workerd is an HTTP server, so the parent stops its process after assertions.

The scope follows [#1219](https://github.com/porsager/postgres/issues/1219), [#751](https://github.com/porsager/postgres/issues/751), and [#1203](https://github.com/porsager/postgres/issues/1203) reservation ownership; [#1195](https://github.com/porsager/postgres/issues/1195) queued reconnect; [#789](https://github.com/porsager/postgres/issues/789) first-query type registration; [#1192](https://github.com/porsager/postgres/issues/1192) and [#1205](https://github.com/porsager/postgres/issues/1205) internal rejection handling; [#1223](https://github.com/porsager/postgres/issues/1223), [#1193](https://github.com/porsager/postgres/issues/1193), and [#1226](https://github.com/porsager/postgres/issues/1226) retry/state isolation; and [#1164](https://github.com/porsager/postgres/issues/1164) built-in arrays without discovery. Catalog traffic/caching from [#903](https://github.com/porsager/postgres/issues/903) is deferred. Transaction/handle lifecycle reports [#1199](https://github.com/porsager/postgres/issues/1199), [#1208](https://github.com/porsager/postgres/issues/1208), and [#1242](https://github.com/porsager/postgres/issues/1242) require separate work.

Internal catalog/session initialization keeps PostgreSQL column/value/row shapes independently of user transforms; ordinary query results still use those transforms. The protocol suite verifies both paths. For workerd, a disposable local server can be started with `docker run --rm -d --name postgresjs-workerd-pg -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.11-bookworm`; run the gate with port `55432`, then clean up with `docker stop postgresjs-workerd-pg`.

## Validation recorded on 2026-10-07

The integration matrix used Node 12.22.12, 14.21.3, 16.20.2, 18.20.8, 20.20.2, 21.7.3, 22.23.3, 23.11.1, and 24.21.0 against PostgreSQL 12.22, 13.23, 14.24, 15.19, 16.15, and 17.11 in disposable containers.

- All 54 Node/PostgreSQL combinations passed ESM and CJS: 558 assertions and two real ownership matrices per combination. The protocol/watchdog suite also passed in both formats on all nine Node versions.
- Deno 1.46.3 passed all six PostgreSQL versions: 279 integration assertions plus four pending-socket controls each, with natural exits in 14.3–17.5 seconds. `npm run test:deno-socket` enforces a 10-second parent deadline and requires all four tests to complete; `test:deno` includes this gate. Pending TCP/TLS success and rejection cannot revive destroyed sockets; established connection EOF/close ordering stays unchanged.
- Actual workerd covers four startup scenarios through Wrangler 4.123.0 (cold reservation, built-in arrays with fetching off/on, and catalog failure) plus the timer, `sql.end()` and TLS scenarios described above.
- On Node 24.21.0, 15 selected acquisition/startup races passed 100 repetitions in each format: 3,000 checks. Six disposable mutations independently removed reservation handoff, synchronous type registration, rejection observation, stale-response reset, startup deadline, and successful retry-history reset; the corresponding regression assertions rejected every mutation.

The unchanged baseline at `ca6c610` exited successfully in 50/54 Node combinations and 5/6 Deno combinations. One nominally successful Node 14/PostgreSQL 14 run also emitted an unhandled rejection warning. Baseline failures and warnings are retained separately; the final matrix passes with strict unhandled rejection detection. The deterministic authentication timeout replaces a baseline test that depended on a 1 ms SCRAM exchange being slow enough.

Reproduce the local gates with the Docker build/run commands above, `node tests-startup/run.js` (also `--cjs`), `npm run test:esm`, `npm run test:cjs`, `npm run test:deno`, and the documented workerd command. Builds, lint including `.mjs` harness files and the Deno adapter, and `git diff --check` passed.

Session evidence is retained in `/tmp/postgresjs-final-matrix/results.json`, `/tmp/postgresjs-final-corrected-deno/results.json`, `/tmp/postgresjs-final-repeat100.log`, and `/tmp/postgresjs-final-workerd.log`; baseline results are under `/tmp/postgresjs-baseline-matrix` and `/tmp/postgresjs-baseline-deno`. The tested code/test snapshot's manifest is `/tmp/postgresjs-final-corrected-source-manifest.sha256`, SHA-256 `70af34b2aabf4c7b98a0c276babf9acee1687750ba77d8c56c6c568fdc1c82ac`, recorded before this documentation-only validation update. Node/Cloudflare inputs are byte-identical to their successful matrix/repetition/workerd snapshot; the final Deno adapter has its separate six-version validation.

## Next-release CI policy

The configured core matrix is Node 24/26 × PostgreSQL 15/16/17/18 (eight jobs), with separate Deno 1.46.3/PostgreSQL 17 and workerd/PostgreSQL 17 jobs. Node jobs run both startup formats and ESM/CJS integration with strict unhandled rejections. The shared CI-only setup action configures the primary cluster's authentication, TLS, logical WAL and prepared transactions; Node/Deno jobs retain their secondary PostgreSQL service on port 5433. The workerd gate uses its own PostgreSQL service on host port 55432, avoiding the runner’s preinstalled primary cluster.

The release candidate passed [all ten GitHub-hosted CI jobs](https://github.com/steadybrew/postgresjs/actions/runs/37812371141) on 2026-10-08: Node 24/26 × PostgreSQL 15/16/17/18, Deno 1.46.3/PostgreSQL 17 and actual workerd/PostgreSQL 17. Local Docker validation also passed on Node 24/PostgreSQL 17 and Node 26/PostgreSQL 16. The workerd gate still tolerates the exact known `"Stream was cancelled"` rejection; this does not establish Deno 2 or Bun compatibility. Earlier validation records above describe the completed startup fix's broader historical matrix.

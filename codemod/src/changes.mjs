export const levels = ['act', 'review', 'info']

export const changes = {
  'node-below-22': {
    level: 'act',
    since: '4.0.0',
    title: 'Node.js 22 or newer is required',
    advice: 'Raise the Node.js version here before switching.'
  },
  'node-below-22-ci': {
    level: 'review',
    since: '4.0.0',
    title: 'A CI job runs Node.js older than 22',
    advice: 'If this job installs dependencies and runs code that loads Postgres.js (tests, builds, migrations), raise it to 22 or newer. Jobs that only lint or check links can stay.'
  },
  'types-node-below-22': {
    level: 'act',
    since: '4.5.0',
    title: 'The types need @types/node 22 or newer, or skipLibCheck',
    advice: 'With older @types/node, the Symbol.asyncDispose members fail to compile (TS2550). Upgrade @types/node or set skipLibCheck.'
  },
  'env-false-flips': {
    level: 'act',
    since: '4.5.0',
    title: 'PGSSL, PGPREPARE, PGFETCH_TYPES and PGDEBUG set to false or disable now turn the option off',
    advice: 'Postgres.js read these as truthy strings, so the option was on: PGSSL=disable opened a verified TLS connection and PGPREPARE=false kept prepared statements. After switching, PGSSL=disable connects without TLS and PGPREPARE=false stops preparing. Set the value you actually want.'
  },
  'patched-postgres': {
    level: 'act',
    since: '4.0.0',
    title: 'A patch targets Postgres.js files',
    advice: 'The patch is keyed to postgres@3.4.9 and will not apply to the fork. Where the finding names a known fix, delete the patch. Otherwise check whether the fork already covers it before porting it.'
  },
  'target-session-attrs': {
    level: 'review',
    since: '4.5.0',
    title: 'target_session_attrs follows libpq',
    advice: "'read-write' no longer connects to a hot standby and waits for the promoted server during a failover; 'read-only' accepts one (PostgreSQL 14 and later). With several hosts, a round in which every host answered and none matched fails at once. 'prefer-standby' tries every host for a standby before accepting a primary."
  },
  'fetch-types-false': {
    level: 'review',
    since: '4.0.0',
    title: 'With fetch_types: false, built-in arrays are decoded',
    advice: "Arrays of built-in types come back as JavaScript arrays instead of strings such as '{1,2}'. SQL NULL elements become null. Review code that parses the string."
  },
  'reserved-used-after-release': {
    level: 'review',
    since: '4.0.0',
    title: 'A reserved connection is used after release()',
    advice: 'Queries on a released handle reject with CONNECTION_ENDED instead of running on whatever session the connection has next.'
  },
  'transaction-handle-escapes': {
    level: 'review',
    since: '4.0.0',
    title: 'A transaction handle may be used after sql.begin() returns',
    advice: 'Statements on a finished transaction handle reject with CONNECTION_ENDED instead of running outside the transaction. Keep them inside the callback and await them.'
  },
  'transaction-prepare-name': {
    level: 'review',
    since: '4.0.0',
    title: 'Transaction prepare() name is not a literal string',
    advice: 'The name must be a non-empty string without NUL characters, or the call throws INVALID_TRANSACTION_NAME.'
  },
  'copy-with-max-1': {
    level: 'review',
    since: '4.4.1',
    title: 'COPY with a pool of one connection',
    advice: 'A query awaited before ending your own COPY rejects with COPY_IN_PROGRESS when every connection is running a COPY. Other queries no longer fail while a COPY runs; they wait for a connection.'
  },
  'callback-can-throw': {
    level: 'info',
    since: '4.4.0',
    title: 'A callback that can throw',
    advice: 'If it throws, the error is rethrown as an uncaught exception, which ends the process under Node.js default handling. Postgres.js failed or hung an unrelated query instead. The driver is unaffected either way.'
  },
  'subscribe-without-onerror': {
    level: 'info',
    since: '4.4.0',
    title: 'sql.subscribe() without onerror',
    advice: 'A transform that throws on a change is rethrown as an uncaught exception when a matching subscription has no onerror. Pass onerror as the fourth argument.'
  },
  'onnotice-false': {
    level: 'info',
    since: '4.4.0',
    title: 'onnotice: false now silences notices',
    advice: 'Postgres.js still logged them with console.log.'
  },
  'connection-ended-check': {
    level: 'review',
    since: '4.0.0',
    title: 'Code checks for CONNECTION_ENDED',
    advice: 'On 3.4.9 this code meant sql.end() was called. The fork also raises it for a query on a reserved connection after release(), on a transaction handle after the transaction ended, and for work sent while COMMIT runs. Code that reads it as "the pool is shutting down", or retries it as transient, now also sees these programming errors.'
  },
  'postgres-via-dependency': {
    level: 'act',
    since: '4.0.0',
    title: 'A dependency brings its own Postgres.js',
    advice: 'Your code imports this package and it declares postgres as a regular dependency, so aliasing postgres in your package.json does not reach it and it keeps 3.4.9. If it creates the client your app uses, the switch has no effect until you switch it with overrides (npm), pnpm.overrides or resolutions (yarn).'
  },
  'postgres-via-transitive': {
    level: 'review',
    since: '4.0.0',
    title: 'A package in your production install brings its own Postgres.js',
    advice: 'Your code does not import this package, but a production dependency pulls it in, and it keeps 3.4.9 after the alias. It only matters if something creates a client through it. Switch it with overrides if you want one copy.'
  },
  'postgres-via-tooling': {
    level: 'info',
    since: '4.0.0',
    title: 'A development tool brings its own Postgres.js',
    advice: 'Only development dependencies reach this package, so it does not run in production and keeps 3.4.9 without affecting your app. Switch it with overrides only if you want one copy installed.'
  },
  'error-code-check': {
    level: 'info',
    since: '4.1.0',
    title: 'Code checks a Postgres.js error code',
    advice: 'Some failures that hung now reject with these codes, and lost sessions carry the server error as err.cause. sql.begin() can also reject with TRANSACTION_ROLLED_BACK when the server rolled back on COMMIT.'
  },
  'new-postgres-error': {
    level: 'info',
    since: '4.5.0',
    title: 'new PostgresError()',
    advice: "new PostgresError('message') now sets the message, like Error. Passing an object of fields still works."
  },
  'prepare-false': {
    level: 'info',
    since: '4.5.0',
    title: 'prepare: false: queries with values take two round trips',
    advice: "Run with parameter_types: 'warn' for a few days. If it reports nothing, parameter_types: 'client' sends each query with values in one round trip."
  },
  'promise-race-timeout': {
    level: 'info',
    since: null,
    title: 'A Promise.race timeout around queries',
    advice: 'Keep it: the fork has no client-side query timeout yet. A timed-out query keeps running on the server and holds its connection.'
  }
}

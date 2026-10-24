# API reference

The full API of [@steadybrew/postgresjs](../README.md). Installing, switching from Postgres.js and the fixed upstream issues are in the [README](../README.md).

## Contents

* [Connection](#connection)
* [Queries](#queries)
* [Building queries](#building-queries)
* [Advanced query methods](#advanced-query-methods)
* [Transactions](#transactions)
* [Data Transformation](#data-transformation)
* [Listen & notify](#listen--notify)
* [Realtime subscribe](#realtime-subscribe)
* [Numbers, bigint, numeric](#numbers-bigint-numeric)
* [Parameter types](#parameter-types)
* [Result Array](#result-array)
* [Connection details](#connection-details)
* [Custom Types](#custom-types)
* [Teardown / Cleanup](#teardown--cleanup)
* [Reserving connections](#reserving-connections)
* [Tracing channels](#tracing-channels)
* [Error handling](#error-handling)
* [TypeScript support](#typescript-support)
* [Migration tools](#migration-tools)

## Connection

### `postgres([url], [options])`

You can use either a `postgres://` url connection string or the options to define your database connection properties. Options in the object will override any present in the url. Options will fall back to the same environment variables as psql.

```js
const sql = postgres('postgres://username:password@host:port/database', {
  host                 : '',            // Postgres ip address[s] or domain name[s]
  port                 : 5432,          // Postgres server port[s]
  database             : '',            // Name of database to connect to
  username             : '',            // Username of database user
  password             : '',            // Password of database user
  ...and more
})
```

More options can be found in the [Connection details section](#connection-details).

## Queries

### ```await sql`...` -> Result[]```

Postgres.js utilizes [Tagged template functions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_templates) to process query parameters **before** interpolation. Using tagged template literals benefits developers by:

1. **Enforcing** safe query generation
2. Giving the ` sql`` ` function powerful [utility](#dynamic-inserts) and [query building](#building-queries) features.

Any generic value will be serialized as described in [Parameter types](#parameter-types), and replaced by a PostgreSQL protocol placeholder `$1, $2, ...`. The values are then sent separately to PostgreSQL, which handles escaping & casting.

All queries will return a `Result` array, with objects mapping column names to each row.

```js
const xs = await sql`
  insert into users (
    name, age
  ) values (
    'Murray', 68
  )

  returning *
`

// xs = [{ user_id: 1, name: 'Murray', age: 68 }]
```

> Please note that queries are first executed when `awaited` – or instantly by using [`.execute()`](#execute).

### Query parameters

Parameters are automatically extracted and handled by the database so that SQL injection isn't possible. No special handling is necessary, simply use tagged template literals as usual.

```js
const name = 'Mur'
    , age = 60

const users = await sql`
  select
    name,
    age
  from users
  where
    name like ${ name + '%' }
    and age > ${ age }
`
// users = [{ name: 'Murray', age: 68 }]
```

> Be careful with quotation marks here. Because Postgres infers column types, you do not need to wrap your interpolated parameters in quotes like `'${name}'`. This will cause an error because the tagged template replaces `${name}` with `$1` in the query string, leaving Postgres to do the interpolation. If you wrap that in a string, Postgres will see `'$1'` and interpret it as a string as opposed to a parameter.

### Dynamic column selection

```js
const columns = ['name', 'age']

await sql`
  select
    ${ sql(columns) }
  from users
`

// Which results in:
select "name", "age" from users
```

### Dynamic inserts

```js
const user = {
  name: 'Murray',
  age: 68
}

await sql`
  insert into users ${
    sql(user, 'name', 'age')
  }
`

// Which results in:
insert into users ("name", "age") values ($1, $2)

// The columns can also be given with an array
const columns = ['name', 'age']

await sql`
  insert into users ${
    sql(user, columns)
  }
`
```

**You can omit column names and simply execute `sql(user)` to get all the fields from the object as columns**. Be careful not to allow users to supply columns that you do not want to be inserted.

#### Multiple inserts in one query
If you need to insert multiple rows at the same time it's also much faster to do it with a single `insert`. Simply pass an array of objects to `sql()`.

```js
const users = [{
  name: 'Murray',
  age: 68,
  garbage: 'ignore'
},
{
  name: 'Walter',
  age: 80
}]

await sql`insert into users ${ sql(users, 'name', 'age') }`

// Is translated to:
insert into users ("name", "age") values ($1, $2), ($3, $4)

// Here you can also omit column names which will use object keys as columns
await sql`insert into users ${ sql(users) }`

// Which results in:
insert into users ("name", "age") values ($1, $2), ($3, $4)
```

### Dynamic columns in updates
This is also useful for update queries
```js
const user = {
  id: 1,
  name: 'Murray',
  age: 68
}

await sql`
  update users set ${
    sql(user, 'name', 'age')
  }
  where user_id = ${ user.id }
`

// Which results in:
update users set "name" = $1, "age" = $2 where user_id = $3

// The columns can also be given with an array
const columns = ['name', 'age']

await sql`
  update users set ${
    sql(user, columns)
  }
  where user_id = ${ user.id }
`
```

### Multiple updates in one query
To create multiple updates in a single query, it is necessary to use arrays instead of objects to ensure that the order of the items correspond with the column names.
```js
const users = [
  [1, 'John', 34],
  [2, 'Jane', 27],
]

await sql`
  update users set name = update_data.name, age = (update_data.age)::int
  from (values ${sql(users)}) as update_data (id, name, age)
  where users.id = (update_data.id)::int
  returning users.id, users.name, users.age
`
```

### Dynamic values and `where in`
Value lists can also be created dynamically, making `where in` queries simple too.
```js
const users = await sql`
  select
    *
  from users
  where age in ${ sql([68, 75, 23]) }
`
```

or
```js
const [{ a, b, c }] = await sql`
  select
    *
  from (values ${ sql(['a', 'b', 'c']) }) as x(a, b, c)
`
```

## Building queries

Postgres.js features a simple dynamic query builder by conditionally appending/omitting query fragments.
It works by nesting ` sql`` ` fragments within other ` sql`` ` calls or fragments. This allows you to build dynamic queries safely without risking sql injections through usual string concatenation.

### Partial queries
```js
const olderThan = x => sql`and age > ${ x }`

const filterAge = true

await sql`
  select
   *
  from users
  where name is not null ${
    filterAge
      ? olderThan(50)
      : sql``
  }
`
// Which results in:
select * from users where name is not null
// Or
select * from users where name is not null and age > 50
```

### Dynamic filters
```js
await sql`
  select
    *
  from users ${
    id
      ? sql`where user_id = ${ id }`
      : sql``
  }
`

// Which results in:
select * from users
// Or
select * from users where user_id = $1
```

### Dynamic ordering

```js
const id = 1
const order = {
  username: 'asc'
  created_at: 'desc'
}
await sql`
  select 
    * 
  from ticket 
  where account = ${ id }  
  order by ${
    Object.entries(order).flatMap(([column, order], i) =>
      [i ? sql`,` : sql``, sql`${ sql(column) } ${ order === 'desc' ? sql`desc` : sql`asc` }`]
    )
  }
`
```

### SQL functions
Using keywords or calling functions dynamically is also possible by using ``` sql`` ``` fragments.
```js
const date = null

await sql`
  update users set updated_at = ${ date || sql`now()` }
`

// Which results in:
update users set updated_at = now()
```

### Table names
Dynamic identifiers like table names and column names is also supported like so:
```js
const table = 'users'
    , column = 'id'

await sql`
  select ${ sql(column) } from ${ sql(table) }
`

// Which results in:
select "id" from "users"
```

### Quick primer on interpolation

Here's a quick oversight over all the ways to do interpolation in a query template string:

| Interpolation syntax       | Usage                         | Example                                                   |
| -------------              | -------------                 | -------------                                             |
| `${ sql`` }`               | for keywords or sql fragments | ``await sql`SELECT * FROM users ${sql`order by age desc` }` ``  |
| `${ sql(string) }`         | for identifiers               | ``await sql`SELECT * FROM ${sql('table_name')` ``               |
| `${ sql([] or {}, ...) }`  | for helpers                   | ``await sql`INSERT INTO users ${sql({ name: 'Peter'})}` ``      |
| `${ 'somevalue' }`         | for values                    | ``await sql`SELECT * FROM users WHERE age = ${42}` ``           |

## Advanced query methods

### Cursors

#### ```await sql``.cursor([rows = 1], [fn])```

Use cursors if you need to throttle the amount of rows being returned from a query. You can use a cursor either as an [async iterable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of) or with a callback function. For a callback function new results won't be requested until the promise / async callback function has resolved.

##### callback function
```js
await sql`
  select
    *
  from generate_series(1,4) as x
`.cursor(async([row]) => {
  // row = { x: 1 }
  await http.request('https://example.com/wat', { row })
})
```

##### for await...of
```js
// for await...of
const cursor = sql`select * from generate_series(1,4) as x`.cursor()

for await (const [row] of cursor) {
  // row = { x: 1 }
  await http.request('https://example.com/wat', { row })
}
```

A single row will be returned by default, but you can also request batches by setting the number of rows desired in each batch as the first argument to `.cursor`:
```js
await sql`
  select
    *
  from generate_series(1,1000) as x
`.cursor(10, async rows => {
  // rows = [{ x: 1 }, { x: 2 }, ... ]
  await Promise.all(rows.map(row =>
    http.request('https://example.com/wat', { row })
  ))
})
```

If an error is thrown inside the callback function no more rows will be requested and the outer promise will reject with the thrown error.

You can close the cursor early either by calling `break` in the `for await...of` loop, or by returning the token `sql.CLOSE` from the callback function.

```js
await sql`
  select * from generate_series(1,1000) as x
`.cursor(row => {
  return Math.random() > 0.9 && sql.CLOSE // or sql.END
})
```

### Instant iteration

#### ```await sql``.forEach(fn)```

If you want to handle rows returned by a query one by one, you can use `.forEach` which returns a promise that resolves once there are no more rows.
```js
await sql`
  select created_at, name from events
`.forEach(row => {
  // row = { created_at: '2019-11-22T14:22:00Z', name: 'connected' }
})

// No more rows
```

### Query Descriptions
#### ```await sql``.describe() -> Result[]```

Rather than executing a given query, `.describe` will return information utilized in the query process. This information can include the query identifier, column types, etc.

This is useful for debugging and analyzing your Postgres queries. Furthermore, **`.describe` will give you access to the final generated query string that would be executed.**

### Rows as Array of Values
#### ```sql``.values()```

Using `.values` will return rows as an array of values for each column, instead of objects.

This can be useful to receive identically named columns, or for specific performance/transformation reasons. The column definitions are still included on the result array, plus access to parsers for each column.

### Rows as Raw Array of Buffers
#### ```sql``.raw()```

Using `.raw` will return rows as an array with `Buffer` values for each column, instead of objects.

This can be useful for specific performance/transformation reasons. The column definitions are still included on the result array, plus access to parsers for each column.

### Queries in Files
#### `await sql.file(path, [args], [options]) -> Result[]`

Using a file for a query is also supported with optional parameters to use if the file includes `$1, $2, etc`

```js
const result = await sql.file('query.sql', ['Murray', 68])
```

### Multiple statements in one query
#### ```await sql``.simple()```

The postgres wire protocol supports ["simple"](https://www.postgresql.org/docs/current/protocol-flow.html#id-1.10.6.7.4) and ["extended"](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY) queries. "simple" queries supports multiple statements, but does not support any dynamic parameters. "extended" queries support parameters but only one statement. To use "simple" queries you can use
```sql``.simple()```. That will create it as a simple query.

```js
await sql`select 1; select 2;`.simple()
```

### Copy to/from as Streams

Postgres.js supports [`COPY ...`](https://www.postgresql.org/docs/current/sql-copy.html) queries, which are exposed as [Node.js streams](https://nodejs.org/api/stream.html).

#### ```await sql`copy ... from stdin`.writable() -> Writable```

```js
import { pipeline } from 'node:stream/promises'

// Stream of users with the default tab delimitated cells and new-line delimitated rows
const userStream = Readable.from([
  'Murray\t68\n',
  'Walter\t80\n'
])

const query = await sql`copy users (name, age) from stdin`.writable()
await pipeline(userStream, query);
```

#### ```await sql`copy ... to stdout`.readable() -> Readable```

##### Using Stream Pipeline
```js
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

const readableStream = await sql`copy users (name, age) to stdout`.readable()
await pipeline(readableStream, createWriteStream('output.tsv'))
// output.tsv content: `Murray\t68\nWalter\t80\n`
```

##### Using `for await...of`
```js
const readableStream = await sql`
  copy (
    select name, age
    from users
    where age = 68
  ) to stdout
`.readable()
for await (const chunk of readableStream) {
  // chunk.toString() === `Murray\t68\n`
}
```

> **NOTE** This is a low-level API which does not provide any type safety. To make this work, you must match your [`copy query` parameters](https://www.postgresql.org/docs/current/sql-copy.html) correctly to your [Node.js stream read or write](https://nodejs.org/api/stream.html) code. Ensure [Node.js stream backpressure](https://nodejs.org/en/learn/modules/backpressuring-in-streams) is handled correctly to avoid memory exhaustion.

A `COPY` holds its connection until it finishes. Postgres.js cannot tell that a simple-protocol query is a `COPY` until the server answers, so it sends nothing behind a simple query whose text contains the word `copy` (`sql.unsafe()` or `sql.file()` without parameters, `.simple()`, `.readable()`, `.writable()`). Queries sent through `sql` meanwhile run on another connection or wait for one. When every connection is running a `COPY` that has not been ended, for example with `max: 1`, queries, `sql.reserve()` and `sql.begin()` through `sql` reject with `COPY_IN_PROGRESS` instead, because only that `COPY` finishing could free a connection. Statements on a `sql.reserve()` or `sql.begin()` handle reject with `COPY_IN_PROGRESS` while its `COPY` runs.

### Canceling Queries in Progress

Postgres.js supports [canceling queries in progress](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS). It works by opening a new connection with a protocol level startup message to cancel the current query running on a specific connection. That means there is no guarantee that the query will be canceled, and due to the possible race conditions it might even result in canceling another query. This is fine for long running queries, but in the case of high load and fast queries it might be better to simply ignore results instead of canceling.

```js
const query = sql`select pg_sleep(100)`.execute()
setTimeout(() => query.cancel(), 100)
const result = await query
```

A cancelled query rejects with code `57014`. A cancel can arrive too late, in which case the query may still complete, or fail with its own error. `query.cancel()` resolves once the cancel request has been sent. A cancelled query you don't await does not cause an unhandled rejection. A query cancelled before it was sent rejects with `57014` at once. On a reserved connection, in a transaction, or on a pool with `max: 1`, it keeps its place in line and the driver sends a statement the server refuses in its place, so an open transaction fails instead of committing without it. Elsewhere it is removed from the queue without contacting the server.

The cancel request opens its own connection with the same `ssl`, `sslnegotiation` and `socket` options, bounded by `connect_timeout`. With [several hosts](#multi-host-connections---high-availability-ha) it always goes to the first one, so a query running on another host is not cancelled.

### Execute

#### ```await sql``.execute()```

The lazy Promise implementation in Postgres.js is what allows it to distinguish [Nested Fragments](#building-queries) from the main outer query. This also means that queries are always executed at the earliest in the following tick. If you have a specific need to execute the query in the same tick, you can call `.execute()`

### Unsafe raw string queries

<details>
<summary>Advanced unsafe use cases</summary>

### `await sql.unsafe(query, [args], [options]) -> Result[]`

If you know what you're doing, you can use `unsafe` to pass any string you'd like to postgres. Please note that this can lead to SQL injection if you're not careful.

```js
sql.unsafe('select ' + danger + ' from users where id = ' + dragons)
```

By default, `sql.unsafe` assumes the `query` string is sufficiently dynamic that prepared statements do not make sense, and so defaults them to off. If you'd like to re-enable prepared statements, you can pass `{ prepare: true }`.

You can also nest `sql.unsafe` within a safe `sql` expression.  This is useful if only part of your fraction has unsafe elements.

```js
const triggerName = 'friend_created'
const triggerFnName = 'on_friend_created'
const eventType = 'insert'
const schema_name = 'app'
const table_name = 'friends'

await sql`
  create or replace trigger ${sql(triggerName)}
  after ${sql.unsafe(eventType)} on ${sql.unsafe(`${schema_name}.${table_name}`)}
  for each row
  execute function ${sql(triggerFnName)}()
`

await sql`
  create role friend_service with login password ${sql.unsafe(`'${password}'`)}
`
```

</details>

## Transactions

### BEGIN / COMMIT `await sql.begin([options = ''], fn) -> fn()`

Use `sql.begin` to start a new transaction. Postgres.js will reserve a connection for the transaction and supply a scoped `sql` instance for all transaction uses in the callback function. `sql.begin` will resolve with the returned value from the callback function.

`BEGIN` is automatically sent with the optional options, such as `'read write'` or `'isolation level serializable'`; characters other than letters and spaces are removed from them. If the callback throws or a query in it fails, `ROLLBACK` is sent and `sql.begin` rejects with that error, including when the query failed before reaching the server, such as one with an `undefined` value. If the server answers the `COMMIT` with `ROLLBACK`, for example after a failed query that was not awaited or a caught savepoint failure, `sql.begin` rejects with [`TRANSACTION_ROLLED_BACK`](#transaction_rolled_back) and nothing is committed.

The scoped `sql` only works inside the callback. Statements on it after the transaction has finished, including statements sent while its `COMMIT` or `ROLLBACK` is in flight, reject with [`TRANSACTION_ENDED`](#transaction_ended), and statements after its connection closed reject with `CONNECTION_CLOSED` for as long as the callback is still running.

```js
const [user, account] = await sql.begin(async sql => {
  const [user] = await sql`
    insert into users (
      name
    ) values (
      'Murray'
    )
    returning *
  `

  const [account] = await sql`
    insert into accounts (
      user_id
    ) values (
      ${ user.user_id }
    )
    returning *
  `

  return [user, account]
})
```

Do note that you can often achieve the same result using [`WITH` queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html) instead of using transactions.

It's also possible to pipeline the requests in a transaction if needed by returning an array with queries from the callback function like this:

```js
const result = await sql.begin(sql => [
  sql`update ...`,
  sql`update ...`,
  sql`insert ...`
])
```

### SAVEPOINT `await sql.savepoint([name], fn) -> fn()`

```js
sql.begin('read write', async sql => {
  const [user] = await sql`
    insert into users (
      name
    ) values (
      'Murray'
    )
  `

  const [account] = (await sql.savepoint(sql =>
    sql`
      insert into accounts (
        user_id
      ) values (
        ${ user.user_id }
      )
    `
  ).catch(err => {
    // Account could not be created. ROLLBACK SAVEPOINT is called because we caught the rejection.
  })) || []

  return [user, account]
})
.then(([user, account]) => {
  // great success - COMMIT succeeded
})
.catch(() => {
  // not so good - ROLLBACK was called
})
```


### PREPARE TRANSACTION `sql.prepare(name)`

Indicates that the transactions should be prepared using the [`PREPARE TRANSACTION [NAME]`](https://www.postgresql.org/docs/current/sql-prepare-transaction.html) statement
instead of being committed.

The name must be a non-empty string without NUL characters; invalid names throw `INVALID_TRANSACTION_NAME`. Quotes and backslashes in valid names are preserved.

```js
sql.begin('read write', async sql => {
  const [user] = await sql`
    insert into users (
      name
    ) values (
      'Murray'
    )
  `

  await sql.prepare('tx1')
})
```

## Data Transformation

Postgres.js allows for transformation of the data passed to or returned from a query by using the `transform` option.

Built in transformation functions are:

* For camelCase - `postgres.camel`, `postgres.toCamel`, `postgres.fromCamel`
* For PascalCase - `postgres.pascal`, `postgres.toPascal`, `postgres.fromPascal`
* For Kebab-Case - `postgres.kebab`, `postgres.toKebab`, `postgres.fromKebab`

These built in transformations will only convert to/from snake_case. For example, using `{ transform: postgres.toCamel }` will convert the column names to camelCase only if the column names are in snake_case to begin with. `{ transform: postgres.fromCamel }` will convert camelCase only to snake_case.

By default, using `postgres.camel`, `postgres.pascal` and `postgres.kebab` will perform a two-way transformation - both the data passed to the query and the data returned by the query will be transformed:

```js
// Transform the column names to and from camel case
const sql = postgres({ transform: postgres.camel })

await sql`CREATE TABLE IF NOT EXISTS camel_case (a_test INTEGER, b_test TEXT)`
await sql`INSERT INTO camel_case ${ sql([{ aTest: 1, bTest: 1 }]) }`
const data = await sql`SELECT ${ sql('aTest', 'bTest') } FROM camel_case`

console.log(data) // [ { aTest: 1, bTest: '1' } ]
```

To only perform half of the transformation (eg. only the transformation **to** or **from** camel case), use the other transformation functions:

```js
// Transform the column names only to camel case
// (for the results that are returned from the query)
postgres({ transform: postgres.toCamel })

await sql`CREATE TABLE IF NOT EXISTS camel_case (a_test INTEGER)`
await sql`INSERT INTO camel_case ${ sql([{ a_test: 1 }]) }`
const data = await sql`SELECT a_test FROM camel_case`

console.log(data) // [ { aTest: 1 } ]
```

```js
// Transform the column names only from camel case
// (for interpolated inserts, updates, and selects)
const sql = postgres({ transform: postgres.fromCamel })

await sql`CREATE TABLE IF NOT EXISTS camel_case (a_test INTEGER)`
await sql`INSERT INTO camel_case ${ sql([{ aTest: 1 }]) }`
const data = await sql`SELECT ${ sql('aTest') } FROM camel_case`

console.log(data) // [ { a_test: 1 } ]
```

> Note that Postgres.js does not rewrite the static parts of the tagged template strings. So to transform column names in your queries, the `sql()` helper must be used - eg. `${ sql('columnName') }` as in the examples above.

### Transform `undefined` Values

By default, Postgres.js will throw the error `UNDEFINED_VALUE: Undefined values are not allowed` when undefined values are passed

```js
// Transform the column names to and from camel case
const sql = postgres({
  transform: {
    undefined: null
  }
})

await sql`CREATE TABLE IF NOT EXISTS transform_undefined (a_test INTEGER)`
await sql`INSERT INTO transform_undefined ${ sql([{ a_test: undefined }]) }`
const data = await sql`SELECT a_test FROM transform_undefined`

console.log(data) // [ { a_test: null } ]
```

To combine with the built in transform functions, spread the transform in the `transform` object:

```js
// Transform the column names to and from camel case
const sql = postgres({
  transform: {
    ...postgres.camel,
    undefined: null
  }
})

await sql`CREATE TABLE IF NOT EXISTS transform_undefined (a_test INTEGER)`
await sql`INSERT INTO transform_undefined ${ sql([{ aTest: undefined }]) }`
const data = await sql`SELECT ${ sql('aTest') } FROM transform_undefined`

console.log(data) // [ { aTest: null } ]
```

### Custom Transform Functions

To specify your own transformation functions, you can use the `column`, `value` and `row` options inside of `transform`, each an object possibly including `to` and `from` keys:

* `to`: The function to transform the outgoing query column name to, i.e `SELECT ${ sql('aName') }` to `SELECT a_name` when using `postgres.toCamel`.
* `from`: The function to transform the incoming query result column name to, see example below.

> Both parameters are optional, if not provided, the default transformation function will be used.

The built-in transforms in [`src/types.js`](../src/types.js) (`toCamel`, `fromCamel` and the others) show the expected shape.

```js
function transformColumnToDatabase() { /* ... */ }
function transformColumnFromDatabase() { /* ... */ }

const sql = postgres({
  transform: {
    column: {
      to: transformColumnToDatabase,
      from: transformColumnFromDatabase,
    },
    value: { /* ... */ },
    row: { /* ... */ }
  }
})
```

## Listen & notify

When you call `.listen`, a dedicated connection will be created to ensure that you receive notifications instantly. This connection will be used for any further calls to `.listen`. The connection will automatically reconnect according to a backoff reconnection pattern to not overload the database server.

### Listen `await sql.listen(channel, onnotify, [onlisten]) -> { state, unlisten }`
`.listen` takes the channel name, a function to handle each notify, and an optional function to run every time listen is registered and ready (happens on initial connect and reconnects). It returns a promise which resolves once the `LISTEN` query to Postgres completes, or if there is already a listener active. If either function throws, the error is rethrown as an uncaught exception, and the other listeners and the returned promise are not affected.

```js
await sql.listen('news', payload => {
  const json = JSON.parse(payload)
  console.log(json.this) // logs 'is'
})
```

The optional `onlisten` method is great to use for a very simply queue mechanism:

```js
await sql.listen(
  'jobs',
  (x) => run(JSON.parse(x)),
  ( ) => sql`select unfinished_jobs()`.forEach(run)
)

function run(job) {
  // And here you do the work you please
}
```

`unlisten()` removes this listener. When it was the channel's last listener, `UNLISTEN` is sent.

```js
const { unlisten } = await sql.listen('news', payload => console.log(payload))
await unlisten()
```
### Notify `await sql.notify(channel, payload) -> Result[]`
Notify can be done as usual in SQL, or by using the `sql.notify` method.
```js
sql.notify('news', JSON.stringify({ no: 'this', is: 'news' }))
```

## Realtime subscribe

Postgres.js implements the logical replication protocol of PostgreSQL to support subscription to real-time updates of `insert`, `update` and `delete` operations.

> **NOTE** To make this work you must [create the proper publications in your database](https://www.postgresql.org/docs/current/sql-createpublication.html), enable logical replication by setting `wal_level = logical` in `postgresql.conf` and connect using either a replication or superuser.

### Quick start

#### Create a publication (eg. in migration)
```sql
CREATE PUBLICATION alltables FOR ALL TABLES
```

#### Subscribe to updates
```js
const sql = postgres({ publications: 'alltables' }) // 'alltables' is the default

const { unsubscribe } = await sql.subscribe(
  'insert:events',
  (row, { command, relation, key, old }) => {
    // Callback function for each row change
    // tell about new event row over eg. websockets or do something else
  },
  () => {
    // Callback on initial connect and potential reconnects
  },
  (error) => {
    // Callback on connection errors and changes that could not be decoded
  }
)
```

`unsubscribe()` removes this subscription. The result also carries `state` and `sql`, the replication connection's backend state and client. While subscribed, the client sends the server a status update every second, so a change reaches you within about a second even when the server misses its wake-up for a commit.

If any of these callbacks throws, the error is rethrown as an uncaught exception, and other subscribers and the replication stream are not affected.

`onerror` is called in two cases, and stays registered across reconnects until `unsubscribe()`:

- **The replication connection fails.** The error is also logged with `console.error`. The subscription reconnects on a new replication slot and calls `onsubscribe` again; changes committed while it was disconnected are not delivered. A failed reconnect is retried with [backoff](#all-postgres-options), logged and passed to `onerror`, and never ends the process.
- **A change cannot be decoded,** because a [transform](#data-transformation) or a custom type parser threw. That change is skipped and later changes carry on. The error goes only to the subscriptions that would have received the change, matched by operation and table; a subscription filtered by key gets every skipped change of its table, because the key is read from the decoded row. If a column name transform throws, every change of that table is skipped and reported until the server describes the table again, for example after `ALTER TABLE`. If one of the matching subscriptions has no `onerror`, the error is rethrown once as an uncaught exception, which ends the process under Node's default handling.

### Subscribe pattern

You can subscribe to specific operations, tables, or even rows with primary keys.

#### `operation`      `:` `schema` `.` `table` `=` `primary_key`

**`operation`** is one of ``` * | insert | update | delete ``` and defaults to `*`

**`schema`** defaults to `public`

**`table`** is a specific table name and defaults to `*`

**`primary_key`** can be used to only subscribe to specific rows

### Examples

```js
sql.subscribe('*',                () => /* everything */ )
sql.subscribe('insert',           () => /* all inserts */ )
sql.subscribe('*:users',          () => /* all operations on the public.users table */ )
sql.subscribe('delete:users',     () => /* all deletes on the public.users table */ )
sql.subscribe('update:users=1',   () => /* all updates on the users row with a primary key = 1 */ )
```

## Numbers, bigint, numeric

`Number` in javascript is only able to represent 2<sup>53</sup>-1 safely which means that types in PostgreSQLs like `bigint` and `numeric` won't fit into `Number`.

JavaScript's [`BigInt`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt) can match the PostgreSQL type `bigint` which is returned for eg. `count(*)`. Unfortunately, it doesn't work with `JSON.stringify` out of the box, so Postgres.js will return it as a string.

If you want to use `BigInt` you can add this custom type:

```js
const sql = postgres({
  types: {
    bigint: postgres.BigInt
  }
})
```

There is currently no guaranteed way to handle `numeric` / `decimal` types in native Javascript. **These [and similar] types will be returned as a `string`**. The best way in this case is to use  [custom types](#custom-types).

## Parameter types

A `$1` placeholder has a type that PostgreSQL infers from the SQL around it (the column it is compared to or inserted into, a function argument, a cast). Postgres.js has to turn each JavaScript value into text for that type, and `parameter_types` chooses how.

Some values carry a type Postgres.js can tell from the JavaScript value: `Date`, `Buffer` / `Uint8Array`, booleans, `bigint`, and anything wrapped in `sql.typed(value, oid)`, `sql.types.*`, `sql.json` or `sql.array` with elements. They are serialized for that type and sent in a single round trip, in every mode. Everything else (strings, numbers, plain objects, `sql.typed(value)` without an OID, an empty `sql.array([])`, arrays) has no such type. `null` is always SQL `NULL`.

### `parameter_types: 'server'` (default)

For a value whose type Postgres.js cannot tell, it first asks PostgreSQL for the type of the placeholder, which costs an extra round trip on every query with `prepare: false` and the first time each connection runs that SQL with `prepare: true`, and then serializes the value for that type. This has consequences worth knowing:

- a string sent to a `json` or `jsonb` placeholder is sent as JSON, so `'{"a":1}'` is stored as a JSON string, not an object
- a string or number sent to a `date`, `timestamp` or `timestamptz` placeholder goes through `new Date(x).toISOString()`, where a date-only string such as `'2020-01-02'` is read as UTC and a date-and-time string without an offset such as `'2020-01-02T10:00'` is read in the Node.js process time zone (`TZ`)
- anything other than `true` sent to a `boolean` placeholder is stored as `false`, including the strings `'true'` and `'t'` and the number `1`
- a string sent to a `bytea` placeholder is sent as hex of its UTF-8 bytes
- a custom type registered in `types` with a `from` list runs its `serialize` function

### `parameter_types: 'client'`

The JavaScript value decides how it is serialized and PostgreSQL parses the text, so a query with values is one round trip:

- a string is sent unchanged as text
- a number is sent as its JavaScript text (`'' + n`)
- a plain object (prototype `Object.prototype` or `null`) is sent as `JSON.stringify(x)`
- any other object (Decimal, Luxon, moment, URL, class instances) is sent as `'' + x`
- `null` is SQL `NULL`; `undefined` is handled as before
- a value with a type Postgres.js can tell from the JavaScript value is serialized for that type, as with `'server'`
- an array whose elements have no such type still makes Postgres.js ask PostgreSQL for the placeholder's type first, because only PostgreSQL knows whether the placeholder is an array, JSON or a custom type; that query takes the extra round trip

Measured in production on one app with `prepare: false` behind the Supabase pooler, a day on each mode: against `'warn'`, which takes the same two round trips as `'server'`, the median query went from 5.3 to 3.1 ms and the p95 from 16.8 to 13.5 ms, and the p95 of a request's total query time from 476 to 318 ms. The p99 was unchanged, because the app's slowest statements spend their time in the server, not the round trip.

What this changes compared to `'server'`:

| Value | Type PostgreSQL infers for the placeholder | `'server'` | `'client'` |
| --- | --- | --- | --- |
| string | json, jsonb | sent as JSON: stores a JSON string | parsed as JSON; text that is not JSON is rejected |
| string | boolean | always `false` | PostgreSQL boolean input (`'t'`, `'yes'`, `'on'`, `'1'` are true); invalid text is rejected |
| string | date, timestamp, timestamptz | `new Date(s).toISOString()`: date-only strings are read as UTC, date-and-time strings without an offset in the Node.js process time zone (`TZ`) | parsed by PostgreSQL in the PostgreSQL session's `TimeZone` setting; `date` and `timestamp` ignore an explicit offset |
| string | bytea | hex of the UTF-8 bytes | bytea text input; differs only for strings containing backslashes |
| string, number | a custom type registered in `types` with a `from` list | the type's `serialize` | sent unchanged as text |
| number | json, jsonb | `JSON.stringify` (`NaN` and `Infinity` become `null`) | the number's text (`NaN` and `Infinity` are rejected) |
| number | boolean | `false` | `1` is true, `0` is false, anything else is rejected |
| number | date, timestamp, timestamptz | `new Date(ms)` | rejected, except `Infinity`; a 6- or 8-digit number is read as a `YYMMDD` or `YYYYMMDD` date |
| plain object | json, jsonb | `JSON.stringify` or your json `serialize` | `JSON.stringify` |
| plain object | text | `[object Object]` | JSON text |
| plain object | a custom type registered in `types` with a `from` list | the type's `serialize` | JSON text, normally rejected |
| class instance | json, jsonb | `JSON.stringify`, so `toJSON` applies | `'' + x` |
| class instance | date, timestamp, timestamptz | `new Date(x)` | `'' + x`, normally rejected |

`time`, `timetz` and `interval` placeholders have no serializer in either mode: strings and numbers are sent unchanged as text.

In practice:

- pass `new Date(ms)` for epoch numbers, and set `connection: { timezone }` so date strings are read in the time zone you expect
- pass `sql.json(s)` for a JSON string value, and `sql.types.name(v)` or `sql.typed(v, oid)` for a custom type; a custom type's `serialize` also runs for a whole array bound to that type, never for a plain value
- `NaN`, `Infinity` and `-0` are sent as `NaN`, `Infinity` and `0`, and PostgreSQL's input rules for the placeholder's type decide

Run `'warn'` first to see which of your queries are affected.

**Planned for 5.0:** `'client'` becomes the default. Pass `parameter_types: 'server'` to keep the 4.x behaviour.

### `parameter_types: 'warn'`

`'warn'` behaves exactly like `'server'`, and also reports every query in which a value would be sent differently by `'client'`. The report goes to `ontypemismatch`, or to `console.warn` when it is not set:

```js
const sql = postgres({
  parameter_types: 'warn',
  ontypemismatch: ({ query, parameters }) => {
    // parameters: [{ position: 2, oid: 3802, typeof: 'string' }]
    // position is the $n number, oid the type PostgreSQL inferred for the placeholder
  }
})
```

With `debug: true` each entry also carries `serverText` and `clientText`, the two texts that were compared; `clientText` is the error when the `'client'` mode would throw. A query is reported on every execution that has a difference; sample in `ontypemismatch` if that is too much. `'warn'` serializes each untyped value twice and compares the strings. The option can also be set with `?parameter_types=warn` in the connection URL or `PGPARAMETER_TYPES`.

`'warn'` compares the serialized text, not the stored value, so a report does not always mean the stored value would change.

These reported cases store the same value under both modes:

- `0`, `'0'`, `'false'`, `'no'` and `'off'` sent to a `boolean` placeholder (the texts differ, both store `false`)
- a date string with an explicit offset sent to a `timestamptz` placeholder, as long as it has no more than millisecond precision (`toISOString()` truncates microseconds, so a string with microseconds stores a different value under `'server'`)
- a string without backslashes sent to a `bytea` placeholder

These reported cases store a different value, or are rejected, under `'client'`:

- `1`, `'t'`, `'true'`, `'yes'`, `'on'` and `'1'` sent to a `boolean` placeholder (stored `false` today, `true` under `'client'`)
- a date string with an explicit offset sent to a `timestamp` or `date` placeholder (`'server'` converts to UTC first, `'client'` drops the offset)
- a string sent to a `json` or `jsonb` placeholder, a plain object sent to a `text` placeholder, and a number sent to a date, timestamp or boolean placeholder
- a string or number sent to a custom type registered in `types` with a `from` list, which skips its `serialize`

Date strings without an explicit offset:

| String | Placeholder | Stored the same under both modes when |
| --- | --- | --- |
| date and time, such as `'2020-01-02T10:00'` | `timestamptz` | the Node.js process time zone and the PostgreSQL session's `TimeZone` setting match |
| date only, such as `'2020-01-02'` | `timestamptz` | the PostgreSQL session's `TimeZone` setting is UTC |
| date and time | `timestamp` or `date` | the Node.js process runs in UTC (`'server'` stores the UTC wall time, `'client'` stores the text as written) |

## Result Array

The `Result` Array returned from queries is a custom array allowing for easy destructuring or passing on directly to JSON.stringify or general Array usage. It includes the following properties.

### .count

The `count` property is the number of affected rows returned by the database. This is useful for insert, update and delete operations to know the number of rows since .length will be 0 in these cases if not using `RETURNING ...`.

### .command

The `command` run by the query - eg. one of `SELECT`, `UPDATE`, `INSERT`, `DELETE`

### .columns

The `columns` returned by the query useful to determine types, or map to the result values when using `.values()`

```js
{
  name  : String,    // Column name,
  type  : oid,       // PostgreSQL oid column type
  parser: Function   // The function used by Postgres.js for parsing
}
```

### .statement

The `statement` contains information about the statement implicitly created by Postgres.js.

```js
{
  name    : String,  // The auto generated statement name
  string  : String,  // The actual query string executed
  types   : [oid],   // An array of oid expected as input parameters
  columns : [Column] // Array of columns - same as Result.columns
}
```

### .state

This is the state `{ pid, secret }` of the connection that executed the query.

## Connection details

### All Postgres options

```js
const sql = postgres('postgres://username:password@host:port/database', {
  host                 : 'localhost',   // Postgres ip address[es] or domain name[s] (alias hostname)
  port                 : 5432,          // Postgres server port[s]
  path                 : '',            // unix socket path (usually '/tmp')
  database             : user,          // Name of database to connect to (alias db), defaults to the user name
  username             : '',            // Username of database user (alias user), defaults to the OS user
  password             : '',            // Password of database user (alias pass), or a function, see Dynamic passwords
  ssl                  : false,         // true, 'require', 'allow', 'prefer', 'verify-full' or tls.connect options
  sslnegotiation       : null,          // 'direct' for direct TLS, or 'postgres'
  max                  : 10,            // Max number of connections, 3 on Cloudflare Workers
  max_lifetime         : random,        // Max lifetime in seconds, 30 to 60 minutes by default, see Connection timeout
  idle_timeout         : null,          // Idle connection timeout in seconds, off by default
  connect_timeout      : 30,            // Connect timeout in seconds, see Connection timeout
  backoff              : fn,            // Seconds to wait before a reconnect attempt, see Connection timeout
  keep_alive           : 60,            // TCP keepalive delay in seconds, false to disable
  max_pipeline         : 100,           // Max queries pipelined on one connection, 0 to disable pipelining
  prepare              : true,          // Automatic creation of prepared statements (no_prepare: true disables it)
  fetch_types          : true,          // Fetches array types when each connection starts, see Auto fetching of array types
  parameter_types      : 'server',      // 'client' or 'warn', see Parameter types
  types                : {},            // Custom types by name, see Custom Types
  target_session_attrs : null,          // Which kind of server to connect to, see Multi-host connections
  publications         : 'alltables',   // Publication used by sql.subscribe()
  socket               : fn,            // fn returning custom socket to use, see Custom socket
  debug                : false,         // true makes query, parameters and types enumerable on errors,
                                        // or fn called with (connection, query, parameters, types)
  onnotice             : fn,            // (notice), default console.log, false to silence NOTICE
  onparameter          : fn,            // (key, value) when a server parameter changes
  onnotify             : fn,            // (channel, payload) for every notification on a pool connection
  onclose              : fn,            // (connId) when a connection closes
  onidle               : fn,            // (connId) when a connection returns to the pool idle
  ontypemismatch       : fn,            // Called by parameter_types: 'warn', default console.warn
  transform            : {
    undefined          : undefined,     // Transforms undefined values (eg. to null)
    column             : fn,            // Transforms incoming column names
    value              : fn,            // Transforms incoming row values
    row                : fn             // Transforms entire rows
  },
  connection           : {
    application_name   : 'postgres.js', // Default application_name
    ...                                 // Other connection parameters, see https://www.postgresql.org/docs/current/runtime-config-client.html
  }
})
```

The `onnotice`, `onparameter`, `ontypemismatch`, `onnotify`, `onclose`, `onidle`, `backoff` and `debug` callbacks passed in the options are called synchronously from inside the driver. If one throws, the error is rethrown as an uncaught exception and the connection and its queries are not affected; under Node's default handling that ends the process. A `backoff` that throws falls back to the default delay. `onidle` can also be set after creation through `sql.options.onidle`, and is not called for the connections of `sql.listen()` and `sql.subscribe()`.

### Dynamic passwords

When clients need to use alternative authentication schemes such as access tokens or connections to databases with rotating passwords, provide either a synchronous or asynchronous function that will resolve the dynamic password value at connection time.

```js
const sql = postgres(url, {
  // Other connection config
  ...
  // Password function for the database user
  password : async () => await signer.getAuthToken(),
})
```

The function is called for every new connection, including with SCRAM-SHA-256 authentication, where the keys derived from the password are cached.

### SCRAM key cache

With SCRAM-SHA-256 authentication, the driver derives keys from the password with PBKDF2 at the iteration count the server sends (4096 by default), the largest CPU cost of opening a connection. RFC 5802 allows a client to cache them, and the driver does: every client in the process, or in the Worker isolate on Cloudflare Workers, reuses them for five minutes from derivation, up to 16 entries, keyed by a SHA-256 of the password, salt and iteration count. A different password, or a new salt after the password is changed on the server, derives again; the nonces, the client proof and the check of the server's signature are still computed for each connection.

The cached keys can log in as that role to servers that hold that salt, as the password can, and they stay in memory up to five minutes after `sql.end()` (an expired entry is removed at the next SCRAM login). The password is already in memory for the life of the client.

### SSL

Although [vulnerable to MITM attacks](https://security.stackexchange.com/a/229297/174913), a common configuration for the `ssl` option for some cloud providers is to set `rejectUnauthorized` to `false` (if `NODE_ENV` is `production`):

```js
const sql =
  process.env.NODE_ENV === 'production'
    ? // "Unless you're using a Private or Shield Heroku Postgres database, Heroku Postgres does not currently support verifiable certificates"
      // https://help.heroku.com/3DELT3RK/why-can-t-my-third-party-utility-connect-to-heroku-postgres-with-ssl
      postgres({ ssl: { rejectUnauthorized: false } })
    : postgres()
```

`ssl: 'require'`, `'allow'` and `'prefer'` encrypt without verifying the certificate. Only `'prefer'` falls back to an unencrypted connection when the server refuses SSL; the others fail with [`SSL_NOT_SUPPORTED`](#ssl_not_supported). `true`, `'verify-full'` and an options object verify the certificate as `tls.connect` does. `sslnegotiation: 'direct'` starts TLS immediately instead of asking the server first, which PostgreSQL 17 and later accept.

For more information regarding `ssl`, check out the [Node.js documentation for tls](https://nodejs.org/api/tls.html#tlsconnectoptions-callback).


### Multi-host connections - High Availability (HA)

Multiple connection strings can be passed to `postgres()` in the form of `postgres('postgres://localhost:5432,localhost:5433', ...)`. This works the same as the `psql` command. Read more at [multiple host URIs](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-MULTIPLE-HOSTS).

Connections will be attempted in order of the specified hosts/ports. On a successful connection, all retries will be reset. This ensures that hosts can come up and down seamlessly.

`target_session_attrs` (or `PGTARGETSESSIONATTRS`) picks which kind of server to connect to. The values and their meaning are libpq's:

| Value | Connects to |
|---|---|
| `null` (default) | any server |
| `'read-write'` | a server that accepts writes: not a hot standby, and `default_transaction_read_only` off |
| `'primary'` | a server that is not a hot standby, even if `default_transaction_read_only` is on |
| `'read-only'` | a hot standby, or a server with `default_transaction_read_only` on |
| `'standby'` | a hot standby |
| `'prefer-standby'` | a hot standby if any host is one, otherwise any server |

During a failover or an upgrade, `'read-write'` and `'primary'` wait for the promoted server instead of connecting to a standby whose writes would fail. Read traffic that should keep using standbys during the switch belongs on `'prefer-standby'` or no `target_session_attrs` at all.

With several hosts, a host that answers but is the wrong kind is skipped and the next one is tried at once; if every host answers and none matches, the connection fails immediately with [`TARGET_SESSION_ATTRS`](#target_session_attrs). With a single host, or when some host fails to connect, it keeps retrying, bounded by `connect_timeout` per host, because a failover may be in progress. With `'prefer-standby'`, the search for a standby starts again after each backoff round.

### The Connection Pool

Connections are created lazily once a query is created. This means that simply doing const `sql = postgres(...)` won't have any effect other than instantiating a new `sql` instance.

> No connection will be made until a query is made.

For example:

```js
const sql = postgres() // no connections are opened

await sql`...` // one connection is now opened
await sql`...` // previous opened connection is reused

// two connections are opened now
await Promise.all([
  sql`...`,
  sql`...`
])
```

> When there are high amount of concurrent queries, Postgres.js will open as many connections as needed up until `max` number of connections is reached. By default `max` is 10, and 3 on Cloudflare Workers. This can be changed by setting `max` in the `postgres()` call. Example - `postgres('connectionURL', { max: 20 })`.

This means that we get a much simpler story for error handling and reconnections. Queries will be sent over the wire immediately on the next available connection in the pool. Connections are automatically taken out of the pool if you start a transaction using `sql.begin()`, and automatically returned to the pool once your transaction is done.

Any query which was already sent over the wire will be rejected if the connection is lost. It'll automatically defer to the error handling you have for that query, and since connections are lazy it'll automatically try to reconnect the next time a query is made. The benefit of this is no weird generic "onerror" handler that tries to get things back to normal, and also simpler application code since you don't have to handle errors out of context.

There are no guarantees about queries executing in order unless using a transaction with `sql.begin()` or setting `max: 1`. Of course doing a series of queries, one awaiting the other will work as expected, but that's just due to the nature of js async/promise handling, so it's not necessary for this library to be concerned with ordering.

Since this library automatically creates prepared statements, connections have a default [`max_lifetime`](#connection-timeout) of 30 to 60 minutes, so that prepared statements do not bloat the server's memory.

The states a connection and a reserved or transaction handle move through, and what each state guarantees, are described in [lifecycle.md](lifecycle.md).

### Pool stats

`sql.stats()` returns a snapshot of the pool as a plain object, ready to log, serialise from a health endpoint or map to metrics gauges:

```js
sql.stats()
// { max: 10, totalCount: 7, idleCount: 2, waitingCount: 3,
//   activeCount: 4, availableCount: 5,
//   busyCount: 3, reservedCount: 1, connectingCount: 1, closingCount: 0,
//   executingCount: 4, listenCount: 1, subscribeCount: 0 }
```

| Field | Meaning |
|---|---|
| `max` | The `max` option |
| `totalCount` | Connections that exist: connecting, idle or in use |
| `idleCount` | Connections with a live session that are not in use. A connection released while its reserved handle still has queries in flight is idle with `executingCount` above 0 |
| `waitingCount` | Issued queries and `reserve()` or `begin()` calls that are not running yet: those in the pool queue, those held by a connection that is still opening, those pipelined behind a connection's running query, and those a reserved handle or transaction has queued behind its own connection. A query cancelled while queued on a reserved handle, a transaction or a pool with `max: 1` counts until the statement sent in its place has run |
| `activeCount` | `busyCount + reservedCount`, connections in use |
| `availableCount` | `idleCount` plus the slots the pool can still open (`max - totalCount - closingCount`): connections a query can get without waiting behind other work |
| `busyCount` | Pool connections running queries, including connections at the pipeline limit |
| `reservedCount` | Connections held by `reserve()` or `begin()` |
| `connectingCount` | Connections opening a session |
| `closingCount` | Connections draining or closing. They are not in `totalCount`, but still hold a pool slot until closed |
| `executingCount` | Queries the server is running right now, at most one per connection, on pool and reserved connections alike. It includes the queries the driver runs while a connection starts, and a `COPY` for its whole duration |
| `listenCount` | Connections held by the internal `sql.listen()` pool (0 or 1) |
| `subscribeCount` | Connections held by the internal `sql.subscribe()` pool (0 or 1) |

`totalCount` and `idleCount` have the same meaning as in node-postgres. `waitingCount` is node-postgres's `waitingCount` extended to queries pipelined on connections and queued in leases, and it includes queries sent with `sql` directly, as `pool.query()` does there. Once the pool is at `max`, Postgres.js pipelines new queries onto busy connections, so waiting work can sit on a connection rather than in the pool queue; `waitingCount` counts it too, so `executingCount + waitingCount` covers all issued work that has not finished. Every snapshot satisfies `totalCount === idleCount + busyCount + reservedCount + connectingCount` and `totalCount + closingCount <= max`, the remainder being slots the pool has not opened.

`listenCount` and `subscribeCount` are counted outside `max`, and the other fields only describe the `max` pool connections. A reserved connection's `stats()` returns the same snapshot, but `sql` inside `sql.begin()` and savepoints has no `stats()`, so call it on the main `sql`.

The pool is saturated when `waitingCount > 0 && availableCount === 0`: every connection is in use and more work is waiting. Saturation alone is not a reason to fail a health check, because a single pipelined query on a fully used pool, including a transaction pipelining its own statements, is enough to meet it. A health endpoint should compare `waitingCount` against a limit the application chooses:

```js
import http from 'node:http'

const MAX_WAITING = 100

http.createServer((req, res) => {
  const stats = sql.stats()
  const overloaded = stats.availableCount === 0 && stats.waitingCount > MAX_WAITING

  res.writeHead(overloaded ? 503 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(stats))
}).listen(8080)
```

How much waiting work is acceptable depends on the query durations and the latency the application can tolerate, so the limit has no universal value.

There are no change events, so take snapshots on a timer or on request.

### Connection timeout

Four options decide when connections close and how fast they reopen.

- **`idle_timeout`** closes a connection that has been idle for that many seconds. It is off by default. Set it in serverless environments (Lambda, Vercel), when re-instantiating several `sql` instances, and with a database service that closes idle connections itself (see the [`ECONNRESET` issue](https://github.com/porsager/postgres/issues/179)).
- **`max_lifetime`** closes a connection that many seconds after its session started; in-flight work finishes first. The default is a random interval between 30 and 60 minutes per connection (`60 * (30 + Math.random() * 30)`), which bounds the memory prepared statements hold on the server, works well with Linux's OOM killer and keeps connections from all closing at once. Pass `null` or `0` to keep connections until `sql.end()`.
- **`connect_timeout`** (30 seconds by default) bounds each connection attempt: socket creation, TCP and TLS negotiation, authentication, session checks and type discovery. When an attempt times out the next host is tried, and the acquisition as a whole is bounded by `connect_timeout` multiplied by the number of hosts, measured from the first attempt; time spent waiting on an inherited reconnect delay is not counted. It also bounds a graceful close: if the server does not close the socket within `connect_timeout` seconds after `end()` sends Terminate, the connection is closed anyway. Zero disables all three limits.
- **`backoff`** is the delay before a reconnect attempt after failed ones: a number of seconds, or a function of the number of attempts that failed in a row across the pool, returning seconds. The default is `(0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20)`: a few milliseconds after the first failure, rising to between 10 and 20 seconds after seven failures. A successful connection resets the count.

`idle_timeout` and `max_lifetime` are also checked when an idle connection is handed out, so an idle connection that is past either limit, for example after a serverless instance was frozen, is closed instead of being used.

For example, to close a connection that has either been idle for 20 seconds or existed for more than 30 minutes:

```js
const sql = postgres({
  idle_timeout: 20,
  max_lifetime: 60 * 30
})
```

If the only attempt times out, the error is [`CONNECT_TIMEOUT`](#connect_timeout). Once earlier attempts have failed, exhausting the overall budget reports the earlier error, such as the last server error or `CONNECTION_CLOSED`. With a single host, a socket or socket factory error rejects the query once; with several hosts, errors keep cycling through the hosts with backoff until the budget is spent. Queries already sent to the server are not replayed.

### Vercel Fluid Compute

On Vercel's Fluid Compute an instance can be suspended while a connection sits idle and before `idle_timeout` has closed it, which leaves the connection open on the server. `attachDatabasePool` from `@vercel/functions` keeps the instance alive until idle connections have closed. Pass it the pool through `vercelPool`:

```js
import postgres from '@steadybrew/postgresjs'
import { vercelPool } from '@steadybrew/postgresjs/vercel'
import { attachDatabasePool } from '@vercel/functions'

const sql = postgres({ idle_timeout: 5 })
attachDatabasePool(vercelPool(sql))
```

`vercelPool(sql)` returns the pool object `attachDatabasePool` expects: `options.idleTimeoutMillis` and `on('release', fn)`. It throws unless `idle_timeout` is a positive number of seconds. It hooks into the `onidle` option, which is called with the connection id each time a connection returns to the pool idle and its idle timer starts, and it keeps any `onidle` you set yourself. A connection that was frozen past `idle_timeout` anyway is closed when it is next handed out (see [Connection timeout](#connection-timeout)).

### Cloudflare Workers support

On Cloudflare Workers the package connects through Cloudflare's [`cloudflare:sockets` API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). The package's `workerd` export condition selects that build, so the import is the same as on Node.js. It needs the `nodejs_compat` compatibility flag, which is on by default from compatibility date 2026-08-04; for earlier dates add it to your Wrangler configuration:

```toml
compatibility_flags = ["nodejs_compat"]
```

CI runs the Workers scenarios at compatibility dates 2025-01-01 (with and without `unhandled_rejection_after_microtask_checkpoint`), 2025-09-15 and 2026-10-12 in local workerd, and on Cloudflare's network against Neon, directly, through its pooler and through Hyperdrive, and against Supabase through Hyperdrive.

On compatibility dates before 2026-03-03, workerd can report a rejection as unhandled before the code awaiting it has handled it ([cloudflare/workerd#6020](https://github.com/cloudflare/workerd/issues/6020)). Closing a socket rejects the read the driver always has pending, so each closed connection logs `Stream was cancelled.` or `This socket has been closed.` as an unhandled rejection on those dates, whether `sql.end()` closed it, a timeout did, or the request finished with the client still open. A connection the network or a pooler such as Hyperdrive drops logs the socket error instead, such as `Network connection lost.`, with the stack of the query it failed. The driver handles it, and queries and their errors are unaffected. `sql.end()` sends Terminate and closes at once rather than waiting a round trip for the server to close first, so the log line is the cost of a fast `end()`. To remove it, move to 2026-03-03 or later, or add the flag:

```toml
compatibility_flags = ["nodejs_compat", "unhandled_rejection_after_microtask_checkpoint"]
```

workerd also emulates Node's `node:net` and `node:tls` on top of `cloudflare:sockets`, but running the driver through that emulation costs more CPU per connection: measured on Cloudflare's network against a Supabase pooler, the median rose from 8 to 10 ms with `fetch_types` on, and 30% of connections went past the Workers Free limit of 10 ms, against 9 to 16% over `cloudflare:sockets`. The package therefore ships one Workers build, over `cloudflare:sockets`, with no option to switch ([measurements](https://github.com/steadybrew/postgresjs/issues/15)).

Create the client inside the request handler: a Worker cannot reuse a connection opened by another request.

Every request therefore authenticates a new connection. With SCRAM-SHA-256, the [SCRAM key cache](#scram-key-cache) lets later requests in the same isolate skip PBKDF2: on Cloudflare's network against the Supabase pooler, the median CPU per connect, `select 1` and end fell from 4 to 3 ms ([measurements](https://github.com/steadybrew/postgresjs/pull/170)).

```ts
import postgres from '@steadybrew/postgresjs'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const sql = postgres(env.DATABASE_URL)
    const users = await sql`select * from users limit 10`
    await sql.end()
    return Response.json(users)
  }
}
```

`await sql.end()` and `ctx.waitUntil(sql.end())` cost the same: `end()` writes Terminate and closes without waiting for the server. Leaving the client open also works: when the request finishes, workerd closes its sockets, and in CI the server's backend is gone by the next request, locally and on Cloudflare's network against Neon. The server then sees the client disconnect without Terminate. CI does not check what a pooler does with a client that leaves this way; through Hyperdrive the Worker never holds the database connection itself.

TLS on Workers differs from Node.js:

- Certificates are always verified against public roots: `ssl: 'require'` behaves like `'verify-full'`, and `ca` and `rejectUnauthorized: false` are ignored. A server whose certificate chains to a private CA cannot be reached over TLS from a Worker; Hyperdrive can connect to it with its own CA setting. Supabase is one: its certificates chain to Supabase's own root CA, so reach it through Hyperdrive with that CA uploaded and `verify-full`. Connecting to such a server directly fails at once with [`TLS_CLOSED`](#tls_closed), because Cloudflare closes the socket after the TLS upgrade without an error.
- `sslnegotiation: 'direct'` is not supported.
- The server name is sent, so hosts that route by it, such as Neon, need no extra option.

#### Hyperdrive

[Hyperdrive](https://developers.cloudflare.com/hyperdrive/) pools connections to your database and can cache read queries. To use it:

- Point Hyperdrive at the database's direct connection. For Supabase, use the direct connection string, not Supavisor.
- Leave `prepare` at its default, `true`.
- Pass Hyperdrive's connection string to `postgres()` with `max: 5`, and with `fetch_types: false` unless you need [array types](#auto-fetching-of-array-types) beyond the built-in ones.

```ts
const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })
```

To elaborate, Hyperdrive is itself a pooler and relies on prepared statements: Cloudflare [warns](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/) that with `prepare: false` queries can hang or fail. A chain of Worker, Hyperdrive, Supavisor's transaction mode and database fails with either setting, because Supavisor's transaction mode [does not support prepared statements](https://supabase.com/docs/guides/database/connecting-to-postgres): in CI every query failed, with `prepared statement does not exist` under `prepare: true` and with `CONNECTION_CLOSED` or a timeout under `prepare: false`. [Cloudflare's Supabase guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/) also says to use the direct connection. `max: 5` keeps a request within Workers' limit on concurrent connections, and `fetch_types: false` saves a round trip on each new connection.

CI runs concurrent prepared queries through Hyperdrive, with caching off, on every change: in front of Neon's direct and pooled endpoints, and in front of Supabase's direct connection, verified against Supabase's CA.

#### Next.js

Routes and middleware on the Next.js edge runtime have no TCP sockets, so no PostgreSQL driver can connect from them. Use the Node.js runtime for routes that query the database.

### Auto fetching of array types

Postgres.js automatically fetches array-type information when each connection initializes.

If you have revoked access to `pg_catalog` this feature will no longer work and will need to be disabled.

You can disable catalog discovery by setting `fetch_types` to `false`. A fixed set of 22 common built-in array types still supports parsing and serialization, including text, numeric, boolean, JSON, date, UUID, and byte arrays. This changes earlier `fetch_types: false` behavior, which returned built-in arrays as raw strings. Other built-in, user-defined, and extension arrays still require discovery or explicit type handlers.

SQL `NULL` elements are returned as JavaScript `null`; a quoted text element `"NULL"` remains a string. Explicit array parsers and serializers are preserved independently. Catalog discovery with `fetch_types: true` remains per connection; this change does not cache catalog metadata.

Column, value, and row transforms apply to application query results; initialization metadata retains its original shape.

### Environment variables and URL parameters

It is also possible to connect to the database without a connection string or any options. Postgres.js falls back to the environment variables used by `psql`:

```js
const sql = postgres()
```

| Option                 | Environment variables    |
| ---------------------- | ------------------------ |
| `host`                 | `PGHOST`                 |
| `port`                 | `PGPORT`                 |
| `database`             | `PGDATABASE`             |
| `username`             | `PGUSERNAME` or `PGUSER` |
| `password`             | `PGPASSWORD`             |
| `application_name`     | `PGAPPNAME`              |
| `target_session_attrs` | `PGTARGETSESSIONATTRS`   |
| `ssl`                  | `PGSSL`                  |
| `sslnegotiation`       | `PGSSLNEGOTIATION`       |
| `max`                  | `PGMAX`                  |
| `idle_timeout`         | `PGIDLE_TIMEOUT`         |
| `connect_timeout`      | `PGCONNECT_TIMEOUT`      |
| `max_lifetime`         | `PGMAX_LIFETIME`         |
| `max_pipeline`         | `PGMAX_PIPELINE`         |
| `backoff`              | `PGBACKOFF`              |
| `keep_alive`           | `PGKEEP_ALIVE`           |
| `prepare`              | `PGPREPARE`              |
| `debug`                | `PGDEBUG`                |
| `fetch_types`          | `PGFETCH_TYPES`          |
| `parameter_types`      | `PGPARAMETER_TYPES`      |
| `publications`         | `PGPUBLICATIONS`         |

The options from `ssl` to `publications` are also read from a query parameter of the same name in the URL, such as `?idle_timeout=20`. The values `false` and `disable` turn an option off, so `PGSSL=disable` and `?prepare=false` work as they read. `?sslmode=` sets `ssl`, and `?sslrootcert=system` sets `ssl: 'verify-full'`. Any other query parameter is sent to the server as a connection parameter, as with `connection`.

An option passed in the object wins over the URL, and the URL wins over the environment. When no user is given, the OS user is used, and the database defaults to the user name. `PGMAX` and `?max=` are read as a string and give a pool of one connection ([#129](https://github.com/steadybrew/postgresjs/issues/129)); pass `max` in the options.

### Prepared statements

Prepared statements will automatically be created for any queries where it can be inferred that the query is static. This can be disabled by using the `prepare: false` option. For instance — this is useful when [using PGBouncer in `transaction mode`](https://github.com/porsager/postgres/issues/93#issuecomment-656290493).

With `prepare: false`, `parameter_types: 'client'` sends queries with values in one round trip, unless a value is an untyped array; see [Parameter types](#parameter-types) for how it works and what it saved in production.

**update**: [since 1.21.0](https://www.pgbouncer.org/2023/10/pgbouncer-1-21-0)
PGBouncer supports protocol-level named prepared statements when [configured
properly](https://www.pgbouncer.org/config.html#max_prepared_statements)

## Custom Types

You can add ergonomic support for custom types, or simply use `sql.typed(value, type)` inline, where type is the PostgreSQL `oid` for the type and the correctly serialized string. _(`oid` values for types can be found in the `pg_catalog.pg_type` table.)_

Adding Query helpers is the cleanest approach which can be done like this:

```js
const sql = postgres({
  types: {
    rect: {
      // The pg_types oid to pass to the db along with the serialized value.
      to        : 1337,

      // An array of pg_types oids to handle when parsing values coming from the db.
      from      : [1337],

      //Function that transform values before sending them to the db.
      serialize : ({ x, y, width, height }) => [x, y, width, height],

      // Function that transforms values coming from the db.
      parse     : ([x, y, width, height]) => { x, y, width, height }
    }
  }
})

// Now you can use sql.typed.rect() as specified above
const [custom] = await sql`
  insert into rectangles (
    name,
    rect
  ) values (
    'wat',
    ${ sql.typed.rect({ x: 13, y: 37, width: 42, height: 80 }) }
  )
  returning *
`

// custom = { name: 'wat', rect: { x: 13, y: 37, width: 42, height: 80 } }

```

With `parameter_types: 'client'` a type's `serialize` runs for `sql.typed.name(v)` and for a whole array bound to that type, not for a plain value; see [Parameter types](#parameter-types).

### Custom socket

Easily do in-process ssh tunneling to your database by providing a custom socket for Postgres.js to use. The function (optionally async) must return a socket-like duplex stream.

Here's a sample using [ssh2](https://github.com/mscdex/ssh2)

```js
import ssh2 from 'ssh2'

const sql = postgres({
  ...options,
  socket: ({ host: [host], port: [port] }) => new Promise((resolve, reject) => {
    const ssh = new ssh2.Client()
    ssh
    .on('error', reject)
    .on('ready', () =>
      ssh.forwardOut('127.0.0.1', 12345, host, port,
        (err, socket) => err ? reject(err) : resolve(socket)
      )
    )
    .connect(sshOptions)
  })
})
```

## Teardown / Cleanup

To ensure proper teardown and cleanup on server restarts use `await sql.end()` before `process.exit()`.

Calling `sql.end()` will reject new queries and return a Promise which resolves when all queries are finished and the underlying connections are closed. If a `{ timeout }` option is provided any pending queries will be rejected once the timeout (in seconds) is reached and the connections will be destroyed.

With explicit resource management the pool ends itself at the end of a scope:

```js
async function main() {
  await using sql = postgres()
  await sql`select 1`
}
```

This calls `sql.end()` when the scope exits, so it suits scripts and jobs, not a shared client at a module's top level. The syntax needs Node.js 24+ or TypeScript 5.2+. [Reserved connections](#reserving-connections) release themselves the same way. Transaction handles, cursors, `listen` and `subscribe` are not disposable; `sql.begin()` and `for await` already scope the first two.

`sql.end()` waits at most `connect_timeout` per connection for the server to close it after Terminate; see [Connection timeout](#connection-timeout).

### Sample shutdown using [Prexit](https://github.com/porsager/prexit)

```js
import prexit from 'prexit'

prexit(async () => {
  await sql.end({ timeout: 5 })
  await new Promise(r => server.close(r))
})
```

## Reserving connections

### `await sql.reserve()`

The `reserve` method pulls out a connection from the pool, and returns a client that wraps the single connection. This can be used for running queries on an isolated connection.

```ts
const reserved = await sql.reserve()
await reserved`select * from users`
await reserved.release()
```

### `reserved.release()`

Once you have finished with the reserved connection, call `release` to add it back to the pool. A `using` or `await using` declaration calls `release()` when the scope exits:

```js
using reserved = await sql.reserve()
await reserved`select * from users`
```

After release, queries through that reserved handle reject with [`CONNECTION_RELEASED`](#connection_released). Call `sql.reserve()` again to acquire a new handle. A reserved handle whose connection has closed rejects with `CONNECTION_CLOSED` until it is released, and cannot be reused after reconnect.

## Tracing channels

The driver publishes `diagnostics_channel` events for queries, connections and transactions, so an APM or OpenTelemetry integration can subscribe without patching the driver. Nothing is built or published while no one subscribes: a query costs one `hasSubscribers` check.

| Channel | Type | Covers |
|---|---|---|
| `postgres:query` | `TracingChannel` | One span per query, from the call that runs it until the server answers or the query fails. |
| `postgres:connection` | `TracingChannel` | One span per connection acquisition: socket, TLS, authentication, startup and type fetching, up to the connection serving queries. Retries and other hosts stay inside the same span. |
| `postgres:transaction` | `TracingChannel` | `sql.begin()` and, nested in it, each `sql.savepoint()`. |
| `postgres:query:send` | `Channel` | The query's context again, each time it is written to a connection. Published only for queries that had a `postgres:query` subscriber when they started. |
| `postgres:connection:close` | `Channel` | `{ connectionId, error }` whenever a connection closes, including a failed connection attempt. `error` is undefined for a normal close. |

The `TracingChannel`s publish in the order Node's `tracePromise` does: `start` and `end` in the caller's synchronous code, then for a failure `error`, and for both outcomes `asyncStart` and `asyncEnd`, with `context.result` or `context.error` set first. `start` is published with `runStores`, so a store bound to it, such as an `AsyncLocalStorage` span context, is current in the code that starts the query. Every query publishes `asyncStart` and `asyncEnd` exactly once. That includes cursors read with `for await` or a callback, `forEach`, `COPY` streams (once the copy is over), `describe()`, `simple()`, `unsafe()`, `file()`, pipelined queries, retried queries and queries cancelled before they were sent. The driver's own startup queries (type fetching, `target_session_attrs`) are not published; they belong to the connection span.

The context objects are the `QueryTraceContext`, `ConnectionTraceContext` and `TransactionTraceContext` types.

| Field | Channel | Set |
|---|---|---|
| `database`, `user` | all three | at `start` |
| `serverAddress`, `serverPort` | query, connection | at `start` when one host is configured; otherwise when the query is written, or when each connection attempt opens its socket. A Unix socket path is the address, with no port. |
| `query` | query | when the query is written: SQL text with `$n` placeholders |
| `values` | query | when the query is written: the parameters before they are serialized, raw |
| `connectionId` | query, connection | when the query is written (query); at `start` (connection). It is the `id` that `onclose` and `onidle` report. |
| `result` | query | before `asyncStart`: the `Result` with `command` and `count`; for `describe()` the statement; for a `COPY` stream the `Result` of the finished copy, not the stream |
| `result` | transaction | before `asyncStart` for `sql.begin()`: `{ committed }`, false when the transaction was prepared |
| `error` | all three | before `error` |
| `options` | transaction | at `start`: the mode string given to `sql.begin()` |
| `savepoint` | transaction | at `start` for `sql.savepoint()`: the savepoint name as sent, such as `s0_name` |
| `prepared` | transaction | when `sql.prepare(name)` is called |

The `result` and `error` keys do not exist on a context until they are set, so a subscriber can tell a finished call from a started one by `'result' in context || 'error' in context`. The text and parameters are known only after the driver has serialized the query for a connection, so they are not in the context at `start`. Read them at `asyncEnd` or `error`, or rename the span then. A query written again after a retry publishes `postgres:query:send` again, with the same context. The time between `start` and the first `postgres:query:send` is the wait for a connection, and between that and `asyncEnd` the time on the server.

Parameters are included as they are. Decide in your subscriber what to record, since values can hold personal data.

```js
import dc from 'node:diagnostics_channel'

const channel = dc.tracingChannel('postgres:query')

channel.subscribe({
  start(context) {
    context.startedAt = performance.now()
  },
  end() {},
  asyncStart() {},
  asyncEnd(context) {
    console.log(context.query, context.result?.count, performance.now() - context.startedAt)
  },
  error(context) {
    console.error(context.query, context.error)
  }
})
```

To make a span current for the code that runs the query, bind an `AsyncLocalStorage` to the start channel with `channel.start.bindStore(storage, context => span)`.

On Node.js the channels need Node 22 or newer, as the package does. On a runtime without `diagnostics_channel.tracingChannel` nothing is published. On Cloudflare Workers the module needs the `nodejs_compat` flag, which the driver requires already.

## Error handling

Errors are all thrown to related queries and never globally. Errors coming from database itself are always in the [native Postgres format](https://www.postgresql.org/docs/current/errcodes-appendix.html), and the same goes for any [Node.js errors](https://nodejs.org/api/errors.html#errors_common_system_errors) eg. coming from the underlying connection.

Query errors will contain a stored error with the origin of the query to aid in tracing errors.

Query errors will also contain the `query` string and the `parameters`. These are not enumerable to avoid accidentally leaking confidential information in logs. To log these it is required to specifically access `error.query` and `error.parameters`, or set `debug: true` in options.

There are also the following errors specifically for this library. Each has the code below as `err.code`. Errors about the connection have a message such as `write CONNECTION_CLOSED host:port`; the others have the code, a colon and the message, such as `UNDEFINED_VALUE: Undefined values are not allowed`.

### UNSAFE_TRANSACTION
> Only use sql.begin, sql.reserved or max: 1

A raw `BEGIN` was sent through the pool. To ensure statements in a transaction run on the same connection (which is required for them to run inside the transaction), use [`sql.begin(...)`](#transactions), a [reserved connection](#reserving-connections) or only allow a single connection in options (`max: 1`).

### UNDEFINED_VALUE
> Undefined values are not allowed

Postgres.js won't accept `undefined` as values in tagged template queries since it becomes ambiguous what to do with the value. Use `null` explicitly, or [transform `undefined` values](#transform-undefined-values).

### MESSAGE_NOT_SUPPORTED
> FunctionCallResponse (B) is not supported

The server sent a message this library does not handle: `FunctionCallResponse` or `NegotiateProtocolVersion`. Feel free to file an issue if you think something is missing.

### MAX_PARAMETERS_EXCEEDED
> Max number of parameters (65534) exceeded

The postgres protocol doesn't allow more than 65534 (16bit) parameters. If you run into this issue there are various workarounds such as using `sql([...])` to escape values instead of passing them as parameters.

### SASL_SIGNATURE_MISMATCH
> The server did not return the correct signature

When using SASL authentication the server responds with a signature at the end of the authentication flow which needs to match the one on the client. This is to avoid [man-in-the-middle attacks](https://en.wikipedia.org/wiki/Man-in-the-middle_attack). If you receive this error the connection was canceled because the server did not reply with the expected signature.

### NOT_TAGGED_CALL
> Query not called as a tagged template literal

Making queries has to be done using the sql function as a [tagged template](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_templates). This is to ensure parameters are serialized and passed to Postgres as query parameters with correct types and to avoid SQL injection.

### SSL_NOT_SUPPORTED
> The server does not support SSL connections

The server answered the SSL request with a refusal while `ssl` is set to a mode other than `'prefer'`. The attempt fails at once for a single host. Use `ssl: 'prefer'` to fall back to an unencrypted connection, or enable SSL on the server. See [SSL](#ssl).

### TLS_CLOSED
> TLS_CLOSED: The server closed the connection after the TLS upgrade, before it replied. Workers verify certificates against public roots, so a server whose certificate chains to a private CA needs Hyperdrive

Cloudflare Workers only. The server accepted the SSL request, and the connection closed after the TLS upgrade before the server sent anything. Cloudflare reports a certificate it doesn't trust this way, without an error of its own. The attempt fails at once for a single host, with `ssl: 'prefer'` too, since the server did accept SSL. See [Cloudflare Workers support](#cloudflare-workers-support).

### TARGET_SESSION_ATTRS
> No host matched target_session_attrs=read-write: localhost:5432 is read-only

No host satisfied [`target_session_attrs`](#multi-host-connections---high-availability-ha). This error is the `cause` of the `CONNECTION_CLOSED` error the query rejects with, so retry logic keyed on `CONNECTION_CLOSED` keeps working; read `err.cause.code` and `err.cause.message` for the reason. The message names the requested value and each host with the reason it was rejected. When it is raised at once and when the client keeps retrying instead is described under [Multi-host connections](#multi-host-connections---high-availability-ha).

### INVALID_TRANSACTION_NAME
> sql.prepare requires a non-empty string without null bytes

Thrown by [`sql.prepare(name)`](#prepare-transaction-sqlpreparename) inside `sql.begin()` for a name that is not a non-empty string, or that contains a NUL character.

### 57014
> canceling statement due to user request

The code PostgreSQL uses for a cancelled statement. A query [cancelled](#canceling-queries-in-progress) before it was sent rejects with a plain `Error` carrying this code, so `err.code === '57014'` matches a cancel whether the server or the client settled it. If it was in a transaction, the transaction fails as after a server error.

### CONNECTION_CLOSED
> write CONNECTION_CLOSED host:port

This error is thrown if the connection was closed, or could not be opened, without an error of its own. When the server or the network ended the session, or no host matched `target_session_attrs`, the underlying error is available as `err.cause`.

### CONNECTION_ENDED
> write CONNECTION_ENDED host:port

This error is thrown if the user has called [`sql.end()`](#teardown--cleanup) and then starts a query, `sql.reserve()` or `sql.begin()`, or one of the last two was still waiting for a connection when `sql.end()` was called. A reserved handle or transaction handle that is already held is not affected: it keeps working until it is released or its transaction finishes. If `sql.end({ timeout })` closes its connection first, a statement in flight and `sql.begin()` reject with `CONNECTION_DESTROYED`, and statements sent afterwards reject with `CONNECTION_CLOSED`. Before 4.7.0 it was also raised for the handle misuse described under [`TRANSACTION_ENDED`](#transaction_ended) and [`CONNECTION_RELEASED`](#connection_released).

### TRANSACTION_ENDED
> TRANSACTION_ENDED: Transaction handle used after its transaction ended

A statement was sent on a `sql.begin()` handle, or a savepoint handle in it, after the transaction had committed, rolled back or prepared, or while its `COMMIT`, `ROLLBACK` or `PREPARE TRANSACTION` is in flight. The statement is not sent. A savepoint whose callback was still running when the outer transaction ended rejects with it too, though no statement was sent. This also holds after the callback finished on a transaction whose connection had closed. This is a bug in the calling code, for example a handle that escaped the callback or a query that was not awaited, so fix it rather than retry it. Since 4.7.0; before, `CONNECTION_ENDED`, or `CONNECTION_CLOSED` when the connection had closed before the callback finished.

### CONNECTION_RELEASED
> CONNECTION_RELEASED: Reserved connection used after release()

A statement was sent on a [`sql.reserve()`](#reserving-connections) handle after `release()`, or after it was disposed. Statements sent before `release()` that were still waiting behind an earlier one reject with it as well. This holds even if the connection had closed before `release()`. The statement is not sent, because the connection may already belong to someone else. This is a bug in the calling code, so fix it rather than retry it; call `sql.reserve()` again for a new handle. Since 4.7.0; before, `CONNECTION_ENDED`, or `CONNECTION_CLOSED` when the connection had closed before `release()`.

### CONNECTION_DESTROYED
> write CONNECTION_DESTROYED host:port

This error is thrown for any queries that were pending when the timeout to [`sql.end({ timeout: X })`](#teardown--cleanup) was reached.

### CONNECT_TIMEOUT
> write CONNECT_TIMEOUT host:port

A connection attempt took longer than `connect_timeout` (30 seconds by default, `PGCONNECT_TIMEOUT`). What it covers, how it combines across hosts and which error you get once several attempts failed is described under [Connection timeout](#connection-timeout).

### COPY_IN_PROGRESS
> You cannot execute queries during copy

A statement was sent on a `sql.reserve()` or `sql.begin()` handle while its copy operation runs, or through `sql` while every connection is running a copy operation that has not been ended. See [Copy to/from as Streams](#copy-tofrom-as-streams).

### TRANSACTION_ROLLED_BACK
> The server rolled the transaction back instead of committing it

This error is thrown by `sql.begin()` when the server answers the final `COMMIT` (or `PREPARE TRANSACTION`) with `ROLLBACK`, because the transaction was aborted by a statement whose error the callback did not surface, such as a failing query that was not awaited, whether the server refused it or it failed before it was sent. Nothing was committed. When such a query's error was already recorded, it is the error's `cause`.

### Other errors

`postgres()` throws a plain `Error` without a code for an unsupported `target_session_attrs` or `parameter_types` value, `vercelPool()` for a missing `idle_timeout`, and `sql.subscribe()` rejects with one for an empty `publications` option or a malformed pattern.

## TypeScript support

Postgres.js has TypeScript support. You can pass a row list type for your queries in this way:
```ts
interface User {
  id: number
  name: string
}

const users = await sql<User[]>`SELECT * FROM users`
users[0].id // ok => number
users[1].name // ok => string
users[0].invalid // fails: `invalid` does not exists on `User`
```

However, be sure to check the array length to avoid accessing properties of `undefined` rows:
```ts
const users = await sql<User[]>`SELECT * FROM users WHERE id = ${id}`
if (!users.length)
  throw new Error('Not found')
return users[0]
```

You can also prefer destructuring when you only care about a fixed number of rows.
In this case, we recommend you to prefer using tuples to handle `undefined` properly:
```ts
const [user]: [User?] = await sql`SELECT * FROM users WHERE id = ${id}`
if (!user) // => User | undefined
  throw new Error('Not found')
return user // => User

// NOTE:
const [first, second]: [User?] = await sql`SELECT * FROM users WHERE id = ${id}` // fails: `second` does not exist on `[User?]`
const [first, second] = await sql<[User?]>`SELECT * FROM users WHERE id = ${id}` // don't fail : `second: User | undefined`
```

The declarations need `@types/node` 22 or newer, or `skipLibCheck`. Feel free to open an issue if you have trouble with types.

## Migration tools

Postgres.js doesn't come with a schema migration tool. These third-party modules support Postgres.js; they are not maintained or tested here:

- https://github.com/porsager/postgres-shift
- https://github.com/lukeed/ley
- https://github.com/JAForbes/pgmg


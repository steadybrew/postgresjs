# Startup regression harness

`node tests-startup/run.js` runs passing protocol controls and verifies the
watchdog itself. Each child runs with strict unhandled rejections, a parent
wall-clock deadline, and an explicit completion message. A zero exit code alone
cannot pass. Children must exit naturally; deadline kills always fail.

`node tests-startup/run.js --regressions` runs cold reservation without fetching
and catalog-error propagation. This command intentionally fails on the original
library. It is separate from the passing controls, not skipped coverage. After
fixing each defect, promote its scenario into the default list.

Add `--cjs` to either command to test the generated CommonJS library after
`npm run build:cjs`. The fixture and watchdog stay in Node; the existing Deno
suite is the Deno integration gate.

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

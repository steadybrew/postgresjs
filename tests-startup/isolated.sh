#!/bin/sh
# Run inside a disposable container, e.g. the command in README.md.
set -eu
if [ "$(id -u)" = 0 ]; then
  task_work=$(mktemp -d /tmp/postgresjs-startup.XXXXXX)
  cp -R /repo/. "$task_work/"
  chown -R postgres:postgres "$task_work"
  exec gosu postgres sh "$task_work/tests-startup/isolated.sh" "$@"
fi
cd "$(dirname "$0")/.."
task_cluster=$(mktemp -d /tmp/postgresjs-clusters.XXXXXX)
cleanup() {
  pg_ctl -D "$task_cluster/primary" -m immediate stop >/dev/null 2>&1 || true
  pg_ctl -D "$task_cluster/secondary" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$task_cluster"
}
trap cleanup EXIT HUP INT TERM
for task_instance in primary secondary; do
  task_data="$task_cluster/$task_instance"
  initdb -D "$task_data" -U postgres --auth=trust >"$task_cluster/init-$task_instance.log"
  if [ "$task_instance" = primary ]; then
    task_port=5432
    cp tests/pg_hba.conf "$task_data/pg_hba.conf"
  else
    task_port=5433
  fi
  openssl req -new -x509 -nodes -days 1 -subj /CN=localhost \
    -keyout "$task_data/server.key" -out "$task_data/server.crt" 2>"$task_cluster/tls-$task_instance.log"
  chmod 600 "$task_data/server.key"
  cat >> "$task_data/postgresql.conf" <<CONFIG
port = $task_port
listen_addresses = 'localhost'
unix_socket_directories = '$task_cluster'
wal_level = logical
max_prepared_transactions = 100
ssl = on
CONFIG
  pg_ctl -D "$task_data" -l "$task_cluster/$task_instance.log" -w start >/dev/null
done
export PGUSER=postgres PGHOST=localhost PGPORT=5432 PGSOCKET="$task_cluster"
node --version
psql -Atc 'select version()'
# A whole-suite deadline also bounds old test cases that leave sockets alive.
if [ "$#" = 0 ]; then
  set -- node --unhandled-rejections=strict tests/index.js
fi
timeout 180 "$@"

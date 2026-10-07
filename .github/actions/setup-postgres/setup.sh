#!/usr/bin/env bash
# Dedicated GitHub runner only: replace its preinstalled test clusters.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'This setup is only for GitHub Actions' >&2; exit 1; }
case ${CI_POSTGRES_VERSION:-} in
  15|16|17|18) ;;
  *) echo 'Unsupported CI PostgreSQL version' >&2; exit 1 ;;
esac

if command -v pg_lsclusters >/dev/null; then
  while read -r task_version task_cluster; do
    sudo pg_dropcluster --stop "$task_version" "$task_cluster"
  done < <(pg_lsclusters --no-header | awk '{print $1, $2}')
fi
# Reuse the runner's PGDG configuration, including its signing key, when present.
if ! sudo grep -Rq 'apt.postgresql.org' /etc/apt/sources.list.d /etc/apt/sources.list; then
  sudo install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc |
    sudo tee /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc >/dev/null
  printf 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$(lsb_release -cs)" |
    sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
fi
sudo apt-get update
sudo apt-get -y install "postgresql-$CI_POSTGRES_VERSION"
task_config="/etc/postgresql/$CI_POSTGRES_VERSION/main"
[[ -d "$task_config" ]] || sudo pg_createcluster "$CI_POSTGRES_VERSION" main --port 5432
sudo cp tests/pg_hba.conf "$task_config/pg_hba.conf"
sudo sed -i 's/.*wal_level.*/wal_level = logical/;s/.*max_prepared_transactions.*/max_prepared_transactions = 100/;s/.*ssl = .*/ssl = on/;s/.*port = .*/port = 5432/' "$task_config/postgresql.conf"
openssl req -new -x509 -nodes -days 365 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout server.key -out server.crt
sudo install -o postgres -g postgres -m 600 server.key "$task_config/server.key"
sudo install -o postgres -g postgres -m 644 server.crt "$task_config/server.crt"
printf "ssl_cert_file = '%s/server.crt'\nssl_key_file = '%s/server.key'\n" "$task_config" "$task_config" |
  sudo tee -a "$task_config/postgresql.conf" >/dev/null
sudo pg_ctlcluster "$CI_POSTGRES_VERSION" main restart
pg_isready -p 5432
sudo -u postgres psql -c 'SHOW hba_file;'

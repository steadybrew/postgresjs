#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'This setup is only for GitHub Actions' >&2; exit 1; }
version=$1 name=$2 port=$3 cert=${4:-} key=${5:-}

sudo pg_createcluster "$version" "$name" --port "$port"
config="/etc/postgresql/$version/$name"
printf 'local all all trust\nhost all all all trust\n' | sudo tee "$config/pg_hba.conf" >/dev/null
if [[ -n $cert ]]; then
  sudo install -o postgres -g postgres -m 644 "$cert" "$config/server.crt"
  sudo install -o postgres -g postgres -m 600 "$key" "$config/server.key"
  printf "ssl = on\nssl_cert_file = '%s/server.crt'\nssl_key_file = '%s/server.key'\n" "$config" "$config" |
    sudo tee -a "$config/postgresql.conf" >/dev/null
else
  echo 'ssl = off' | sudo tee -a "$config/postgresql.conf" >/dev/null
fi
sudo pg_ctlcluster "$version" "$name" start
pg_isready -h 127.0.0.1 -p "$port"

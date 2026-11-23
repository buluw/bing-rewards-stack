#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }
umask 077
if [[ ! -e .env ]]; then
  cp .env.example .env
  api_token=$(openssl rand -hex 32)
  dashboard_password=$(openssl rand -hex 24)
  sed -i "s/^API_TOKEN=__GENERATE__$/API_TOKEN=$api_token/;s/^DASHBOARD_PASSWORD=__GENERATE__$/DASHBOARD_PASSWORD=$dashboard_password/" .env
  echo 'Created .env with random API token and dashboard password.'
else
  echo 'Existing .env preserved.'
fi
mkdir -p config data logs browser_data sessions dashboard-data backups
if [[ ! -e config/config.json ]]; then
  cp backend/config.example.json config/config.json
fi
chmod 600 .env config/config.json
echo 'Edit .env to configure your accounts. No containers or tasks were started.'

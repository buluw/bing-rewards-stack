#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose config --quiet
# Only a read-only local health/status request; no Microsoft requests or starts.
docker compose exec -T ms-rewards node --input-type=module <<'JS'
const headers = {Authorization: `Bearer ${process.env.API_TOKEN}`};
for (const path of ['/health', '/status']) {
  const response = await fetch(`http://127.0.0.1:3010${path}`, {headers, signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body = await response.json();
  console.log(path === '/health' ? {health: body.ok} : {state: body.state});
  if (path === '/health' && body.ok !== true) process.exitCode = 1;
}
JS
docker compose exec -T rewards-dashboard node <<'JS'
const headers = {Authorization: 'Basic ' + Buffer.from(process.env.DASHBOARD_USERNAME + ':' + process.env.DASHBOARD_PASSWORD).toString('base64')};
(async () => {
  const response = await fetch('http://127.0.0.1:8890/api/health', {headers, signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`Dashboard health: HTTP ${response.status}`);
  const body = await response.json();
  if (![body.ok, body.controlApi, body.controlApiAuthOk, body.streamConnected].every(value => value === true)) throw new Error('Dashboard backend or stream is not ready; retry after polling interval');
  console.log({dashboardHealth: true, controlApi: true, auth: true, stream: true});
})().catch(e => {console.error(e.message); process.exitCode = 1;});
JS
docker compose ps

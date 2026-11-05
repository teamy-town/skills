#!/usr/bin/env bash
# graph-memory sidecar entrypoint — the agent-graph server on its SQLite driver:
# one file per graph under /data/graphs, one process, one /data volume.
#
#   1. a /data volume that still holds the Postgres cluster an older image wrote
#      (/data/pg) and has not been fully moved yet: start that Postgres on
#      127.0.0.1 ONLY and ask the engine which of its graphs still hold rows no
#      SQLite file has taken over (`--list-unmigrated`).
#        - none → stop Postgres, write /data/pg-retired, and never start it
#          again; /data/pg stays on the volume as the backup, untouched.
#        - some → run the server with `--migrate-from-pg`: each such graph is
#          copied to its file the first time it is opened (verified row counts,
#          temp file + rename; a failed copy is served from Postgres and logged
#          loudly — engine: packages/agent-graph/src/migrate.ts). The next start
#          asks again.
#      A volume that never had Postgres (a new box) never starts it.
#   2. run `agent-graph-server --driver sqlite` on $PORT (8093), forwarding
#      SIGTERM/SIGINT so the manager's stop shuts the server (and Postgres, when
#      it was started) down cleanly.
#
# AUTH: the control-plane forwards `spec.env.SIDECAR_AUTH_TOKEN` as a Bearer
# when the spec carries one (backend/src/handlers/graph-memory-store.js — the
# same contract postgres-store.js has with the gbrain sidecar). When the
# container was started WITH that variable, the server is told to require it
# (`--auth-token`); unset ⇒ no auth, the infra network is the boundary — the
# gbrain sidecar's default.
set -euo pipefail

: "${PORT:=8093}"
# The engine's own default bind is 127.0.0.1 (a local dev default). In this
# container the CALLER is the control-plane on the infra network, so the server
# must listen on every interface of the container — the legacy Postgres, by
# contrast, stays on 127.0.0.1 because nothing outside the container may reach it.
: "${HOST:=0.0.0.0}"
# One SQLite file per graph: <GRAPHS_DIR>/<graphId>.sqlite (the graph id is
# derived by the control-plane, never by a client; the server checks its shape).
: "${GRAPHS_DIR:=/data/graphs}"
# The cluster an older image kept the graphs in, and the marker written once
# every graph in it has been moved.
: "${PGDATA:=/data/pg}"
LEGACY_RETIRED=/data/pg-retired
PG_PORT=5432
PG_HOST=127.0.0.1
PG_USER=graph
PG_DB=graph
PG_URL="postgres://$PG_USER@$PG_HOST:$PG_PORT/$PG_DB"

log() { printf '[graph-memory] %s\n' "$*" >&2; }

mkdir -p "$GRAPHS_DIR"

PG_STARTED=
stop_all() {
  local code=$?
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$PG_STARTED" ]; then
    "$(pg_config --bindir)/pg_ctl" -D "$PGDATA" -m fast -w -t 30 stop >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap stop_all TERM INT EXIT

# ── 1. a volume still holding graphs in Postgres ─────────────────────────────
MIGRATE_ARGS=()
if [ -s "$PGDATA/PG_VERSION" ] && [ ! -e "$LEGACY_RETIRED" ]; then
  PG_BIN="$(pg_config --bindir)"
  # Unix sockets under /tmp: /var/run/postgresql is root-owned in the base image
  # and this process runs unprivileged.
  "$PG_BIN/pg_ctl" -D "$PGDATA" -w -t 60 -l /tmp/postgres.log \
    -o "-c listen_addresses=$PG_HOST -c port=$PG_PORT -c unix_socket_directories=/tmp" start
  PG_STARTED=1
  # A failed listing is not "nothing left": the server then moves on first open.
  pending="$(agent-graph-server --driver sqlite --sqlite-dir "$GRAPHS_DIR" --migrate-from-pg "$PG_URL" --list-unmigrated)" \
    || pending="(the listing failed — see above)"
  if [ "$pending" = "[]" ]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w -t 30 stop >/dev/null
    PG_STARTED=
    date -u +%Y-%m-%dT%H:%M:%SZ > "$LEGACY_RETIRED"
    log "every graph in the old Postgres cluster has its SQLite file — Postgres will not be started again; $PGDATA is kept as the backup"
  else
    MIGRATE_ARGS=(--migrate-from-pg "$PG_URL")
    log "graphs still in the old Postgres cluster, each moved to SQLite on its first open: $pending"
  fi
fi

# ── 2. the engine ────────────────────────────────────────────────────────────
AUTH_ARGS=()
if [ -n "${SIDECAR_AUTH_TOKEN:-}" ]; then
  AUTH_ARGS=(--auth-token "$SIDECAR_AUTH_TOKEN")
fi
log "starting agent-graph-server on $HOST:$PORT (driver=sqlite, dir=$GRAPHS_DIR, legacy postgres=$([ -n "$PG_STARTED" ] && echo on || echo off), auth=$([ ${#AUTH_ARGS[@]} -gt 0 ] && echo on || echo off))"
agent-graph-server --driver sqlite --sqlite-dir "$GRAPHS_DIR" \
  --host "$HOST" --port "$PORT" "${MIGRATE_ARGS[@]}" "${AUTH_ARGS[@]}" &
SERVER_PID=$!
wait "$SERVER_PID"

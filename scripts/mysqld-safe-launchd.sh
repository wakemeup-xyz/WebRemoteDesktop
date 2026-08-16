#!/bin/bash
# Keep a single mysqld via mysqld_safe, matching mysql.server's pid convention:
#   $datadir/$(hostname).pid
# If that instance is already up (the 62-day 51114 lineage), wait on it instead
# of starting a second server against the same datadir.
set -euo pipefail

MYSQL_HOME=/usr/local/mysql
DATADIR="$MYSQL_HOME/data"
PIDFILE="$DATADIR/$(hostname).pid"
SAFE="$MYSQL_HOME/bin/mysqld_safe"

alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_from_file() {
  [ -s "$PIDFILE" ] || return 0
  tr -d '[:space:]' < "$PIDFILE"
}

wait_existing() {
  local pid="$1"
  echo "mysqld already running pid=$pid pidfile=$PIDFILE; waiting"
  while alive "$pid"; do
    sleep 5
  done
  echo "existing mysqld pid=$pid exited"
}

if [ ! -x "$SAFE" ]; then
  echo "missing $SAFE" >&2
  exit 1
fi

existing="$(pid_from_file || true)"
if alive "$existing"; then
  wait_existing "$existing"
  # Let launchd KeepAlive start a fresh mysqld_safe.
  exit 0
fi

echo "starting mysqld_safe --datadir=$DATADIR --pid-file=$PIDFILE"
exec "$SAFE" --datadir="$DATADIR" --pid-file="$PIDFILE"

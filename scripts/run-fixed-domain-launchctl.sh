#!/bin/bash
set -euo pipefail

# launchd passes literal parameters; no login shell or configuration expansion.
if [ "$#" -ne 4 ]; then
  echo "formal wrapper requires binary, config, protocol and tunnel name" >&2
  exit 2
fi
case "$3" in
  http2|quic) ;;
  *) echo "formal wrapper requires http2 or quic" >&2; exit 2 ;;
esac
case "$1:$2" in
  /*:/*) ;;
  *) echo "formal wrapper requires absolute binary and config paths" >&2; exit 2 ;;
esac
unset TUNNEL_TOKEN TUNNEL_TOKEN_FILE
exec "$1" tunnel --config "$2" --protocol "$3" run "$4"

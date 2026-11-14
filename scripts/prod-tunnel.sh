#!/usr/bin/env bash
#
# Opens an SSH tunnel to the production database, for running a migration from
# a developer checkout.
#
# ## Why this is a script and not a line in a runbook
#
# The runbooks used to print a one-liner with `<rds-endpoint>` to substitute by
# hand. Fetching that value instead turned out to have three separate traps,
# each of which produced a tunnel that looked fine and went nowhere:
#
#   1. `grep | head | cut` takes its exit status from `cut`, which succeeds on
#      empty input - so a failed read sailed past `&&` and built
#      `-L 13306::3306`.
#   2. `ssh -t` merges the remote's stderr into stdout, so the text
#      "grep: ...: No such file or directory" became the hostname and ssh
#      rejected the forwarding spec.
#   3. A `case` pattern containing `[!a-z...]` is history-expanded by
#      interactive zsh: `!a` became the user's last `aws` command and the
#      shell refused to parse the line at all.
#
# None of those are interesting problems and all of them cost a round trip.
# A file has none of them, can be read before it is run, and fails loudly.
#
# Usage:
#   scripts/prod-tunnel.sh          # open, verify, and report
#   scripts/prod-tunnel.sh --close  # close whatever is holding the local port
#
# Environment overrides: SSH_HOST, ENV_PATH, LOCAL_PORT.
set -euo pipefail

SSH_HOST="${SSH_HOST:-offersoffer}"
ENV_PATH="${ENV_PATH:-/srv/offersoffer/TOY-backend/.env.production}"
LOCAL_PORT="${LOCAL_PORT:-13306}"

die() { printf 'prod-tunnel: %s\n' "$1" >&2; exit 1; }

if [ "${1:-}" = "--close" ]; then
  # Matching the local port is enough; the endpoint is not needed to close it.
  if pkill -f "${LOCAL_PORT}:.*:3306" 2>/dev/null; then
    echo "closed the tunnel on 127.0.0.1:${LOCAL_PORT}"
  else
    echo "no tunnel was holding 127.0.0.1:${LOCAL_PORT}"
  fi
  exit 0
fi

# Refuse to stack tunnels: a stale one on the same port silently wins, and
# then it is the stale one the migration talks to.
if lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  die "something already listens on 127.0.0.1:${LOCAL_PORT}. Run --close first."
fi

# stderr is discarded rather than merged: see trap 2 above. `sudo -n` fails
# instead of waiting for a password nobody can type.
raw="$(ssh "$SSH_HOST" "sudo -n cat ${ENV_PATH}" 2>/dev/null | sed -n 's/^DB_HOST=//p' | head -1 || true)"

# Drop surrounding quotes, then trim the ends only.
#
# Internal whitespace is deliberately left in place. An earlier version
# stripped every space before validating, which let "Permission denied"
# through: with its space removed it is all letters, and all letters passes a
# hostname character check. The space is the evidence that it is prose rather
# than a hostname, so it has to survive to be caught.
#
# `[![:space:]]` is safe in a file - history expansion is an interactive-shell
# behaviour, which is the third reason this is a script and not a one-liner.
host="${raw//[\"\']/}"
host="${host#"${host%%[![:space:]]*}"}"
host="${host%"${host##*[![:space:]]}"}"

[ -n "$host" ] || die "DB_HOST came back empty. Check ENV_PATH=${ENV_PATH}, and that 'sudo -n cat' is permitted for your login on ${SSH_HOST}."

# Validated by what it *is*, not by what it is not: strip every character a
# hostname may contain, and anything left over means this is not a hostname.
leftover="${host//[a-zA-Z0-9.-]/}"
[ -z "$leftover" ] || die "DB_HOST is not a hostname - it contains characters a hostname cannot. Read ${ENV_PATH} by hand and check it."

# And it must be qualified. Every RDS endpoint is; a bare word that survived
# the check above almost certainly came from an error message.
case "$host" in
  *.*) ;;
  *) die "DB_HOST has no dot in it, so it is not an RDS endpoint. Read ${ENV_PATH} by hand and check it." ;;
esac

echo "read DB_HOST from ${SSH_HOST} (${#host} characters, not printed)"
ssh -f -N -L "${LOCAL_PORT}:${host}:3306" "$SSH_HOST" || die "ssh refused the forward"

# A listening port is not a working tunnel. The only proof is MySQL's own
# greeting coming back down it.
echo -n "verifying... "
node -e '
const net = require("net");
const port = Number(process.argv[1]);
const socket = net.createConnection({ host: "127.0.0.1", port });
socket.setTimeout(8000);
socket.on("data", (data) => {
  const end = data.indexOf(0, 5);
  console.log("MySQL " + data.subarray(5, end > 5 ? end : 13) + " - tunnel is live");
  socket.destroy();
  process.exit(0);
});
socket.on("timeout", () => {
  console.log("no greeting in 8s - the forward goes nowhere");
  socket.destroy();
  process.exit(1);
});
socket.on("error", (error) => {
  console.log(error.code + " - the forward is not usable");
  process.exit(1);
});
' "$LOCAL_PORT" || die "the tunnel is open but does not reach MySQL. Run --close and check DB_HOST."

echo
echo "Ready. Run the migration with:"
echo
echo '  cd '"$(pwd)"' \'
echo '    && export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" \'
echo '    && read -rsp "offers_migrate_prod password: " MIGPW && echo \'
echo '    && DB_HOST=127.0.0.1 DB_PORT='"${LOCAL_PORT}"' DB_NAME=offers_production \'
echo '       DB_USER=offers_migrate_prod DB_PASSWORD="$MIGPW" node src/db/migrate.js; unset MIGPW'
echo
echo "Then close it with: scripts/prod-tunnel.sh --close"

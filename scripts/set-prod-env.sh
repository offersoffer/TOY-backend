#!/usr/bin/env bash
#
# Sets variables in `.env.production`, on the production host, without an
# editor and without putting their values in a shell history or a process list.
#
# ## Why this exists
#
# Three attempts at configuring production by hand went wrong in three ways.
# `REDIS_URL` and the Razorpay keys were both edited on a developer laptop,
# where `.env` is the dev environment and production never reads it. The file
# that matters is this one, on the server, owned by `offers` and mode 0600, so
# an edit as any other login is refused - silently, if the editor does not say
# so. And a one-liner that pipes a secret through `ssh` leaves it in the
# command line, visible in `ps` on both machines.
#
# Run it on the server, as the owning user:
#
#   ssh -t offersoffer "sudo -u offers bash -lc \
#     'cd /srv/offersoffer/TOY-backend && ./scripts/set-prod-env.sh NAME [NAME...]'"
#
# It prompts for each value with the characters hidden, writes a timestamped
# backup first, then prints what the application resolves - masked - so the
# change is confirmed rather than assumed.
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.production}"

die() { printf 'set-prod-env: %s\n' "$1" >&2; exit 1; }

[ $# -gt 0 ] || die "name at least one variable, e.g. RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET"
[ -f "$ENV_FILE" ] || die "no $ENV_FILE here. Run this from the application directory on the server, not from a laptop checkout."
[ -w "$ENV_FILE" ] || die "$ENV_FILE is not writable by $(id -un). It is owned by the service user; run this under 'sudo -u <that user>'."

# A backup before any change, named so several in one day do not collide.
BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
printf 'backed up to %s\n\n' "$BACKUP"

for NAME in "$@"; do
  case "$NAME" in
    [A-Z_][A-Z0-9_]*) ;;
    *) die "'$NAME' is not a variable name" ;;
  esac

  # Hidden input, read into a variable rather than taken as an argument, so the
  # value never reaches a command line or the shell's history.
  printf '%s = ' "$NAME"
  IFS= read -rs VALUE < /dev/tty
  printf '\n'

  if [ -z "$VALUE" ]; then
    printf '  skipped (nothing entered)\n'
    continue
  fi

  # Written with awk rather than sed: the value may contain any of sed's
  # delimiter characters, and escaping it correctly for every possible secret
  # is not a thing worth getting almost right.
  TMP="$(mktemp)"
  NAME="$NAME" VALUE="$VALUE" awk '
    BEGIN { name = ENVIRON["NAME"]; value = ENVIRON["VALUE"]; done = 0 }
    # Match the assignment even with leading spaces, which dotenv ignores.
    $0 ~ "^[[:space:]]*" name "=" && !done { print name "=" value; done = 1; next }
    { print }
    END { if (!done) print name "=" value }
  ' "$ENV_FILE" > "$TMP"

  cat "$TMP" > "$ENV_FILE"   # preserves the original owner and 0600 mode
  rm -f "$TMP"
  printf '  set (%d characters)\n' "${#VALUE}"
  unset VALUE
done

printf '\nWhat the application now resolves:\n'
NODE_ENV=production node -e '
const env = require("./src/config/env");
const show = (label, value) => {
  const text = value === null || value === undefined || value === "" ? "(empty)" : String(value);
  // Key ids are not secret and the prefix is the useful part; everything else
  // is reported as set or not, never printed.
  console.log("  " + label.padEnd(24) + (label.endsWith("id") ? text : (text === "(empty)" ? "(empty)" : "set, " + text.length + " characters")));
};
show("razorpay key id", env.razorpay.keyId);
show("razorpay key secret", env.razorpay.keySecret);
show("razorpay webhook secret", env.razorpay.webhookSecret);
console.log("  " + "razorpay plan ids".padEnd(24) + JSON.stringify(env.razorpay.planIds));
console.log("  " + "redis url".padEnd(24) + (env.cache.redisUrl ? "set" : "(empty)"));
' || printf '  (could not load the app config; check the file by hand)\n'

printf '\nRestart before any of this takes effect: the environment is read once, at boot.\n'

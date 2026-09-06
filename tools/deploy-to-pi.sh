#!/bin/bash
#
# This file is part of RPi-Monitor project
#
# Deploy the web interface (and optionally the configuration templates) from a
# working tree to a running RPi-Monitor install, taking a restorable backup of
# whatever it replaces.
#
# The daemon serves its web root straight off disk on every request, so web
# assets take effect on the next browser refresh with no restart. Configuration
# templates are parsed at startup and do need one.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

set -euo pipefail

PROG="$(basename "$0")"
BACKUP_DIR=/var/backups/rpimonitor
DEFAULT_WEBROOT=/usr/share/rpimonitor/web
TEMPLATE_DIR=/etc/rpimonitor/template

# defaults
DO_WEB=1 DO_TPL=0 DRY=0 ASSUME_YES=0 RESTART=0 DELETE=0
KEEP=10 SSH_PORT=22 SOURCE="" TARGET="" ROLLBACK="" LIST=0

die()  { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn:\033[0m %s\n' "$*" >&2; }

usage() {
  cat <<EOF
Usage: $PROG [OPTIONS] [user@]host

Copy the RPi-Monitor web interface from a working tree to a live Pi, backing
up what it replaces so the change can be undone.

Options:
  -t, --templates     also deploy etc/rpimonitor/template (implies --restart)
  -a, --all           web interface + templates
  -n, --dry-run       report what would change; change nothing
  -y, --yes           do not prompt for confirmation
  -R, --restart       restart rpimonitord when finished
      --delete        delete remote files absent from the source tree
                      (off by default: custom add-ons often live in the web root)
  -l, --list          list backups held on the Pi, then exit
  -b, --rollback ID   restore a backup ('latest' or an ID from --list)
  -k, --keep N        number of backups to retain (default: $KEEP)
  -s, --source DIR    repository root (default: inferred from this script)
  -p, --port N        ssh port (default: $SSH_PORT)
  -h, --help          this message

Examples:
  $PROG pi@raspberrypi.local              # web assets, backed up
  $PROG -n pi@raspberrypi.local           # preview the diff, touch nothing
  $PROG -a -y pi@raspberrypi.local        # web + templates + restart
  $PROG -l pi@raspberrypi.local           # what backups exist
  $PROG -b latest pi@raspberrypi.local    # undo the last deploy

Requires passwordless sudo on the Pi (the default for the 'pi' user on
Raspberry Pi OS). Without it, rsync cannot elevate and the run will abort
before changing anything.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--templates) DO_TPL=1; RESTART=1 ;;
    -a|--all)       DO_TPL=1; DO_WEB=1; RESTART=1 ;;
    -n|--dry-run)   DRY=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    -R|--restart)   RESTART=1 ;;
    --delete)       DELETE=1 ;;
    -l|--list)      LIST=1 ;;
    -b|--rollback)  ROLLBACK="${2:-latest}"; shift ;;
    -k|--keep)      KEEP="${2:?}"; shift ;;
    -s|--source)    SOURCE="${2:?}"; shift ;;
    -p|--port)      SSH_PORT="${2:?}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    -*)             die "unknown option: $1 (try --help)" ;;
    *)              [ -z "$TARGET" ] || die "unexpected argument: $1"; TARGET="$1" ;;
  esac
  shift
done

[ -n "$TARGET" ] || { usage >&2; exit 1; }
command -v rsync >/dev/null || die "rsync is not installed locally"

SSH=(ssh -p "$SSH_PORT" -o BatchMode=no -o ConnectTimeout=10 "$TARGET")
RSH="ssh -p $SSH_PORT"

# ---------------------------------------------------------------- source tree
if [ -z "$SOURCE" ]; then
  SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
[ -f "$SOURCE/src/usr/share/rpimonitor/web/status.html" ] \
  || die "$SOURCE does not look like an RPi-Monitor tree (no src/usr/share/rpimonitor/web/status.html)"
SRC_WEB="$SOURCE/src/usr/share/rpimonitor/web"
SRC_TPL="$SOURCE/src/etc/rpimonitor/template"

# ------------------------------------------------------------------ reachable
say "checking $TARGET"
"${SSH[@]}" true 2>/dev/null || die "cannot ssh to $TARGET"

REMOTE_WEBROOT="$("${SSH[@]}" "sed -n 's/^[[:space:]]*daemon\.webroot[[:space:]]*=[[:space:]]*//p' \
  /etc/rpimonitor/daemon.conf 2>/dev/null | tail -1" || true)"
REMOTE_WEBROOT="${REMOTE_WEBROOT:-$DEFAULT_WEBROOT}"

"${SSH[@]}" "test -d '$REMOTE_WEBROOT'" \
  || die "web root '$REMOTE_WEBROOT' not found on $TARGET -- is RPi-Monitor installed?"
say "remote web root: $REMOTE_WEBROOT"

if ! "${SSH[@]}" "sudo -n true" 2>/dev/null; then
  die "passwordless sudo unavailable on $TARGET; cannot write to $REMOTE_WEBROOT"
fi

# --------------------------------------------------------------------- --list
if [ "$LIST" = 1 ]; then
  say "backups on $TARGET"
  "${SSH[@]}" "sudo ls -1sh '$BACKUP_DIR' 2>/dev/null | grep -v '^total' || echo '  (none)'"
  exit 0
fi

# ----------------------------------------------------------------- --rollback
if [ -n "$ROLLBACK" ]; then
  if [ "$ROLLBACK" = latest ]; then
    ROLLBACK="$("${SSH[@]}" "sudo ls -1 '$BACKUP_DIR'/*.tar.gz 2>/dev/null | tail -1" || true)"
    [ -n "$ROLLBACK" ] || die "no backups found in $BACKUP_DIR on $TARGET"
  else
    ROLLBACK="$BACKUP_DIR/$ROLLBACK"
    "${SSH[@]}" "sudo test -f '$ROLLBACK'" || die "no such backup: $ROLLBACK"
  fi
  say "restoring $(basename "$ROLLBACK")"
  if [ "$DRY" = 1 ]; then
    "${SSH[@]}" "sudo tar tzf '$ROLLBACK' | head -20; echo '  ... (dry run, nothing restored)'"
    exit 0
  fi
  if [ "$ASSUME_YES" != 1 ]; then
    read -r -p "Restore this backup over the live install? [y/N] " a
    [[ "$a" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
  fi
  "${SSH[@]}" "sudo tar xzf '$ROLLBACK' -C /" || die "restore failed"
  say "restored. restarting daemon"
  "${SSH[@]}" "sudo systemctl restart rpimonitor 2>/dev/null \
               || sudo /etc/init.d/rpimonitor restart >/dev/null 2>&1 || true"
  say "done -- hard-refresh the browser (assets are cached)"
  exit 0
fi

# ------------------------------------------------------------------- plan/diff
RSYNC_COMMON=(-a --no-owner --no-group --itemize-changes --human-readable
              --rsh="$RSH" --rsync-path="sudo rsync")
if [ "$DELETE" = 1 ]; then RSYNC_COMMON+=(--delete); fi

say "changes that would be applied:"
CHANGED=0
preview() { # src/ dest
  local out
  out="$(rsync "${RSYNC_COMMON[@]}" --dry-run "$1" "$TARGET:$2" | grep -v '^sending\|^total\|^$' || true)"
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | sed 's/^/    /'
    CHANGED=1
  else
    printf '    (%s: already up to date)\n' "$2"
  fi
}
if [ "$DO_WEB" = 1 ]; then preview "$SRC_WEB/" "$REMOTE_WEBROOT/"; fi
if [ "$DO_TPL" = 1 ]; then preview "$SRC_TPL/" "$TEMPLATE_DIR/"; fi

if [ "$CHANGED" = 0 ]; then
  say "nothing to do"
  exit 0
fi
if [ "$DRY" = 1 ]; then
  say "dry run -- nothing was changed"
  exit 0
fi
if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "Apply these changes to $TARGET? [y/N] " a
  [[ "$a" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
fi

# ---------------------------------------------------------------------- backup
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/$STAMP.tar.gz"
PATHS=()
if [ "$DO_WEB" = 1 ]; then PATHS+=("${REMOTE_WEBROOT#/}"); fi
if [ "$DO_TPL" = 1 ]; then PATHS+=("${TEMPLATE_DIR#/}"); fi

say "backing up to $ARCHIVE"
"${SSH[@]}" "sudo mkdir -p '$BACKUP_DIR' && sudo tar czf '$ARCHIVE' -C / ${PATHS[*]}" \
  || die "backup failed -- nothing was deployed"
"${SSH[@]}" "sudo test -s '$ARCHIVE'" || die "backup archive is empty -- refusing to deploy"
say "backup ok ($("${SSH[@]}" "sudo du -h '$ARCHIVE' | cut -f1"))"

# ---------------------------------------------------------------------- deploy
if [ "$DO_WEB" = 1 ]; then
  say "deploying web interface"
  rsync "${RSYNC_COMMON[@]}" "$SRC_WEB/" "$TARGET:$REMOTE_WEBROOT/" >/dev/null
fi
if [ "$DO_TPL" = 1 ]; then
  say "deploying configuration templates"
  rsync "${RSYNC_COMMON[@]}" "$SRC_TPL/" "$TARGET:$TEMPLATE_DIR/" >/dev/null
fi

"${SSH[@]}" "sudo chown -R root:root '$REMOTE_WEBROOT'" 2>/dev/null || true

# ---------------------------------------------------------------------- verify
if [ "$DO_WEB" = 1 ]; then
  local_sum="$(cd "$SRC_WEB" && find . -type f ! -path './.*' -exec cksum {} + | awk '{print $1,$2}' | sort | cksum)"
  remote_sum="$("${SSH[@]}" "cd '$REMOTE_WEBROOT' && sudo find . -type f ! -path './.*' -exec cksum {} + | awk '{print \$1,\$2}' | sort | cksum")"
  if [ "$local_sum" = "$remote_sum" ]; then
    say "verified: web root matches the source tree"
  elif [ "$DELETE" = 1 ]; then
    warn "checksum mismatch after deploy -- inspect $REMOTE_WEBROOT"
  else
    say "deployed (remote has extra files; re-run with --delete to mirror exactly)"
  fi
fi

# --------------------------------------------------------------------- restart
if [ "$RESTART" = 1 ]; then
  say "restarting rpimonitord"
  "${SSH[@]}" "sudo systemctl restart rpimonitor 2>/dev/null \
               || sudo /etc/init.d/rpimonitor restart >/dev/null 2>&1 || true"
  sleep 2
  if "${SSH[@]}" "pgrep -f rpimonitord >/dev/null"; then
    say "daemon is running"
  else
    warn "daemon does not appear to be running -- check: journalctl -u rpimonitor -n 40"
  fi
fi

# ---------------------------------------------------------------------- prune
"${SSH[@]}" "sudo ls -1 '$BACKUP_DIR'/*.tar.gz 2>/dev/null | head -n -$KEEP | sudo xargs -r rm -f" || true

say "done"
cat <<EOF
    backup   : $ARCHIVE
    undo     : $PROG -b $STAMP.tar.gz $TARGET
    view     : http://${TARGET#*@}:8888/

Hard-refresh the browser (Ctrl/Cmd-Shift-R) -- the old CSS and icons are cached.
EOF

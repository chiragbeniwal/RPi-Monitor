# tools/

Helper scripts that are **not** installed by `make install`. They support
development, deployment and the optional reverse-proxy setup.

| Script | Purpose |
|---|---|
| `deploy-to-pi.sh` | Push a working tree's web interface to a live Pi, with backup and rollback |
| `conf2man.pl`, `help2man.pl` | Generate manpages during the docs build |
| `make_ca.sh`, `make_cert.sh`, `openssl.cnf` | Create a CA and server certificate for HTTPS |
| `addnginxuser.sh`, `reverseproxy` | nginx reverse-proxy auth (see docs chapter 34) |
| `netTraffic.sh` | Example network-traffic extraction script |

---

## deploy-to-pi.sh

Copies the web interface from a working tree to a running RPi-Monitor
installation, backing up whatever it replaces so the change can be undone.

Useful when iterating on the front end: the daemon serves its web root straight
off disk on every request, so web assets take effect on the next browser
refresh with **no restart and no package rebuild**.

### Requirements

* `rsync` on both machines (present by default on Raspberry Pi OS)
* SSH access to the Pi
* **Passwordless sudo on the Pi** — the default for the `pi` user. The script
  uses `rsync --rsync-path="sudo rsync"`, which cannot answer a password
  prompt, so it checks with `sudo -n true` up front and aborts before changing
  anything if sudo would prompt.

### Usage

```
./tools/deploy-to-pi.sh [OPTIONS] [user@]host
```

| Option | Effect |
|---|---|
| `-t`, `--templates` | Also deploy `etc/rpimonitor/template` (implies `--restart`) |
| `-a`, `--all` | Web interface **and** templates |
| `-n`, `--dry-run` | Report what would change; change nothing |
| `-y`, `--yes` | Do not prompt for confirmation |
| `-R`, `--restart` | Restart `rpimonitord` when finished |
| `--delete` | Delete remote files absent from the source tree |
| `-l`, `--list` | List backups held on the Pi, then exit |
| `-b`, `--rollback ID` | Restore a backup (`latest`, or an ID from `--list`) |
| `-k`, `--keep N` | Number of backups to retain (default 10) |
| `-s`, `--source DIR` | Repository root (default: inferred from the script's location) |
| `-p`, `--port N` | SSH port (default 22) |
| `-h`, `--help` | Full usage |

### Typical session

Preview first — this is a true dry run that goes all the way through rsync's
diff without writing anything:

```console
$ ./tools/deploy-to-pi.sh -n pi@raspberrypi.local
==> checking pi@raspberrypi.local
==> remote web root: /usr/share/rpimonitor/web
==> changes that would be applied:
    >f+++++++++ css/rpimonitor.theme.css
    >f.st....== css/rpimonitor.css
    >f.st....== index.html
    ...
==> dry run -- nothing was changed
```

Then apply:

```console
$ ./tools/deploy-to-pi.sh pi@raspberrypi.local
...
Apply these changes to pi@raspberrypi.local? [y/N] y
==> backing up to /var/backups/rpimonitor/20260907-143012.tar.gz
==> backup ok (1.2M)
==> deploying web interface
==> verified: web root matches the source tree

==> done
    backup   : /var/backups/rpimonitor/20260907-143012.tar.gz
    undo     : deploy-to-pi.sh -b 20260907-143012.tar.gz pi@raspberrypi.local
    view     : http://raspberrypi.local:8888/
```

**Hard-refresh the browser** (Ctrl/Cmd-Shift-R) afterwards — stylesheets and
icons are aggressively cached, and the pages set `Cache-control: public`.

### Backups and rollback

Before rsync touches anything, the live paths are tarred to
`/var/backups/rpimonitor/<timestamp>.tar.gz`. The archive is checked for
non-zero size, and the deploy aborts if either step fails. The last 10 are
kept (`--keep`).

```console
$ ./tools/deploy-to-pi.sh -l pi@raspberrypi.local     # what's available
$ ./tools/deploy-to-pi.sh -b latest pi@raspberrypi.local
```

Rollback restores over the live install and restarts the daemon. Pair it with
`-n` to list an archive's contents without extracting.

### Notes

* **`--delete` is opt-in.** Custom add-ons often live under the web root, and
  mirroring exactly would remove them. The default is additive; the verify step
  reports when the remote holds extra files.
* Templates are parsed at daemon **startup**, which is why `--templates`
  implies a restart. Web assets are not, which is why the default does not.
* The remote web root is read from `daemon.webroot` in the Pi's
  `/etc/rpimonitor/daemon.conf` rather than assumed.
* This deploys files over an existing installation without touching dpkg's
  records. `sudo apt-get install --reinstall rpimonitor` also restores the
  packaged state.

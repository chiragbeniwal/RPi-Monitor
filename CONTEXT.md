# RPi-Monitor — Codebase Context

> How this repository is put together, what runs where, and where to touch things.
> Written against `develop` @ `8ff2d07`, VERSION `2.13`.

---

## 1. What this is

**RPi-Monitor** is a self-contained monitoring appliance for single-board computers (Raspberry Pi first, but Allwinner/Orange Pi/Arch/Xbian/Raspbmc profiles ship too). One Perl daemon (`rpimonitord`) scrapes KPIs out of `/proc`, `/sys` and shell commands, stores time-series in RRD files, and serves a Bootstrap 3 web UI plus JSON endpoints from its own embedded HTTP server. Optionally it also speaks SNMP and fires alert commands.

Everything interesting is driven by **flat `key=value` config files** — including the entire web UI. There is no build step for the frontend, no bundler, no framework. Config strings are shipped to the browser and `eval()`'d as JavaScript expressions.

- ~256 files, ~700 commits since 2013-04-22, overwhelmingly by Xavier Berger.
- Single active branch: `develop` (PRs target `develop`, not `master`).
- License: GPLv3.
- Docs live in `docs/` (Sphinx) and are published to `xavierberger.github.io/RPi-Monitor-docs/`.

---

## 2. Repository map

```
src/                          # everything that gets installed, mirroring the target filesystem
  usr/bin/rpimonitord         # THE daemon — 1566 lines of Perl, 6 packages in one file
  usr/share/rpimonitor/
    web/                      # the entire web UI (served by the daemon)
      *.html                  # 4 pages: index, status, statistics, addons
      js/rpimonitor*.js       # ~900 lines of app code; the rest is vendored libs
      css/rpimonitor.css      # 122 lines of custom CSS on top of Bootstrap 3.2.0
      addons/{about,custom,example,top3}/
      img/, fonts/
    scripts/                  # side-car helper daemons + package-update checker
  etc/rpimonitor/
    data.conf                 # the include manifest — this is the "what do I monitor" file
    daemon.conf               # runtime options (port, user, intervals, SNMP)
    template/*.conf           # ~48 shipped KPI/UI templates
  etc/{init.d,init,cron.d,snmp,apt}/  # sysVinit, upstart, cron, snmp glue
  usr/lib/systemd/system/     # systemd units
  var/lib/rpimonitor/         # datastore (RRD files land in stat/ at runtime)
tools/                        # TLS cert generation, nginx reverse proxy, legacy man-page generators
docs/                         # Sphinx documentation (rtd theme via git submodule)
Makefile                      # install only — TARGETDIR + STARTUPSYS
```

---

## 3. Runtime architecture

### 3.1 Process model

`main` (`src/usr/bin/rpimonitord:1516-1566`) is a supervisor loop that forks **two long-lived children**:

```
rpimonitord (supervisor)
├── Server  child   — HTTP::Daemon, single-threaded accept loop, drops to daemon.user/group
└── Monitor child   — the scrape/alert/publish loop
```

- The supervisor `waitpid`s on Monitor. When Monitor exits it `kill -9`s Server and restarts **both** (`:1556-1565`).
- Monitor watches Server with `kill(0,$serverpid) or last` (`:700`) — if the web server dies, Monitor breaks its loop, which cascades into a full respawn. Self-healing in both directions.
- Crash-loop guard: two respawns inside 2 seconds is fatal (`:1547`).
- `-b <pidfile>` triggers `daemonize()` (`:1434-1444`): chdir /, redirect stdio, fork, `setsid`, `umask 0`. Note `writePID()` **appends** (`:1428-1432`), so the pidfile holds a space-separated list of PIDs.

**Signals:** `SIG{CHLD}='IGNORE'` (auto-reap). `SIGINT` → `stop()` sets `daemon.delay=0`, which both loops treat as "shut down". `SIGUSR1`/`SIGUSR2` raise/lower `$loglevel` live (`:1537-1538`) — `killall -USR1 rpimonitord` to get verbose logging without a restart.

### 3.2 IPC — one shared memory segment

`IPC::ShareLite` keyed on `daemon.sharedmemkey` (default `20130906`, `:108`), created with `-destroy => 'no'` so it survives restarts (`:188-192`).

- **Monitor writes**: the serialized `dynamic.json` payload, every cycle (`Monitor::Status`, `:842`).
- **Server reads**: on every `GET /dynamic.json` (`SendStatus`, `:375`).
- **SNMP agent reads**: the same segment, every 10s refresh (`:1315`).

That's the whole IPC story — the HTTP server never talks to the scraper directly.

### 3.3 The scrape loop and interval math

`Monitor::Run` (`:631-711`) per iteration: `Process('dynamic')` → `Alert()` → `Status()` → `sleep daemon.delay` (default 10s).

Per-KPI throttling: each `dynamic.N` may set `.interval` (default `daemon.defaultinterval`, 1). A counter increments each cycle and a KPI is skipped unless `counter % interval == 0` (`:749`). The counter wraps at `maxinterval`, folded across all configured intervals by `GreatestCommonDivisor` (`:56-70`, an additive-GCD, O(lcm) — fine for small integers) during config load (`:173-180`). So `.interval=3` means "every 3rd poll cycle", i.e. every 30s at the default delay.

### 3.4 Data extraction

Each `static.N` / `dynamic.N` block is: `name` (comma-separated output KPI names), `source`, `regexp`, `postprocess`, `default`, plus `rrd`/`min`/`max`/`interval` for dynamic.

`Monitor::Process` (`:739-802`):
1. **Source is a command or a file** — decided by `-x $1` / `which($1)` on the first token (`:751-758`). Commands become `"$cmd 2>/dev/null |"` and are first run through `ParseCommand`; files are opened directly.
2. **`ParseCommand`** (`:713-737`) substitutes `data.<kpi>` (any previously extracted static or dynamic value) and `data.alert.<name>.<field>` into the command string. This is also used for alert expressions.
3. **Regexp** captures into `@values` (list context, so multiple groups → multiple KPIs). Guarded by `alarm daemon.timeout` (default 5s); on timeout the child is `kill -9`'d (`:764,774,798`).
4. **`postprocess`** is a comma-separated list of Perl expressions aligned by index with `name`, `eval`'d with `$1` rebound to the captured value (`:777-796`). e.g. `sprintf("%.2f",$1/1000)`.
5. Missing capture falls back to `default`.

`Monitor::Status` (`:826-868`) appends `localtime` as `[y,mon,mday,h,m,s]`, JSON-encodes, stores to shared memory, and `RRDs::update`s every registered RRD (`"N:$value"`, or `"N:U"` if not numeric).

**RRD schema** (`Configuration::CreateRRD`, `:278-315`) — 5 RRAs per file, which is exactly the "Graph n°1..5" dropdown in the UI:

| RRA | resolution | span |
|---|---|---|
| 1 | 10 s | 1 day |
| 2 | 1 min | 2 days |
| 3 | 10 min | 2 weeks |
| 4 | 30 min | 1 month |
| 5 | 1 hour | 1 year |

### 3.5 HTTP server

`package Server` (`:316-599`). `HTTP::Daemon` bound to `daemon.addr:daemon.port` (default `0.0.0.0:8888`), then immediately `setgid`/`setuid` to `daemon.user`/`daemon.group` (default `pi`/`pi`, `:582-583`) — binds privileged, serves unprivileged.

**Routing** (`DoGET`, `:408-477`) is an allowlist. `Server::Run` builds `@paths` from a hardcoded manifest of every UI asset (`:492-546`) plus globbed `img/*.png` and the live RRD list. Requests are suffix-matched against it (`:423`). Two escape hatches: `.rrd` files that don't exist redirect to `stat/empty.rrd` (`:432-437`), and anything matching `/addons/<name>/<file>.(js|html|css)` is allowed unconditionally (`:441-444`) so third-party addons work without re-registration.

**JSON endpoints** are almost all served by one generic line — `NAME.json` → `SendJSON($this->{NAME})` (`:454`) — where the payloads were pre-serialized once at server start (`:558-570`):

| Endpoint | Contents | Freshness |
|---|---|---|
| `dynamic.json` | live KPI values + `localtime` | read from shared memory per request |
| `static.json` | boot-time KPIs, **plus the whole `alert` config** (`:562`) | frozen at start |
| `status.json` | status-page widget definitions (`web.status`) | frozen |
| `statistics.json` | chart definitions (`web.statistics`) | frozen |
| `menu.json` | page titles for the navbar | frozen |
| `page.json` | icon / menutitle / pagetitle | frozen |
| `addons.json`, `friends.json` | addon + friend-link config | frozen |
| `version.json` | `{"version": <config load timestamp>}` — **cache-buster, not a semver** (`:95`) | frozen |
| `all.json` | the **entire merged configuration object** (`:566-569`) | frozen |

`/` → `index.html` → immediately rewritten to `status.html` (`:463-466`, comment: *"until login screen is implemented"*).

**There is no authentication anywhere in the daemon.** No credentials, no sessions, no TLS. The only access control is the path allowlist. `all.json` in particular exposes the full config tree — including every `alert.*.raisecommand` shell string — to anyone who can reach the port. TLS/basic-auth is expected to be bolted on outside, via `tools/reverseproxy` (nginx) + `tools/addnginxuser.sh`.

Also: only `DoGET` exists. Any other method is silently dropped.

### 3.6 Alerts

`Monitor::Alert` (`:870-925`), evaluated every cycle for each named `alert.<name>` block. Both `active` (a gate) and `trigger` are `ParseCommand`-expanded then `eval`'d as Perl.

State lives in `dynamic.alert.<name>.*` — so alert state is visible to the browser via `dynamic.json`, and alert *definitions* via `static.json`.

Debounce on both edges:
- fire `raisecommand` only after the trigger has held for `maxalertduration`, and re-fire at most every `resendperiod` (`:898-904`);
- fire `cancelcommand` only after the trigger has been false for `cancelvalidation` (`:915-922`).

`SendAlarm` (`:804-824`) runs the command via `open(CMD, "$cmd |")` under the same alarm/kill-9 guard. **The Monitor process never drops privileges** (unlike Server), so alert commands run as whoever started the daemon — root under init.d.

### 3.7 SNMP

Only active when the binary is invoked as `rpimonitord-snmp` (`:1522`), which is how `snmpd.conf.rpimonitor` wires it: `pass_persist .1.3.6.1.4.1.54321 /usr/bin/rpimonitord-snmp`. `SNMP::Extension::PassPersist` with a 10s refresh reads the same shared memory segment. Which KPIs are exported is controlled by `snmp.<name>.id/type/description/postprocess` blocks (only `cpu.conf` and `version.conf` ship any). `rpimonitord --mib` prints a generated ASN.1 MIB.

### 3.8 Modes worth knowing

- **`daemon.noserver=1`** — don't fork the HTTP server; instead Monitor writes all the JSON files straight into `webroot` (`:639-674`, `:845-852`) for Apache/nginx to serve.
- **`daemon.readonly=1`** — no RRD writes, no JSON on disk, and the served path list shrinks to just `static.json`/`dynamic.json`. Intended for a collector node scraped over SNMP.

### 3.9 Side-car scripts (`src/usr/share/rpimonitor/scripts/`)

These are **not** invoked by the daemon. They're independent processes that write files into `/tmp` or `/var/lib`, which `dynamic.N.source=` then reads as plain files.

- `rpimonitor-helper.sh` — Allwinner H3 DVFS/VCore + CPU-load + disk-temp daemon. Parses `/boot/script.bin`, writes `/tmp/VCore`, `/tmp/cpustat`, `/tmp/disktemp`. Apt-installs its own dependencies on first run. Started via `rpimonitor-helper.init` (which expects it at `/usr/local/sbin/`, mismatching the packaged path).
- `sunxi-temp-daemon.sh` — A20/AXP209 equivalent; requires root; shipped as a systemd unit.
- `updatePackagesStatus.pl` — runs `aptitude search ~U` (or `checkupdates` on Arch), writes `/var/lib/rpimonitor/updatestatus.txt`, which `version.conf` reads. Triggered **four** redundant ways: cron.d, a systemd timer at 03:10, an APT `Post-Invoke` hook installed by `init.d ... install_auto_package_status_update`, and the init script's `update` action.

---

## 4. Configuration system

### 4.1 The dotted-key parser

`Configuration::LoadFile` (`:195-276`) turns lines like `web.status.1.content.3.line.2=...` into nested Perl structures. Walking the dotted key two leaves at a time: a numeric *next* leaf means the current level is an **array**, otherwise a **hash**. Config indices are 1-based, internal arrays 0-based, hence the pervasive `-1`.

Two behaviours that are easy to miss:

**`include=` is a queue, not an inline splice** (`:207`). It appends to the same `confFiles` list the outer loop is iterating, so included files are loaded *after* the current one finishes, breadth-first.

**Per-file index renumbering** (`:239-253`) is what makes the whole template system work. `my @dict` is declared **per file**, while `$this->{counter}` persists across all files. For the roots `static`, `dynamic`, `addons`, and `status`/`statistics` content, the number written in the file is mapped through `@dict` to a globally incrementing slot. That's why every one of the 48 templates can independently start at `static.1` / `dynamic.1` and still concatenate rather than clobber each other.

**`$root` is re-derived for `web.*` and `alert.*`** (`:218-219`) — for `web.status.1...` the effective root is `status`, and for `alert.too_hot.*` it's `too_hot`. This is why alerts are keyed by name instead of index.

**RRD registration is a parse side-effect** (`:263`): seeing an `rrd` leaf with a truthy value pushes the enclosing `dynamic.N` hash onto `$this->{rrd}`, which later drives file creation and per-cycle updates.

### 4.2 Config roots

| Root | Meaning |
|---|---|
| `daemon.*` | port, addr, user/group, webroot, datastore, delay, defaultinterval, timeout, logfile, loglevel, noserver, readonly, sharedmemkey |
| `snmpagent.*` | MIB metadata (OIDs, organisation, revision) |
| `snmp.<name>.*` | export one KPI over SNMP |
| `static.N.*` | scraped once at startup |
| `dynamic.N.*` | scraped every cycle |
| `web.page.*` | navbar icon / menu title / page title |
| `web.status.<page>.content.<n>.*` | a status widget: `title`, `icon`, `visibility`, `line.N` |
| `web.statistics.<page>.content.<n>.*` | a chart: `title`, `graph.N`, `ds_graph_options.*`, `graph_options.*` |
| `web.addons.N.*` | an add-on panel |
| `web.friends.N.*` | links to other RPi-Monitor instances |
| `alert.<name>.*` | `active`, `trigger`, `maxalertduration`, `cancelvalidation`, `resendperiod`, `raisecommand`, `cancelcommand` |

### 4.3 `data.conf` — the manifest

`src/etc/rpimonitor/data.conf` contains no data of its own; it's three groups of `include=` lines:

- **lines 1-10** — all `example.*.conf` demos, commented out
- **lines 12-20** — the default active set: `addons`, `version`, `uptime`, `cpu`, `temperature`, `memory`, `swap`, `sdcard`, `network`
- **lines 22-30** — optional extras, commented out: `printer`, `storage`, `services` *(note: this file doesn't exist — dead reference)*, `chrony`, `wlan`, `dht11`, `entropy`, `weather`

Distro/board profiles (`raspbian.conf`, `arch.conf`, `xbian.conf`, `raspbmc.conf`, `OrangePi_H3.conf`, `sunxi_axp209.conf`) are alternative manifests of the same shape — swap `data.conf` for one of them.

### 4.4 Template catalogue (`src/etc/rpimonitor/template/`)

**Core (on by default):** `cpu` (freq/voltage/loadavg/governor), `temperature` (thermal_zone0), `memory` (uses `MemAvailable`), `swap`, `sdcard` (root + boot partitions), `network` (eth0 rx/tx as `DERIVE`), `uptime`, `version` (distro/kernel/firmware/pending upgrades), `addons`.

**Variants:** `memory_arch`, `memory_legacy` (kernels < 3.14 without `MemAvailable`), `cpu_arch`, `sdcard_raspbmc`, `sdcard_xbian`, `temperature_xbian` (`vcgencmd measure_temp`), `entropy`, `wlan`, `storage` (extra sda mounts), `printer` (ink levels).

**Board-specific:** `Allwinner_H3`, `Allwinner_H3_Extended` (per-core load, disk temp), `axp209_cpu_pmu_temp` (PMU voltages/consumption), plus the `sunxi_axp209` / `OrangePi_H3` profiles.

**Service/integration:** `advanced_service` (systemd unit status as an HTML table), `remote_service` (port checks via netstat), `chrony` (NTP offsets), `dht11` (temp+humidity sensor, adds a 2nd page), `tor` (relay bandwidth; uses `content.101+` offsets to dodge index collisions), `rclone`, `weather` (OpenWeatherMap, adds a 3rd page).

**`example.*` tutorials** — each demonstrates one UI feature and is the best documentation for it:

| File | Demonstrates |
|---|---|
| `example.justgage.conf` | circular gauges, custom colors, warn/crit thresholds |
| `example.progressbar.conf` | progress bars incl. inverted thresholds |
| `example.badge_and_label.conf` | `Label()` success/danger service badges |
| `example.alert.conf` | full alert lifecycle + rendering alert state |
| `example.header.conf` | custom page icon/title |
| `example.multipage.conf` | multiple status/statistics pages, `LinkToGraph()` |
| `example.visibility.conf` | conditional row visibility |
| `example.interval.conf` | per-KPI polling intervals |
| `example.postprocess_default.conf` | multi-capture postprocess + `default` fallback |
| `example.friends.conf` | cross-instance links |
| `example.addons.conf` | addon panel registration |

---

## 5. Web frontend

### 5.1 Pages and boot sequence

Four static HTML pages, each loading jQuery 2.1.1 → Bootstrap 3.2.0 → `rpimonitor.js` → a per-page script.

`rpimonitor.js` `$(function(){...})` (`js/rpimonitor.js:343-358`) runs on every page:
`getVersion()` → `AddTopmenu()` → `AddDialogs()` → `AddFooter()` → `UpdateMenu()`. The navbar, footer, and all three modals (Options / License / About) are **built as JS string concatenation** and injected into `#topmenu`, `#footer`, `#dialogs`. There is no server-side templating and almost no static markup.

Then each page's own ready handler runs: `rpimonitor.status.js:128`, `rpimonitor.statistics.js:229`, `rpimonitor.addons.js:45`, `rpimonitor.index.js:17`.

### 5.2 Data flow and caching

`getData(name)` (`js/rpimonitor.js:38-60`) caches each JSON blob in `localStorage[name]`, stamped with `localStorage[name+'Version']`. On every call the stamp is compared to `localStorage['version']` (set once per load from `version.json`). Match → the cached string is `eval()`'d back into an object; mismatch → a **synchronous** `$.ajax` refetch. The server bumping `version.json` invalidates every cached blob at once.

`dynamic.json` deliberately bypasses this and is always fetched live via `$.getJSON`.

### 5.3 The `eval()` templating engine — the core idea

`UpdateStatus()` (`js/rpimonitor.status.js:40-87`) is where the whole design lives:

```js
$.getJSON('dynamic.json', function(data) {
  $.extend(true, data, getData('static'));        // merge static into dynamic → `data`
  for (each strip) {
    eval('visibility = ' + strips[i].visibility)  // show/hide the row
    for (each line) text += "<p>" + eval(line) + "</p>";
    $("#Text"+i).html(text);
  }
  while (command = postProcessCommand.pop()) eval(command);  // instantiate gauges
  ActivatePopover();
})
```

Every `web.status.*.line.N` string from the config file is a **JavaScript expression evaluated with `data` in scope**. That's why config lines look like `'CPU: '+data.cpu_freq+'MHz'+ProgressBar(data.load,1,0.7,0.9)`. A line that throws renders `ERROR: <line> -> <exception>` inline instead of killing the page.

Two deferred queues make this work:
- **`postProcessCommand`** — `JustGageBar()` can't construct a gauge before its `<div>` exists, so it emits the div and queues the `new JustGage({...})` call as a string, drained after all HTML is written.
- **`postProcessInfo`** — `ShowInfo()` queues `[selector, title, content]` triples, drained by `ActivatePopover()`.

Refresh: the Options checkbox starts `setInterval(UpdateStatus, 10000)` plus a 1s `Tick()` that only advances the `#seconds` span, so the clock looks live between 10s polls.

Row order is drag-and-drop (Sortable 1.6.1, `.DragHandle`) and persisted to `localStorage['status-row-order']` as `data-id`s joined by `|` (`js/rpimonitor.status.js:178-201`).

### 5.4 Render helpers (`js/rpimonitor.utils.js`)

These are the functions config authors call from `line.N` expressions:

| Helper | Emits |
|---|---|
| `ProgressBar(value,max,warn,danger)` | `.progress > .progress-bar[.progress-bar-warning|-danger]` with inline `width:%`. Handles ascending *and* descending thresholds. |
| `JustGageBar(title,label,min,value,max,w,h,levelColors,warn,crit)` | `div.justgage#gaugeN` + queued JustGage constructor. Defaults to the global `percentColors` `["#a9d70b","#f9c802","#ff0000"]`. |
| `Label(data,formula,text,level)` | `<span class='label label-LEVEL'>` — via `eval("if("+data+formula+") ...")` |
| `Badge(data,formula,text,level)` | `<span class='badge alert-LEVEL'>` (Bootstrap 3 has no `alert-*` badge styling — the class is inert) |
| `Uptime(sec)` | bolded `Nd HH h MM m SS s` |
| `KMG(value,initPre)` | binary byte formatter → `"12.34MB"` |
| `Percent(v,total)` | `"XX.XX%"` |
| `ShowInfo(id,title,text)` | a glyphicon-search anchor + queued popover |
| `Clock(localtime)` / `Tick()` | `HH:MM:<span id='seconds'>SS</span>` + the 1s updater |
| `LinkToGraph(page,graph,text)` | link into `statistics.html?activePage=&graph=` |
| `InsertHTML(url)` | synchronous GET, returns raw body (used by the `top3` addon) |

### 5.5 Statistics page — RRD in the browser

The browser downloads the **raw `.rrd` binary files over HTTP** and parses them client-side. `FetchBinaryURLAsync` (`js/javascriptrrd/binaryXHR.js:208-234`) uses `overrideMimeType('text/plain; charset=x-user-defined')` so bytes survive as a JS string.

`rpimonitor.statistics.js` then:
1. For each series, decides static-vs-RRD: if `eval("static."+name)` resolves, it loads `stat/empty.rrd` instead of a real file (`:69-94`).
2. `PrepareGraph()` (`:152-175`) builds an `RRDFilterOp` where every series *except* the current one is a synthetic `Zero()` DS, and the current one is either `DoNothing()` (passthrough) or `SetValue()` (a flat line at the static value). Loading N series means N fetches, each filtered to contribute exactly one DS.
3. `RRDFileSum` merges them; `new rrdFlot("mygraph", ...)` renders.

`rrdFlot.js` builds its own DOM scaffold (`createHTML`, `:120-258`): resolution select, per-DS checkbox table, main graph, legend-position select, timezone select, a scaled overview graph, and a "Reset selection" button. Flot defaults are set in `bindFlotGraph` (`:489-498`) and deep-merged with config-supplied `graph_options`. Brush-to-zoom is wired between the main and overview plots.

The "Default graph timeline" option (Graph n°1..5) selects which RRA to read — mapping directly onto the five RRAs in §3.4.

### 5.6 Add-ons

`rpimonitor.addons.js:17-43` — for a configured addon `foo`, it does three things in parallel with no ordering guarantee: `.load()` `addons/foo/foo.html` into `#insertionPoint`, append a `<link>` for `addons/foo/foo.css` to `<head>`, and ajax-execute `addons/foo/foo.js`.

- **about** — static info panel.
- **custom** — a resizable `<iframe>` whose URL is set per-instance in the Options dialog and stored in `localStorage['customuri'+activePage]`; plus an optional `onbeforeunload` warning (built for embedding shellinabox / webcams).
- **example** — the reference implementation for addon authors; does its own `dynamic.json` poll.
- **top3** — the odd one out: a **Perl script** run by cron every minute that regenerates `top3.html` server-side. Intended to be consumed via `InsertHTML("/addons/top3/top3.html")` from a status line, not through the addons page.

### 5.7 Vendored libraries

| Library | Version |
|---|---|
| jQuery | 2.1.1 |
| Bootstrap | **3.2.0** |
| Flot | 0.7 (+ selection, stack, tooltip 0.4.4) |
| javascriptRRD | unversioned (sourceforge, 2009-2010) |
| Raphaël | 2.1.0 |
| JustGage | 1.0 (file named 1.0.1) |
| Sortable | 1.6.1 |
| jsqrencode | unversioned |

The QR code in the About dropdown encodes `document.URL` — including the query string — so scanning it on a phone lands on the exact page/tab being viewed.

---

## 6. Build, install, packaging

`make install` (`Makefile:27-58`) is a plain recursive copy of `src/` into `${TARGETDIR}`, then installs init files conditionally on `${STARTUPSYS}` (`sysVinit` | `upstart` | `systemd`). It depends on the `man` target, which delegates to `docs/Makefile` → `sphinx-build -b man` (the `man_pages` list is in `docs/source/conf.py:274-283`).

Gotchas:
- `docs/source/_themes/sphinx_rtd_theme` is a **git submodule** — `git submodule update --init` before building docs.
- `VERSION` (`2.13`) is **not** auto-synced into `docs/source/conf.py:60,141`; those are hand-edited.
- `src/usr/bin/rpimonitord:28` has `my $VERSION = "{DEVELOPMENT}";` and `js/rpimonitor.js:153` has the same token in the About dialog. **Nothing in this repo substitutes it** — that happens in an external Debian packaging pipeline (the apt repo is `https://giteduberger.fr rpimonitor/`, see `src/etc/apt/sources.list.d/rpimonitor.list`). Running from a git checkout, `rpimonitord -V` literally prints `{DEVELOPMENT}`.
- `tools/conf2man.pl` and `tools/help2man.pl` are legacy manual man-page generators, **not wired into any Makefile**.

`tools/`: `make_ca.sh` + `make_cert.sh` + `openssl.cnf` (local CA and server/client certs), `addnginxuser.sh` (htpasswd entry), `reverseproxy` (an nginx server block with HTTPS redirect, security headers, basic auth, proxying `/rpimonitor/` → `localhost:8888`), `netTraffic.sh` (per-interval bandwidth deltas).

---

## 7. Known rough edges

Found while reading; none are blockers, but they will bite:

1. `js/rpimonitor.js:54` — the ajax failure message concatenates `name.json` (property access → `undefined`) instead of `name+'.json'`.
2. `js/rpimonitor.status.js:153-157` — binds `#animate` and calls `SetProgressBarAnimate()`; neither the element nor the function exists. Dead code.
3. `addons/top3/top3.js:9` calls `UpdateAddon()`, defined only in `addons/example/example.js` → `ReferenceError` when the top3 addon page is opened.
4. `data.conf:24` includes `services.conf`, which doesn't exist in `template/`.
5. `Label()` call sites are inconsistent: some pass `"label-success"`, others bare `"success"` (the helper prefixes only if missing).
6. `ShowInfo()` emits mismatched `<font>`/`<span>` nesting; `Clock()` emits deliberately unbalanced `<b>` tags that rely on the surrounding strip.
7. `example.css` styles `#text`, an id that doesn't exist; `about.css` is empty.
8. `rpimonitor-helper.init` expects the script at `/usr/local/sbin/`, but `make install` puts it in `/usr/share/rpimonitor/scripts/`.
9. `init.d/rpimonitor` references `$CONFFILE`, which is never defined — expands to empty.
10. Security posture: no auth, `all.json` exposes the whole config including alert shell commands, Monitor runs alert commands as root, and `eval()` is used on config-supplied strings in both Perl and JS. Fine on a trusted LAN; put the nginx reverse proxy in front otherwise.

---

## 8. Dark mode — as built

Implemented on branch `feature/dark-mode`. This section documented the plan before the
work; it now documents the result. Four dark themes ship alongside the untouched light
default.

### 8.1 Starting position (before this change)

Greenfield. `git log --all -i --grep=dark|theme|night` and `-S` searches returned nothing;
there was no `prefers-color-scheme` query, no CSS custom property, and no theme class
convention anywhere in the tree. `css/bootstrap-theme.css` exists but **no HTML file links
it** — a dead asset, not a starting point.

The one piece of luck: the navbar and footer already used `.navbar-inverse` (`#222`), so the
page chrome was dark to begin with.

### 8.2 Mechanism

A `data-theme` attribute on `<html>` selects the palette. The stored *preference* lives in
`localStorage['rpm-theme']` and may be `auto`, `light`, `graphite`, `midnight`, `slate` or
`phosphor`; the *resolved* value that lands in the attribute is never `auto`.

An inline script in each `<head>` — the last element, before any paint — resolves and stamps
it, which is what prevents a white flash on load:

```js
(function(){try{
  var t=localStorage.getItem('rpm-theme')||'auto';
  if(t==='auto'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'graphite':'light';}
  document.documentElement.setAttribute('data-theme',t);
}catch(e){}})();
```

It is duplicated verbatim in all four shells rather than shared, because an external file
cannot run before first paint. `try/catch` because `localStorage` throws in private mode on
old Safari.

`js/rpimonitor.js` owns the engine: `RPM_THEMES`, `GetThemePreference()`, `ResolveTheme()`,
`ApplyTheme()`, `ThemeToken()`, `WatchSystemTheme()` and `AddThemeOption()`. `ApplyTheme()`
stores the preference, stamps the resolved value, then fires `$(document).trigger('rpm:themechange')`.
`WatchSystemTheme()` re-applies live when the OS flips, but only while the preference is
still `auto`.

`ThemeToken(name)` reads a custom property off the root element. Its fallback table returns
**JustGage's own library defaults** when the stylesheet is missing, so a failed CSS load
renders gauges byte-identically to the old behaviour rather than invisibly.

### 8.3 The text-color scale

The requirement was a **tiered text scale, not one flat white**. Flat `#fff` on dark is the
classic mistake — every glyph shouts equally and the hierarchy a monitoring dashboard depends
on (widget title vs. metric value vs. unit vs. timestamp) collapses. Each theme therefore
defines four tiers. Ratios below are WCAG 2.1, computed against each theme's three surface
tokens.

**graphite** — cool neutral / blue. The `auto` dark default.

| Token | Hex | on `--bg-0` | on `--bg-1` | on `--bg-2` | Use |
|---|---|---|---|---|---|
| `--txt-1` | `#e6edf3` | 16.02 | 14.64 | 12.88 | metric values, widget titles, `<b>` |
| `--txt-2` | `#adbac7` | 9.58 | 8.75 | 7.70 | body copy, labels |
| `--txt-3` | `#8b949e` | 6.15 | 5.62 | 4.95 | units, axis ticks, gauge titles |
| `--txt-4` | `#6e7681` | 4.12 | 3.77 | 3.31 | separators, disabled only |

Surfaces `#0d1117` / `#161b22` / `#21262d`, line `#30363d`. Accents: link `#58a6ff`,
ok `#3fb950`, warn `#d29922`, danger `#f85149`, info `#79c0ff`.

**midnight** — navy near-black / cyan. Highest contrast, true black for OLED.

| Token | Hex | on `--bg-0` | on `--bg-1` | on `--bg-2` |
|---|---|---|---|---|
| `--txt-1` | `#f0f4fa` | 18.05 | 16.92 | 15.38 |
| `--txt-2` | `#b4c0d4` | 10.84 | 10.17 | 9.24 |
| `--txt-3` | `#8592aa` | 6.34 | 5.95 | 5.41 |
| `--txt-4` | `#5f6c82` | 3.75 | 3.52 | 3.20 |

Surfaces `#060910` / `#0d1220` / `#151c2e`, line `#223049`. Accents: link `#56cffa`,
ok `#46d39a`, warn `#ffb454`, danger `#ff6b81`, info `#8ad9ff`.

**slate** — lifted warm grey. Softest; contrast deliberately capped.

| Token | Hex | on `--bg-0` | on `--bg-1` | on `--bg-2` |
|---|---|---|---|---|
| `--txt-1` | `#e3e7ec` | 13.31 | 11.93 | 10.38 |
| `--txt-2` | `#b9c0ca` | 9.02 | 8.08 | 7.03 |
| `--txt-3` | `#949ca8` | 5.97 | 5.35 | 4.65 |
| `--txt-4` | `#737b88` | 3.87 | 3.47 | 3.02 |

Surfaces `#1b1f26` / `#232830` / `#2c323c`, line `#3b424e`. Accents: link `#7fb3e8`,
ok `#6fc48f`, warn `#e0b25c`, danger `#e0787c`, info `#9ec9f0`.

**phosphor** — terminal green. The only theme that also overrides `--app-font` to a
monospace stack, because that is the point of the look.

| Token | Hex | on `--bg-0` | on `--bg-1` | on `--bg-2` |
|---|---|---|---|---|
| `--txt-1` | `#b9f7c0` | 15.78 | 14.89 | 13.28 |
| `--txt-2` | `#7fd68f` | 10.98 | 10.36 | 9.24 |
| `--txt-3` | `#57a869` | 6.64 | 6.27 | 5.59 |
| `--txt-4` | `#3d7a4c` | 3.76 | 3.55 | 3.17 |

Surfaces `#0a0f0a` / `#0f1710` / `#16231a`, line `#1f3324`. Accents: link `#5cf08f`,
ok `#3ddc72`, warn `#ffc857`, danger `#ff5f56`, info `#6ee7b7`.

Note the semantics: in an all-green theme "ok = green" carries no signal, so state is
encoded by the two non-green hues (amber, red) only. That is authentic to a real terminal
rather than a compromise.

`--txt-4` sits below 4.5:1 in every theme **by design** — it is for separators and disabled
state, never live text. It clears 3:1 for non-text UI in all four.

### 8.4 Token contract

Defined per theme in `css/rpimonitor.theme.css`:

```
--bg-0 --bg-1 --bg-2 --line
--txt-1 --txt-2 --txt-3 --txt-4
--acc-link --acc-ok --acc-warn --acc-danger --acc-info
--nav-bg --nav-txt --nav-active-txt --nav-active-bg
--bar-fill --bar-txt --gauge-track
--icon-filter --grid-line --grid-bg --grid-label --app-font
--state-{ok,info,warn,danger}-{bg,txt,line}
```

Plus ~70 derived tokens (`--btn-*`, `--panel-*`, `--popover-*`, `--table-*`, …) defined once
in a block shared by all four dark themes, so a fifth dark theme needs only its ~26-token
palette.

The stylesheet is structured `:root` (complete light palette) → `:root[data-theme="light"]`
→ four dark palette blocks → one shared derived block → all component rules. **Every
component rule pulls from `var(--token)`; there is not one color literal outside a `:root`
block**, and there is **no `!important` anywhere** — load order alone wins the cascade,
because `rpimonitor.theme.css` is linked after both `bootstrap.min.css` and `rpimonitor.css`.

### 8.5 What CSS could not do

Two places needed JavaScript. Both were confirmed by reading the libraries, not assumed.

**JustGage gauges.** `JustGageBar()` (`js/rpimonitor.utils.js`) forwarded only `levelColors`.
Four other colors stayed at library defaults — `gaugeColor "#edebeb"`, `valueFontColor
"#010101"`, `titleFontColor "#999999"`, `labelFontColor "#b3b3b3"` — and JustGage writes them
as SVG `fill` **attributes** (`justgage.1.0.1.js:216,235,246,257`). No stylesheet reaches an
attribute. Fixed by emitting literal `ThemeToken("--…")` calls into the `postProcessCommand`
string, so they resolve at eval time and follow a theme switch.

**Flot canvas.** Flot 0.7 paints grid, axes and legend from a plain options object.
`ThemeGraphOptions()` in `js/rpimonitor.statistics.js` seeds `graph_options` before the
per-KPI `eval()` loop, so anything a `.conf` names still wins.

Two corrections worth recording, since both contradict the obvious guess:

- **The axis tick label color is `xaxis.color` / `yaxis.color`, not `tickColor`.** Flot
  emits it as an *inline style* on `<div class="tickLabel">`, so CSS cannot override it
  without `!important`. `tickColor` is the grid tick *line* stroke, a different thing.
  There is no `font` option in 0.7 — tick labels are HTML, not canvas text.
- **The per-KPI merge was a top-level replace, not a deep merge.** `network.conf:32` sets
  `graph_options.yaxis={tickFormatter:…}` and ~15 other templates set `y1axis`/`y2axis`/
  `legend`; each would have wiped the seeded axis colors wholesale, leaving exactly the
  graphs with custom formatting unreadable. `MergeGraphOption()` now merges plain objects
  key-by-key.

`#545454` (Flot's stock `grid.color`) lives in vendored `jquery.flot.min.js` and is left
alone — setting `grid.color` explicitly makes it moot.

### 8.6 Deliberate decisions

**No `color-mix()`.** The state tints were first authored with it. `color-mix()` is Baseline
2023 while custom properties date to 2016, and an unsupported `color-mix` is invalid at
computed-value time — which would drop alert backgrounds to Bootstrap's *light* tints on a
dark ground. On a monitoring dashboard that is the one element that must stay legible. All
32 values are precomputed static hex; the palettes never vary at runtime, so it costs nothing.

**`--grid-label` is its own token, not `--txt-3`.** Flot's historic default is `#545454`;
`--txt-3` is `#777777` in light. A dedicated token keeps light mode exact.

**Light mode reproduces Bootstrap 3.2.0, not 3.3.x.** The vendored sheet is genuinely 3.2.0,
whose brand primary is `#428bca` (25 occurrences; `#337ab7`, the 3.3.x value, appears zero
times). `.navbar-brand` is `#777` in 3.2.0 and needed its own token to stay exact.

### 8.7 Bugs fixed in passing

All three were live before this change and are not dark-mode issues:

- `statistics.html:42` used `alert-error`, a **Bootstrap 2** class absent from 3.2.0 — that
  error banner was unstyled in light mode too. → `alert-danger`.
- `ShowInfo()` (`rpimonitor.utils.js:25`) emitted an unterminated `<a>`, silently swallowing
  any text a template printed after it into the link. The only in-tree caller
  (`version.conf:74`) puts it last on the line, so the fix is a no-op there, but third-party
  templates were affected.
- `icon-arrow-up` / `icon-arrow-down` (Bootstrap 2) in `network.conf`, `wlan.conf`,
  `tor.conf` — dead markup in BS3. → `glyphicon glyphicon-arrow-*`.

Also removed: `<body bgcolor="#E6E6FA">` in all three addon pages, `<font color="silver">`
in the footer, `<font color=black>` in `ShowInfo()`, `#f0f0f0` in `rpimonitor.css`'s
`column-rule`, and `#f2f2f2`/`#e9e9e9` in `advanced_service.conf`'s embedded `<style>` block.

### 8.8 Known remaining work

- **`img/version.png` needs replacing.** It is **100% opaque** at 228/255 mean luminance — a
  solid light tile, unlike the other icons which are transparent PNGs with dark line art
  (handled by `--icon-filter`). No filter rescues it; inverting yields a solid dark tile with
  inverted artwork. Currently knocked back with `--img-opacity` / `--img-blend` and a `TODO`.
  The real fix is a transparent asset.
- **`#qrcanv`** (`jsqrencode`) paints black-on-white into a canvas. Needs themed draw colors
  or a permanent light padding box.
- **`#flotTip`** injects inline styles when `defaultTheme: true`; set it `false` to let a
  class carry the styling.
- **`class="span3"`** on the statistics options `<select>` is a Bootstrap 2 grid class, dead
  in BS3. Left alone deliberately — replacing it changes light-mode layout, which is outside
  a theming change.
- `img/glyphicons-halflings.png` and `-white.png` are referenced by nothing in the tree —
  dead BS2 leftovers, safe to delete separately.
- **Not browser-tested.** Verification to date is static analysis: ES5 conformance, token
  completeness across all four themes, no undefined `var()`, balanced braces, no external
  URLs, no vendored library modified.

### 8.9 Files

New: `web/css/rpimonitor.theme.css` (1400 lines).

Modified: `web/{index,status,statistics,addons}.html`, `web/addons/{about/about,top3/top3,custom/custominfo}.html`,
`web/css/rpimonitor.css`, `web/js/{rpimonitor,rpimonitor.utils,rpimonitor.status,rpimonitor.statistics}.js`,
`etc/rpimonitor/template/{advanced_service,network,wlan,tor}.conf`.

Packaging needs no change: the Makefile installs via `cp -r src/usr/share/rpimonitor/*`, so
the new stylesheet is picked up automatically.

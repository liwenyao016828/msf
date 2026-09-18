# Complete MSF CLI Guide

This page documents the user-facing commands provided by the current `msf` binary. A normal installation runs one MSF service, so common commands automatically use the installed instance; users do not need to enter a data-directory path.

Run the bilingual quick reference at any time:

```bash
msf help
```

## Common commands

| Command | Purpose |
|---|---|
| `sudo msf start` | Start MSF through systemd when installed, or start the current binary in the background. |
| `sudo msf status` | Show MSF, systemd, MosDNS, and Mihomo status. |
| `sudo msf stop` | Gracefully stop MSF and its managed components. |
| `sudo msf restart` | Restart MSF. |
| `sudo msf logs [msf\|mosdns\|mihomo]` | Show service logs. |
| `sudo msf doctor` | Check directories, components, ports, and required system commands. |
| `sudo msf reset-password` | Securely reset the sole administrator password. |
| `sudo msf update` | Update a Linux tarball/systemd installation. |
| `sudo msf uninstall` | Remove a Linux tarball/systemd installation. |
| `msf version` | Show version and build provenance. |
| `msf help` | Show the bilingual quick guide. |

Use `--lines` to select the log length and `--timeout`/`--force` for a slow shutdown:

```bash
sudo msf logs --lines 200 mihomo
sudo msf stop --timeout 30s --force
```

## Forgotten administrator password

For a normal single-administrator installation, run only:

```bash
sudo msf reset-password
```

MSF locates the installed database automatically. The new password is entered twice without terminal echo, must contain at least eight characters, and is never printed after success.

When more than one administrator exists, specify the target username:

```bash
sudo msf reset-password --user admin
```

`--user admin` only selects the administrator. The new password is not a command-line argument; enter it at the hidden `New password` and `Confirm password` prompts that follow.

The reset changes only that administrator. Existing access JWTs are invalidated and all refresh sessions for the account are revoked. Separate API Tokens are automation credentials and are intentionally not revoked silently; revoke them from the API Token page if credential exposure is suspected. A disabled account remains disabled.

Platform entry points:

```bash
# Linux tarball/systemd and Unraid
sudo msf reset-password

# Docker (replace msf with the actual container name)
docker exec -it msf msf reset-password

# fnOS
sudo /var/apps/msf/target/msf reset-password

# macOS menu-bar edition
sudo /Library/PrivilegedHelperTools/io.github.scoltzero.msf.daemon reset-password
```

None of these commands requires a data-directory argument.

## Why both `start` and `serve` exist

- `msf start` is the user-facing lifecycle command. It uses systemd when a unit is installed and otherwise starts MSF in the background. Repeating it does not create a second process.
- `msf serve` runs the HTTP service in the foreground. systemd, Docker, platform scripts, and developers call it; closing the terminal or sending `SIGTERM` ends the process.
- `msf init` creates the base directory, database, and runtime layout. Installers may call it before the first start.
- `msf migrate` opens the target database (creating it when missing), applies the current schema migrations, and checks the base layout. Startup already runs the same migrations, so this command is mainly for offline maintenance and troubleshooting.

Development example:

```bash
go run ./cmd/msf serve --config ./data --host 127.0.0.1 --port 7777
```

## Linux installation maintenance

These commands apply only to Linux tarball/systemd installations:

```bash
sudo msf update
sudo msf service status
sudo msf service install
sudo msf service uninstall
sudo msf uninstall
```

Optional update sources and explicit uninstall behavior:

```bash
sudo msf update --repo scoltzero/msf
sudo msf update --url https://example.invalid/msf-linux-amd64.tar.gz
sudo msf uninstall --keep-data
sudo msf uninstall --purge --yes
```

Docker, Unraid, and fnOS reject the Linux host installer/remover commands. Use the relevant container, plugin, or application manager instead.

## Cloudflare Redirect

```bash
sudo msf cloudflare-redirect status
sudo msf cloudflare-redirect scan
sudo msf cloudflare-redirect apply
sudo msf cloudflare-redirect start
sudo msf cloudflare-redirect stop
```

This is an experimental feature. `start` runs periodic scan/apply work, `scan` performs one scan, `apply` applies the current result, and `stop` also removes the MosDNS injection.

## macOS menu-bar pairing

`menu-bar-token` is only for local pairing between the macOS background helper and the menu-bar app, and it requires root. Normally use “Connect local background” or the app's install/repair flow. Never paste the emitted credential into chat, logs, or documentation.

## Version and license status

```bash
msf version
msf version --json
msf license status
msf license fingerprint
```

MSF is currently free/unlocked. Legacy commercial-license actions only print a compatibility notice.

## Platform scope

| Capability | Linux systemd | Docker | Unraid | fnOS | macOS |
|---|---:|---:|---:|---:|---:|
| `start/status/stop/restart/logs/doctor` | Yes | Limited inside the container | Prefer service script | Prefer app manager | Prefer menu-bar app |
| `reset-password` | Yes | Run inside container | Yes | Use packaged binary | Use helper binary |
| `update/uninstall/service` | Yes | No | No | No | No |
| `menu-bar-token` | No | No | No | No | Yes |

`msf -h` and `msf --help` remain low-level flag references. Use `msf help` and this page for ordinary guidance.

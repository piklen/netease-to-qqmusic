# NetEase Cloud Music → QQ Music

[![CI](https://github.com/piklen/netease-to-qqmusic/actions/workflows/ci.yml/badge.svg)](https://github.com/piklen/netease-to-qqmusic/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Migrate your playlists, liked songs, saved albums and followed artists from NetEase Cloud Music to QQ Music — **locally**, with no third-party server, no password sharing, and an explicit confirmation before anything is written.

[中文](README.md) · [Security](SECURITY.md)

---

## Why this exists

QQ Music's built-in import accepts plain text only, so it cannot carry your full account. `ToQQMusic` is archived and playlist-only; `GoMusic` targets Apple Music / YouTube Music / Spotify; commercial services require handing over your credentials and paywall bulk migrations.

This tool covers the whole account while keeping every decision auditable.

## Supported

| Item | Default behaviour |
| --- | --- |
| Playlists you own + track order | Recreated on QQ Music, source order preserved |
| "Liked songs" | Written directly to QQ Music *Liked* (`dirid=201`) |
| Saved albums | Matched; saved with `--albums` |
| Followed artists | Matched; followed with `--artists` |
| Playlists saved from others | **Backed up only**; `--copy-collected` copies them |

**Not migrated:** comments, feed, play history, covers, cloud-drive audio, downloads, memberships, purchases, social graph. Unavailable tracks stay in reports instead of being force-matched.

## Install

Node.js ≥ 18 and Python ≥ 3.10.

```bash
git clone https://github.com/piklen/netease-to-qqmusic.git
cd netease-to-qqmusic
npm run setup
```

`npm run setup` is idempotent, creates `.venv`, and installs Python dependencies. Run `npm link` to use the `n2q` command globally.

## Usage

```bash
n2q login                          # NetEase login (QR or pasted cookie)
n2q export                         # backup account, read-only
n2q prepare                        # match against QQ Music, read-only
n2q review                         # resolve uncertain matches interactively
n2q import --dry-run --albums --artists
n2q import --albums --artists      # type IMPORT to confirm
n2q verify                         # read back and diff
```

First QQ login shows a QR code and opens an enlarged image — scan with QQ, WeChat, or the QQ Music app.

## How matching works

1. Query `title + all artists`, then `title + lead artist`, then `title`.
2. Score candidates: title (70), artist overlap (30), album (6), duration (±5), version tags such as Live/Remix/DJ/instrumental (−22 to −30).
3. Auto-approve **only** when score ≥ 92, exact title, matching artist, album or duration corroboration, and no tie.
4. Everything else lands in review. Fallback suggestions prefer the same artist, then similar titles by popularity.
5. Every automatic decision is recorded in `data/fallback-audit.json`.

Manual choices in `data/overrides.json` are keyed by playlist ID + track position, so the same song can be handled differently in different playlists.

## Commands

| Command | Purpose |
| --- | --- |
| `n2q login` | Store NetEase session |
| `n2q export` | Back up everything, generate official text chunks |
| `n2q prepare` | Match (`--owned-only`, `--playlist`, `--no-fallback`, `--rebuild`) |
| `n2q review` | Interactive resolution (`--list`, `--only all`) |
| `n2q import` | Write to QQ (`--dry-run`, `--albums`, `--artists`, `--copy-collected`, `--limit`, `--strict`) |
| `n2q verify` | Read-only diff of QQ playlists |
| `n2q status` | Progress, match stats, last run (`--json`) |
| `n2q report` | Regenerate review files |
| `n2q doctor` | Environment self-check |
| `n2q logout` | Delete locally stored credentials |

`--help` on any command lists options.

### Resuming

Re-run `n2q import`: completed playlists and tracks are skipped, playlists are never created twice. Failures are recorded and the run continues; `--strict` stops on the first error. Batch failures degrade to per-track retries.

## Data layout

```
data/
├── .secrets/                     # sessions, mode 0600
├── netease-backup-<time>.json
├── latest-backup.json
├── matches.json
├── overrides.json                # the only file you may want to edit
├── migration-state.json          # resume state
├── fallback-audit.json
├── import-report.json
├── verify-report.json
├── review.csv / review.md
└── unresolved.json
```

Use `--data-dir` or `N2Q_DATA_DIR` to isolate accounts.

## FAQ

**"Environment anomaly" when scanning the NetEase QR?**
Use `n2q login` and paste the cookie from a logged-in browser tab. Input is not echoed.

**Nothing is deleted, right?**
Correct. The only write operations are create playlist, add songs, save album, follow artist.

**Why does the liked count differ?**
`n2q verify` compares unique song IDs; QQ collapses duplicates, so positions ≠ unique tracks.

## Safety

Local-only interfaces, credential redaction in logs, `0700/0600` permissions, and no telemetry. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm test          # 29 Node tests
npm run test:py   # 5 Python tests
```

Tests never touch a real account; QQ is simulated by `test/mock_qq_bridge.py`.

## Acknowledgements

- [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- [L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi)

QQ Music write endpoints are unofficial and may break. Use this only on your own account and within platform terms.

## License

[MIT](LICENSE). Not affiliated with NetEase or Tencent.

# Installing `mem` on another machine

`mem` is a Bun + TypeScript CLI with an embedded SQLite store. There is no build
step and no native modules — Bun runs the TypeScript source directly and uses its
built-in `bun:sqlite`. Installing is therefore just "get the source onto the
machine and let Bun link a `mem` shim onto your PATH".

Works on macOS, Linux, and Windows.

## 1. Prerequisites

Install Bun (>= 1.2):

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Confirm it's available:

```sh
bun --version
```

## 2. Install `mem`

### From GitHub (primary, reproducible)

```sh
bun install --global github:chrisdevelops/nook-kb

# pin to a released tag for a reproducible install:
bun install --global github:chrisdevelops/nook-kb#v0.5.1
```

The `github:` shorthand fetches through the public GitHub tarball API, so it
only works while the repo is public. For a private repo or fork, install over
git instead (uses your SSH key / git credentials):

```sh
bun install --global git+ssh://git@github.com/chrisdevelops/nook-kb.git
```

### From a local clone

```sh
git clone git@github.com:chrisdevelops/nook-kb.git
bun install --global ./nook-kb
```

### Local development link (edits go live immediately)

Use this on your dev machine when you want `mem` to track your working tree:

```sh
cd nook-kb
bun install            # installs dev deps; husky git hooks get set up here
bun link               # registers @nook/mem
bun link @nook/mem     # creates the global `mem` shim pointing at this checkout
```

## 3. PATH

Bun links global binaries into:

- macOS / Linux: `~/.bun/bin`
- Windows: `%USERPROFILE%\.bun\bin`

Bun's installer normally adds this to your PATH. Open a **fresh** shell and run
`mem --help`. If you get `mem: command not found`, add the directory to PATH:

```sh
# macOS / Linux (add to ~/.zshrc or ~/.bashrc)
export PATH="$HOME/.bun/bin:$PATH"
```

On Windows, confirm `%USERPROFILE%\.bun\bin` is in your user PATH (it is added by
the Bun installer; re-open the terminal after install).

## 4. Where your data lives

`mem` follows the XDG base-directory convention:

| What     | Path                                              |
| -------- | ------------------------------------------------- |
| Database | `${XDG_DATA_HOME:-~/.local/share}/nook/memory.db` |
| Config   | `${XDG_CONFIG_HOME:-~/.config}/nook/memory.jsonc` |

The database (and its directory) is created automatically on first use, and
migrations are applied on open — there is no separate init step.

On Windows these resolve under `%USERPROFILE%\.local\share\nook\…` and
`%USERPROFILE%\.config\nook\…` today. That's functional but not the idiomatic
Windows location; a future release may switch to `%APPDATA%`.

To move your memory between machines, copy the `nook/memory.db` file (with the
CLI not running). To start fresh, just delete it.

## 5. Smoke test

After installing, confirm the CLI resolves and the store initializes:

```sh
mem kinds                                   # prints payload contracts as JSON, exit 0

# round-trip — pick a real kind from `mem kinds` (note shown as an example):
mem add note --title "install smoke test" --body "hello from $(hostname)"
mem query "install smoke"                   # should return the node you just added
```

If `mem add` succeeds, the SQLite store was created and migrations were found and
applied — that's the end-to-end proof the install is wired up correctly.

## 6. Upgrade and uninstall

```sh
# upgrade — re-run the global install at a newer tag
bun install --global github:chrisdevelops/nook-kb#v0.5.2

# uninstall (your memory.db is left untouched)
bun remove --global @nook/mem
```

## 7. Troubleshooting

- **`mem: command not found`** — `~/.bun/bin` (or `%USERPROFILE%\.bun\bin`) isn't
  on PATH. See section 3, then open a new shell.
- **Install aborts during `prepare`** — older checkouts ran `husky` unguarded,
  which fails on a consumer install with no dev dependencies. This is fixed
  (`prepare` is now `husky || true`); upgrade to a current revision.

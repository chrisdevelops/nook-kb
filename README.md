# mem — shared agent memory

One SQLite-backed memory layer shared by every agent on this machine. JSON to stdout; errors to stderr; exit 0 ok / 1 user error / 2 system error.

**Capture discipline: search before you add; always link what you add.**

```
mem query [text] [--kind k]... [--tag t]... [--status s] [--since iso] [--until iso]
          [--limit n] [--include-closed] [--human]      # no text = recency listing
mem add <kind> --title t [--body md | --body-stdin] [--payload json]
          [--tag t]... [--link <id>:<rel>]... [--status s] [--occurred-at iso]
mem get <id> [--with-edges] [--with-body]
mem update <id> [--title t] [--body md] [--payload-merge json] [--status s]
mem link <src> <dst> <rel>   |   mem unlink <src> <dst> <rel>
mem tag <id> <t>...          |   mem untag <id> <t>...
mem delete <id>              |   mem restore <id>
mem kinds [kind]   # payload contracts, statuses, defaults — self-discover here
```

Relations: `references` `relates_to` `derived_from` `about` `part_of` `blocks` `follows` `evidences`.

Ideas: create one `idea` anchor node; later fragments are `note`s linked `part_of` → the anchor (search for it first — never edit the anchor's body). Group constellations with hierarchical tags (`story/<slug>/...`).

Examples:

```
mem query "safekeep auth"                                   # search first…
mem add note --title "Auth decision" --link <id>:part_of    # …then capture, linked
mem add meal --title "Oatmeal breakfast" --payload '{"items":["oatmeal"]}' \
        --occurred-at 2026-06-10T08:00:00Z
mem query --kind task --status open                         # listing
```

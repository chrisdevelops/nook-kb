# mem — shared agent memory

One SQLite-backed memory layer shared by every agent on this machine. JSON to stdout; errors to stderr; exit 0 ok / 1 user error / 2 system error.

**Capture discipline: search before you add; always link what you add.**

```
mem query [text] [--kind k]... [--tag t]... [--status s] [--since iso] [--until iso]
          [--hops 1..3] [--limit n] [--include-closed] [--human]
          # no text = recency listing; hits expand 1 hop over edges by default —
          # hops/via on each hit explain why it surfaced
mem related <id> [--hops 1..3] [--limit n]   # ranked neighborhood, no search text
mem add <kind> --title t [--body md | --body-stdin] [--payload json]
          [--tag t]... [--link <id>:<rel>]... [--status s] [--occurred-at iso]
mem get <id> [--with-edges] [--with-body]
mem update <id> [--title t] [--body md] [--payload-merge json] [--status s]
mem link <src> <dst> <rel>   |   mem unlink <src> <dst> <rel>
mem tag <id> <t>...          |   mem untag <id> <t>...
mem delete <id>              |   mem restore <id>
mem suggest [--limit n]      # compute link suggestions (run ad hoc or on a heartbeat)
mem suggest review [--limit n] | mem suggest accept <src> <dst> | mem suggest reject <src> <dst>
mem report <name> [--human]  # medical-history [--since iso] | finance [--month yyyy-mm]
                             # | tasks [--project <id|title>]
mem kinds [kind]   # payload contracts, statuses, defaults — self-discover here
```

Relations: `references` `relates_to` `derived_from` `about` `part_of` `blocks` `follows` `evidences`.

Wikilinks: `[[<id>]]` or `[[Exact Title]]` in a body becomes a `references` edge on add and body update (exact title match against live nodes — never guesses). Misses are returned as `unresolved_links` and are **not** retried when the target appears later: repair them now, while you know what they meant.

Ideas: create one `idea` anchor node; later fragments are `note`s linked `part_of` → the anchor (search for it first — never edit the anchor's body). Group constellations with hierarchical tags (`story/<slug>/...`).

Examples:

```
mem query "safekeep auth"                                   # search first…
mem add note --title "Auth decision" --link <id>:part_of    # …then capture, linked
mem query "safekeep" --hops 2                               # widen across the graph
mem add meal --title "Oatmeal breakfast" --payload '{"items":["oatmeal"]}' \
        --occurred-at 2026-06-10T08:00:00Z
mem query --kind task --status open                         # listing
```

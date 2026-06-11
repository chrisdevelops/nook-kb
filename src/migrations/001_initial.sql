-- 001: full initial DDL per SPEC §3.1.
-- Pragmas are connection-scoped and applied by the store on open, not here.

CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT,
  occurred_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  amount      REAL GENERATED ALWAYS AS (json_extract(payload, '$.amount')) STORED,
  due_at      TEXT GENERATED ALWAYS AS (json_extract(payload, '$.due_at')) STORED
);

CREATE INDEX idx_nodes_kind        ON nodes(kind, occurred_at);
CREATE INDEX idx_nodes_status      ON nodes(kind, status);
CREATE INDEX idx_nodes_occurred_at ON nodes(occurred_at);
CREATE INDEX idx_nodes_due_at      ON nodes(due_at);

CREATE TABLE edges (
  src        TEXT NOT NULL REFERENCES nodes(id),
  dst        TEXT NOT NULL REFERENCES nodes(id),
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  origin     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src, dst, rel)
);

CREATE INDEX idx_edges_dst ON edges(dst);

CREATE TABLE tags (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  tag     TEXT NOT NULL,
  PRIMARY KEY (node_id, tag)
);

CREATE INDEX idx_tags_tag ON tags(tag);

CREATE TABLE link_suggestions (
  src        TEXT NOT NULL REFERENCES nodes(id),
  dst        TEXT NOT NULL REFERENCES nodes(id),
  score      REAL NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  PRIMARY KEY (src, dst)
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  node_id UNINDEXED, title, body, tags,
  tokenize='porter unicode61'
);

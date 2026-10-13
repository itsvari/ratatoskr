CREATE TABLE administrators (subject TEXT PRIMARY KEY, email TEXT NOT NULL);

CREATE TABLE links (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  destination TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES administrators(subject),
  CHECK ((status = 'deleted' AND destination IS NULL AND title = '' AND expires_at IS NULL)
    OR (status != 'deleted' AND destination IS NOT NULL))
);

CREATE INDEX links_listing ON links(status, created_at DESC, slug DESC);

CREATE TABLE audit_events (
  identifier TEXT PRIMARY KEY,
  actor_subject TEXT NOT NULL REFERENCES administrators(subject),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'revoke', 'restore', 'delete')),
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO settings (name, value) VALUES ('generated_syllables', 3);

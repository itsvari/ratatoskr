CREATE TABLE site_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 48)
);
INSERT INTO site_settings (singleton, display_name) VALUES (1, 'Ratatoskr');

CREATE TABLE site_settings_audit (
  identifier TEXT PRIMARY KEY,
  actor_subject TEXT NOT NULL REFERENCES administrators(subject),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

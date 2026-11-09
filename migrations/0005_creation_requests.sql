CREATE TABLE creation_requests (
  actor_subject TEXT NOT NULL REFERENCES administrators(subject),
  request_id TEXT NOT NULL,
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  slug TEXT NOT NULL UNIQUE REFERENCES links(slug) ON DELETE CASCADE,
  PRIMARY KEY (actor_subject, request_id)
);

CREATE TRIGGER clear_deleted_creation_hash AFTER UPDATE OF status ON links
WHEN NEW.status = 'deleted'
BEGIN
  UPDATE creation_requests SET request_hash = NULL WHERE slug = NEW.slug;
END;

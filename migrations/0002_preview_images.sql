CREATE TABLE preview_images (
  slug TEXT PRIMARY KEY REFERENCES links(slug),
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  origin TEXT NOT NULL,
  segment TEXT NOT NULL
);
CREATE TRIGGER withdraw_preview_after_link_edit AFTER UPDATE ON links
WHEN NEW.title != OLD.title OR NEW.destination IS NOT OLD.destination OR NEW.status = 'deleted'
BEGIN
  DELETE FROM preview_images WHERE slug = NEW.slug;
END;

CREATE TABLE preview_branding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  segment TEXT
);
INSERT INTO preview_branding (singleton, segment) VALUES (1, NULL);

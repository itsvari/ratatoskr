ALTER TABLE site_settings ADD COLUMN home_redirect_url TEXT CHECK (home_redirect_url IS NULL OR length(home_redirect_url) BETWEEN 1 AND 4096);
ALTER TABLE site_settings_audit ADD COLUMN home_redirect_url TEXT;

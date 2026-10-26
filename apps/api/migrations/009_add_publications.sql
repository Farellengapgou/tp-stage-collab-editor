ALTER TABLE download_links
  ADD COLUMN IF NOT EXISTS published_revision INTEGER,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'download_links_publication_consistent'
      AND conrelid = 'download_links'::regclass
  ) THEN
    ALTER TABLE download_links
      ADD CONSTRAINT download_links_publication_consistent
      CHECK (
        (published_revision IS NULL AND published_at IS NULL)
        OR (published_revision IS NOT NULL AND published_at IS NOT NULL AND published_revision >= 0)
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS download_links_public_journal_idx
  ON download_links (published_at DESC, id)
  WHERE is_active AND published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS editor_sessions (
  id UUID PRIMARY KEY,
  editor_id UUID NOT NULL REFERENCES editors(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT editor_sessions_expires_after_creation
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS editor_sessions_expires_at_idx
  ON editor_sessions (expires_at);

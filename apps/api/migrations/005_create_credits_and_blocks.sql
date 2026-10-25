CREATE TABLE IF NOT EXISTS daily_credits (
  editor_id UUID NOT NULL REFERENCES editors(id),
  credit_date DATE NOT NULL,
  limit_characters INTEGER NOT NULL DEFAULT 10000,
  used_characters INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (editor_id, credit_date),
  CONSTRAINT daily_credits_limit_is_daily_allowance
    CHECK (limit_characters = 10000),
  CONSTRAINT daily_credits_used_characters_in_range
    CHECK (used_characters >= 0 AND used_characters <= limit_characters)
);

CREATE TABLE IF NOT EXISTS editor_blocks (
  id UUID PRIMARY KEY,
  editor_id UUID NOT NULL REFERENCES editors(id),
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT editor_blocks_reason_not_blank CHECK (BTRIM(reason) <> ''),
  CONSTRAINT editor_blocks_expire_after_start CHECK (expires_at > started_at)
);

CREATE INDEX IF NOT EXISTS editor_blocks_editor_id_expires_at_idx
  ON editor_blocks (editor_id, expires_at DESC);

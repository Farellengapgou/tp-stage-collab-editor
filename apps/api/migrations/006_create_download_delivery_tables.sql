CREATE TABLE IF NOT EXISTS download_links (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  public_token VARCHAR(128) NOT NULL UNIQUE,
  max_downloads INTEGER NOT NULL,
  consumed_downloads INTEGER NOT NULL DEFAULT 0,
  active_reservations INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT download_links_token_not_blank CHECK (BTRIM(public_token) <> ''),
  CONSTRAINT download_links_max_downloads_positive CHECK (max_downloads > 0),
  CONSTRAINT download_links_consumed_downloads_non_negative
    CHECK (consumed_downloads >= 0),
  CONSTRAINT download_links_active_reservations_non_negative
    CHECK (active_reservations >= 0),
  CONSTRAINT download_links_quota_not_exceeded
    CHECK (consumed_downloads + active_reservations <= max_downloads)
);

CREATE TABLE IF NOT EXISTS download_reservations (
  id UUID PRIMARY KEY,
  link_id UUID NOT NULL REFERENCES download_links(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(255) NOT NULL,
  reserved_revision INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT download_reservations_link_idempotency_key_unique
    UNIQUE (link_id, idempotency_key),
  CONSTRAINT download_reservations_idempotency_key_not_blank
    CHECK (BTRIM(idempotency_key) <> ''),
  CONSTRAINT download_reservations_revision_non_negative
    CHECK (reserved_revision >= 0),
  CONSTRAINT download_reservations_status_valid
    CHECK (status IN ('reserved', 'delivered', 'expired', 'failed')),
  CONSTRAINT download_reservations_expire_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT download_reservations_delivered_at_consistent
    CHECK (
      (status = 'delivered' AND delivered_at IS NOT NULL)
      OR (status <> 'delivered' AND delivered_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS download_reservations_pending_expiry_idx
  ON download_reservations (expires_at)
  WHERE status = 'reserved';

CREATE TABLE IF NOT EXISTS pdf_artifacts (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  s3_object_key TEXT NOT NULL UNIQUE,
  status VARCHAR(16) NOT NULL,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pdf_artifacts_document_revision_unique
    UNIQUE (document_id, revision),
  CONSTRAINT pdf_artifacts_document_revision_fk
    FOREIGN KEY (document_id, revision)
    REFERENCES document_versions (document_id, revision),
  CONSTRAINT pdf_artifacts_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT pdf_artifacts_s3_object_key_not_blank
    CHECK (BTRIM(s3_object_key) <> ''),
  CONSTRAINT pdf_artifacts_status_valid
    CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  CONSTRAINT pdf_artifacts_generated_at_consistent
    CHECK (
      (status = 'ready' AND generated_at IS NOT NULL)
      OR (status <> 'ready' AND generated_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  link_id UUID NOT NULL REFERENCES download_links(id) ON DELETE CASCADE,
  notification_type VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_link_type_unique UNIQUE (link_id, notification_type),
  CONSTRAINT notifications_type_not_blank CHECK (BTRIM(notification_type) <> ''),
  CONSTRAINT notifications_status_valid
    CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT notifications_attempt_count_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT notifications_sent_at_consistent
    CHECK (
      (status = 'sent' AND sent_at IS NOT NULL)
      OR (status <> 'sent' AND sent_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications (created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_key VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT outbox_events_event_key_not_blank CHECK (BTRIM(event_key) <> ''),
  CONSTRAINT outbox_events_event_type_not_blank CHECK (BTRIM(event_type) <> ''),
  CONSTRAINT outbox_events_payload_is_object
    CHECK (JSONB_TYPEOF(payload) = 'object'),
  CONSTRAINT outbox_events_status_valid
    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  CONSTRAINT outbox_events_attempt_count_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT outbox_events_processed_at_consistent
    CHECK (
      (status = 'processed' AND processed_at IS NOT NULL)
      OR (status <> 'processed' AND processed_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events (created_at)
  WHERE status = 'pending';

-- Reservation protocol to implement later:
-- 1. Lock the link row and create/replay (link_id, idempotency_key).
-- 2. For a new reservation, increment active_reservations only when
--    consumed_downloads + active_reservations < max_downloads.
-- 3. On delivery, decrement active_reservations and increment
--    consumed_downloads in the same transaction. On expiry/failure, only
--    decrement active_reservations. Insert notification/outbox rows in that
--    delivery transaction when the final quota is consumed.

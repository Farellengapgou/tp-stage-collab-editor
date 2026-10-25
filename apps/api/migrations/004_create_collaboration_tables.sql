-- DocumentState is the single durable current-content snapshot for V1.
-- A future custom ShareDB database adapter must map its snapshot API to this
-- table and commit it with the corresponding operation in one transaction.
CREATE TABLE IF NOT EXISTS document_states (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_states_revision_non_negative CHECK (revision >= 0)
);

-- EditOperation is the durable OT oplog. Its JSON payload is the sole stored
-- operation representation; it is not duplicated in a second ShareDB oplog.
CREATE TABLE IF NOT EXISTS edit_operations (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  editor_id UUID NOT NULL REFERENCES editors(id),
  base_revision INTEGER NOT NULL,
  accepted_revision INTEGER NOT NULL,
  operation JSONB NOT NULL,
  inserted_code_points INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT edit_operations_base_revision_non_negative
    CHECK (base_revision >= 0),
  CONSTRAINT edit_operations_accepted_revision_positive
    CHECK (accepted_revision > 0),
  CONSTRAINT edit_operations_accepted_after_base
    CHECK (accepted_revision > base_revision),
  CONSTRAINT edit_operations_inserted_code_points_non_negative
    CHECK (inserted_code_points >= 0),
  CONSTRAINT edit_operations_payload_is_array
    CHECK (JSONB_TYPEOF(operation) = 'array'),
  CONSTRAINT edit_operations_document_accepted_revision_unique
    UNIQUE (document_id, accepted_revision)
);

CREATE INDEX IF NOT EXISTS edit_operations_editor_id_accepted_at_idx
  ON edit_operations (editor_id, accepted_at DESC);

-- DocumentVersion references an immutable snapshot location or reconstruction
-- key; it deliberately does not duplicate the document text.
CREATE TABLE IF NOT EXISTS document_versions (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_reference TEXT NOT NULL,
  restored_from_revision INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, revision),
  CONSTRAINT document_versions_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT document_versions_snapshot_reference_not_blank
    CHECK (BTRIM(snapshot_reference) <> ''),
  CONSTRAINT document_versions_restored_revision_non_negative
    CHECK (restored_from_revision IS NULL OR restored_from_revision >= 0),
  CONSTRAINT document_versions_restored_revision_precedes_version
    CHECK (
      restored_from_revision IS NULL OR restored_from_revision <= revision
    ),
  CONSTRAINT document_versions_restored_revision_exists
    FOREIGN KEY (document_id, restored_from_revision)
    REFERENCES document_versions (document_id, revision)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE IF NOT EXISTS editors (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL UNIQUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT editors_email_normalized CHECK (
    email = LOWER(BTRIM(email)) AND email <> ''
  )
);

CREATE TABLE IF NOT EXISTS document_editors (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  editor_id UUID NOT NULL REFERENCES editors(id),
  role VARCHAR(16) NOT NULL,
  PRIMARY KEY (document_id, editor_id),
  CONSTRAINT document_editors_role_valid CHECK (role IN ('owner', 'editor'))
);

CREATE UNIQUE INDEX IF NOT EXISTS document_editors_one_owner_per_document
  ON document_editors (document_id)
  WHERE role = 'owner';

-- Existing documents remain without an owner until one is explicitly assigned.
-- Future document creation must insert the document and its owner association
-- atomically in the same PostgreSQL transaction.

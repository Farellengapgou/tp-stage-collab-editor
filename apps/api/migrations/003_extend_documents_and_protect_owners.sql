ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_revision INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT documents_current_revision_non_negative
    CHECK (current_revision >= 0);

CREATE OR REPLACE FUNCTION set_documents_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_set_updated_at ON documents;

CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW
EXECUTE FUNCTION set_documents_updated_at();

CREATE OR REPLACE FUNCTION prevent_document_owner_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.role = 'owner' THEN
    RAISE EXCEPTION 'The owner association of a document cannot be removed';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner' THEN
    RAISE EXCEPTION 'The owner association of a document cannot be downgraded';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_editors_prevent_owner_removal ON document_editors;

CREATE TRIGGER document_editors_prevent_owner_removal
BEFORE DELETE OR UPDATE OF role ON document_editors
FOR EACH ROW
EXECUTE FUNCTION prevent_document_owner_removal();

CREATE INDEX IF NOT EXISTS document_editors_editor_id_idx
  ON document_editors (editor_id);

-- Existing documents remain ownerless. Future creation must insert the
-- document, its initial document state and its owner association atomically.

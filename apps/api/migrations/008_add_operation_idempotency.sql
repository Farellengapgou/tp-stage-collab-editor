ALTER TABLE edit_operations
  ADD COLUMN IF NOT EXISTS source VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sequence INTEGER;

ALTER TABLE edit_operations
  DROP CONSTRAINT IF EXISTS edit_operations_sequence_non_negative;

ALTER TABLE edit_operations
  ADD CONSTRAINT edit_operations_sequence_non_negative
  CHECK (sequence IS NULL OR sequence >= 0);

ALTER TABLE edit_operations
  DROP CONSTRAINT IF EXISTS edit_operations_source_sequence_pair;

ALTER TABLE edit_operations
  ADD CONSTRAINT edit_operations_source_sequence_pair
  CHECK ((source IS NULL) = (sequence IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS edit_operations_document_source_sequence_unique
  ON edit_operations (document_id, source, sequence)
  WHERE source IS NOT NULL AND sequence IS NOT NULL;

-- Immutable file snapshots advance independently of the native SQLite baseline.
-- Keep all receipts until retention has proved that no recovery reader needs them.
CREATE TABLE runtime_file_revision (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_id TEXT,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  writer_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (account_id, workspace_id, revision_id),
  UNIQUE (account_id, workspace_id, sequence),
  FOREIGN KEY (account_id, workspace_id)
    REFERENCES runtime_history_checkpoint(account_id, workspace_id) ON DELETE CASCADE
);

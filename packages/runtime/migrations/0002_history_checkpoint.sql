-- Forward-only additive migration. Never drop checkpoint rows during rollback.
-- After publication, only checkpoint-aware releases may resume this scope.
CREATE TABLE runtime_history_checkpoint (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  writer_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (account_id, workspace_id),
  FOREIGN KEY (account_id, workspace_id)
    REFERENCES runtime_history_writer(account_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE runtime_history_checkpoint_event (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (account_id, workspace_id, event_id),
  UNIQUE (account_id, workspace_id, aggregate_id, seq),
  FOREIGN KEY (account_id, workspace_id)
    REFERENCES runtime_history_checkpoint(account_id, workspace_id) ON DELETE CASCADE
);

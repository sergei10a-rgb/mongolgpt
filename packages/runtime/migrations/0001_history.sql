CREATE TABLE runtime_history_writer (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  writer_id TEXT NOT NULL,
  PRIMARY KEY (account_id, workspace_id)
);

CREATE TABLE runtime_history_session (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT -1 CHECK (seq >= -1),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (account_id, workspace_id, session_id),
  FOREIGN KEY (account_id, workspace_id)
    REFERENCES runtime_history_writer(account_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE runtime_history_event (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT,
  data TEXT,
  digest TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  CHECK ((deleted = 0 AND type IS NOT NULL AND data IS NOT NULL)
    OR (deleted = 1 AND type IS NULL AND data IS NULL)),
  UNIQUE (account_id, workspace_id, event_id),
  UNIQUE (account_id, workspace_id, session_id, seq),
  FOREIGN KEY (account_id, workspace_id, session_id)
    REFERENCES runtime_history_session(account_id, workspace_id, session_id) ON DELETE CASCADE
);

CREATE INDEX runtime_history_replay ON runtime_history_event(account_id, workspace_id, cursor);

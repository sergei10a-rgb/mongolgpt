-- Minimal control inventory survives cleanup so retired accounts cannot reopen.
CREATE TABLE runtime_sandbox (
  object_id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL
);
CREATE INDEX runtime_sandbox_account ON runtime_sandbox(account_id, workspace_id);
CREATE TRIGGER runtime_sandbox_retired_insert BEFORE INSERT ON runtime_sandbox
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'runtime_account_retired'); END;
CREATE TRIGGER runtime_sandbox_immutable BEFORE UPDATE ON runtime_sandbox
BEGIN SELECT RAISE(ABORT, 'runtime_sandbox_is_immutable'); END;
CREATE TRIGGER runtime_sandbox_keep BEFORE DELETE ON runtime_sandbox
BEGIN SELECT RAISE(ABORT, 'runtime_sandbox_inventory_required'); END;

CREATE TABLE runtime_account_cleanup (
  account_id TEXT NOT NULL PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  workspace_ids TEXT NOT NULL CHECK (json_valid(workspace_ids)),
  phase INTEGER NOT NULL DEFAULT 0 CHECK (phase BETWEEN 0 AND 5),
  cursor TEXT NOT NULL DEFAULT ''
);
CREATE TRIGGER runtime_account_cleanup_immutable BEFORE UPDATE ON runtime_account_cleanup
WHEN NEW.account_id != OLD.account_id OR NEW.request_id != OLD.request_id OR
  NEW.workspace_ids != OLD.workspace_ids OR NEW.phase < OLD.phase
BEGIN SELECT RAISE(ABORT, 'runtime_cleanup_is_immutable'); END;
CREATE TRIGGER runtime_account_cleanup_keep BEFORE DELETE ON runtime_account_cleanup
BEGIN SELECT RAISE(ABORT, 'runtime_cleanup_receipt_required'); END;

CREATE TABLE runtime_account_cleanup_workspace (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  PRIMARY KEY (account_id, workspace_id),
  FOREIGN KEY (account_id) REFERENCES runtime_account_cleanup(account_id)
);
CREATE TRIGGER runtime_cleanup_workspace_insert BEFORE INSERT ON runtime_account_cleanup_workspace
WHEN NOT EXISTS (SELECT 1 FROM runtime_account_cleanup
  WHERE account_id = NEW.account_id AND phase = 0)
BEGIN SELECT RAISE(ABORT, 'runtime_cleanup_inventory_closed'); END;
CREATE TRIGGER runtime_cleanup_workspace_immutable BEFORE UPDATE ON runtime_account_cleanup_workspace
WHEN NEW.account_id != OLD.account_id OR NEW.workspace_id != OLD.workspace_id OR NEW.stopped < OLD.stopped
BEGIN SELECT RAISE(ABORT, 'runtime_cleanup_scope_is_immutable'); END;
CREATE TRIGGER runtime_cleanup_workspace_keep BEFORE DELETE ON runtime_account_cleanup_workspace
BEGIN SELECT RAISE(ABORT, 'runtime_cleanup_scope_required'); END;

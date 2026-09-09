-- Reserve every immutable R2 object before issuing its write. An uncertain write
-- may finish after its Worker dies; never infer settlement from elapsed time.
CREATE TABLE runtime_backup_write (
  object_key TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
  CHECK (substr(object_key, 1, length('runtime-backups/v1/' || account_id || '/' || workspace_id || '/')) =
    'runtime-backups/v1/' || account_id || '/' || workspace_id || '/')
);

CREATE INDEX runtime_backup_write_account ON runtime_backup_write (account_id, object_key);

CREATE TRIGGER runtime_backup_write_retired_insert
BEFORE INSERT ON runtime_backup_write
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_backup_write_immutable
BEFORE UPDATE ON runtime_backup_write
WHEN NEW.object_key != OLD.object_key OR NEW.account_id != OLD.account_id OR
  NEW.workspace_id != OLD.workspace_id OR NEW.settled < OLD.settled
BEGIN
  SELECT RAISE(ABORT, 'runtime_backup_write_is_immutable');
END;

-- A settled receipt may arrive after retirement. Only this one-way transition
-- permits removing an otherwise permanent zero-byte R2 write fence later.
CREATE TRIGGER runtime_backup_write_guard_delete
BEFORE DELETE ON runtime_backup_write
WHEN OLD.settled = 0 OR NOT EXISTS (
  SELECT 1 FROM runtime_history_retirement WHERE account_id = OLD.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'runtime_backup_write_still_required');
END;

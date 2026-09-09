-- Permanent account fence; contains no email, credentials or content.
-- This does NOT erase retained data or stop running containers. A trusted cleanup
-- coordinator must drain in-flight work before deleting content. Keep the fence
-- after cleanup to prevent a delayed process from recreating the account's data.
-- Forward-only: once any account is retired, do not roll back to a Worker that
-- lacks retirement read/admission checks. Never drop or remove these markers.
CREATE TABLE runtime_history_retirement (
  account_id TEXT NOT NULL PRIMARY KEY
);

CREATE TRIGGER runtime_history_retirement_no_update
BEFORE UPDATE ON runtime_history_retirement
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retirement_is_permanent');
END;

CREATE TRIGGER runtime_history_retirement_no_delete
BEFORE DELETE ON runtime_history_retirement
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retirement_is_permanent');
END;

CREATE TRIGGER runtime_history_writer_retired_insert
BEFORE INSERT ON runtime_history_writer
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_writer_retired_update
BEFORE UPDATE ON runtime_history_writer
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id OR account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_session_retired_insert
BEFORE INSERT ON runtime_history_session
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_session_retired_update
BEFORE UPDATE ON runtime_history_session
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id OR account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_event_retired_insert
BEFORE INSERT ON runtime_history_event
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_event_retired_update
BEFORE UPDATE ON runtime_history_event
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id OR account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_checkpoint_retired_insert
BEFORE INSERT ON runtime_history_checkpoint
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_checkpoint_retired_update
BEFORE UPDATE ON runtime_history_checkpoint
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id OR account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_checkpoint_event_retired_insert
BEFORE INSERT ON runtime_history_checkpoint_event
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_history_checkpoint_event_retired_update
BEFORE UPDATE ON runtime_history_checkpoint_event
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id OR account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_file_revision_retired_insert
BEFORE INSERT ON runtime_file_revision
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

CREATE TRIGGER runtime_file_revision_retired_update
BEFORE UPDATE ON runtime_file_revision
WHEN EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = NEW.account_id OR account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runtime_account_retired');
END;

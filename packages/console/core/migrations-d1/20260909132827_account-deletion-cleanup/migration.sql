CREATE TABLE `account_deletion_cleanup` (
	`request_id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`workspace_ids` text NOT NULL,
	`pseudonymous_account_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`time_lease_expires` integer,
	`time_next_attempt` integer NOT NULL,
	`time_runtime_completed` integer,
	`time_completed` integer,
	`last_error_code` text,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT `fk_account_deletion_cleanup_request_id_account_deletion_id_fk` FOREIGN KEY (`request_id`) REFERENCES `account_deletion`(`id`),
	CONSTRAINT "account_deletion_cleanup_attempts" CHECK("attempts" >= 0),
	CONSTRAINT "account_deletion_cleanup_workspaces" CHECK(json_valid("workspace_ids") and json_type("workspace_ids") = 'array'),
	CONSTRAINT "account_deletion_cleanup_lease" CHECK(("lease_id" is null) = ("time_lease_expires" is null)),
	CONSTRAINT "account_deletion_cleanup_completion" CHECK("time_completed" is null or "time_runtime_completed" is not null),
	CONSTRAINT "account_deletion_cleanup_error" CHECK("last_error_code" is null or "last_error_code" in ('runtime_cleanup_failed', 'account_cleanup_failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_cleanup_account` ON `account_deletion_cleanup` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_deletion_cleanup_due` ON `account_deletion_cleanup` (`time_next_attempt`,`time_lease_expires`);
--> statement-breakpoint
-- Once retirement starts, old code cannot reopen the request or discard its inventory.
CREATE TRIGGER account_cleanup_immutable BEFORE UPDATE ON account_deletion_cleanup
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.account_id IS NOT OLD.account_id
  OR NEW.workspace_ids IS NOT OLD.workspace_ids OR NEW.pseudonymous_account_id IS NOT OLD.pseudonymous_account_id
  OR (OLD.time_runtime_completed IS NOT NULL AND NEW.time_runtime_completed IS NOT OLD.time_runtime_completed)
  OR (OLD.time_completed IS NOT NULL AND NEW.time_completed IS NOT OLD.time_completed)
BEGIN SELECT RAISE(ABORT, 'account_cleanup_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_pending_delete BEFORE DELETE ON account_deletion_cleanup
WHEN OLD.time_completed IS NULL
BEGIN SELECT RAISE(ABORT, 'account_cleanup_pending'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_request_fence BEFORE UPDATE ON account_deletion
WHEN EXISTS (SELECT 1 FROM account_deletion_cleanup c WHERE c.request_id = OLD.id AND c.time_completed IS NULL)
  AND (NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.status <> 'processing' OR NEW.time_deleted IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account_cleanup_pending'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_access_fence BEFORE UPDATE ON account
WHEN EXISTS (SELECT 1 FROM account_deletion_cleanup c WHERE c.account_id = OLD.id)
  AND ((OLD.time_deleted IS NOT NULL AND NEW.time_deleted IS NULL) OR NEW.auth_version < OLD.auth_version)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_user_insert BEFORE INSERT ON user
WHEN EXISTS (SELECT 1 FROM account a JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE a.id = NEW.account_id AND a.time_deleted IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_user_update BEFORE UPDATE ON user
WHEN (
  EXISTS (SELECT 1 FROM account a JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE a.id = OLD.account_id AND a.time_deleted IS NOT NULL)
  AND (NEW.workspace_id IS NOT OLD.workspace_id OR (NEW.account_id IS NOT OLD.account_id
    AND NOT (NEW.account_id IS NULL AND NEW.email IS NULL AND NEW.name = '' AND NEW.time_deleted IS NOT NULL)))
) OR (
  NEW.account_id IS NOT OLD.account_id
  AND EXISTS (SELECT 1 FROM account a JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE a.id = NEW.account_id AND a.time_deleted IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_user_delete BEFORE DELETE ON user
WHEN EXISTS (SELECT 1 FROM account a JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE a.id = OLD.account_id AND a.time_deleted IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_auth_insert BEFORE INSERT ON auth
WHEN EXISTS (SELECT 1 FROM account a JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE a.id = NEW.account_id AND a.time_deleted IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_auth_update BEFORE UPDATE ON auth
WHEN EXISTS (SELECT 1 FROM account a JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE a.id IN (NEW.account_id, OLD.account_id) AND a.time_deleted IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
-- A request admitted before retirement must not attach a member to a closing workspace.
CREATE TRIGGER account_cleanup_workspace_user_insert BEFORE INSERT ON user
WHEN NEW.time_deleted IS NULL AND (
  EXISTS (SELECT 1 FROM workspace w WHERE w.id = NEW.workspace_id AND w.time_deleted IS NOT NULL)
  OR EXISTS (SELECT 1 FROM user u JOIN account a ON a.id = u.account_id JOIN account_deletion_cleanup c ON c.account_id = a.id
    WHERE u.workspace_id = NEW.workspace_id AND a.time_deleted IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user v JOIN account b ON b.id = v.account_id
        WHERE v.workspace_id = NEW.workspace_id AND v.time_deleted IS NULL AND b.time_deleted IS NULL))
)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_workspace_user_update BEFORE UPDATE ON user
WHEN NEW.time_deleted IS NULL AND (NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.account_id IS NOT OLD.account_id OR OLD.time_deleted IS NOT NULL) AND (
  EXISTS (SELECT 1 FROM workspace w WHERE w.id = NEW.workspace_id AND w.time_deleted IS NOT NULL)
  OR EXISTS (SELECT 1 FROM user u JOIN account a ON a.id = u.account_id JOIN account_deletion_cleanup c ON c.account_id = a.id
    WHERE u.workspace_id = NEW.workspace_id AND a.time_deleted IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user v JOIN account b ON b.id = v.account_id
        WHERE v.workspace_id = NEW.workspace_id AND v.time_deleted IS NULL AND b.time_deleted IS NULL))
)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_key_insert BEFORE INSERT ON key
WHEN NEW.time_deleted IS NULL AND (
  EXISTS (SELECT 1 FROM user u JOIN account a ON a.id = u.account_id JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE u.id = NEW.user_id AND u.workspace_id = NEW.workspace_id AND a.time_deleted IS NOT NULL)
  OR EXISTS (SELECT 1 FROM workspace w WHERE w.id = NEW.workspace_id AND w.time_deleted IS NOT NULL)
  OR EXISTS (SELECT 1 FROM user u JOIN account a ON a.id = u.account_id JOIN account_deletion_cleanup c ON c.account_id = a.id
    WHERE u.workspace_id = NEW.workspace_id AND a.time_deleted IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user v JOIN account b ON b.id = v.account_id
        WHERE v.workspace_id = NEW.workspace_id AND v.time_deleted IS NULL AND b.time_deleted IS NULL))
)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;
--> statement-breakpoint
CREATE TRIGGER account_cleanup_key_update BEFORE UPDATE ON key
WHEN NEW.time_deleted IS NULL AND (
  EXISTS (SELECT 1 FROM user u JOIN account a ON a.id = u.account_id JOIN account_deletion_cleanup c ON c.account_id = a.id WHERE u.id = NEW.user_id AND u.workspace_id = NEW.workspace_id AND a.time_deleted IS NOT NULL)
  OR EXISTS (SELECT 1 FROM workspace w WHERE w.id = NEW.workspace_id AND w.time_deleted IS NOT NULL)
  OR EXISTS (SELECT 1 FROM user u JOIN account a ON a.id = u.account_id JOIN account_deletion_cleanup c ON c.account_id = a.id
    WHERE u.workspace_id = NEW.workspace_id AND a.time_deleted IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user v JOIN account b ON b.id = v.account_id
        WHERE v.workspace_id = NEW.workspace_id AND v.time_deleted IS NULL AND b.time_deleted IS NULL))
)
BEGIN SELECT RAISE(ABORT, 'account_retired'); END;

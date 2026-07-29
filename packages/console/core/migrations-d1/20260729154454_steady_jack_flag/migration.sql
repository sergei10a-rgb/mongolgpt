CREATE TABLE `admin_audit_log` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`admin_id` text(30),
	`actor_email` text(254) NOT NULL,
	`action` text(128) NOT NULL,
	`target_type` text(64),
	`target_id` text(255),
	`outcome` text NOT NULL,
	`request_id` text(128) NOT NULL,
	`source_ip` text(45),
	`user_agent` text(512),
	`metadata` text,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "admin_audit_log_outcome_check" CHECK("outcome" in ('success', 'denied', 'failure')),
	CONSTRAINT "admin_audit_log_metadata_json_check" CHECK("metadata" is null or json_valid("metadata"))
);
--> statement-breakpoint
CREATE TABLE `platform_admin` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`email` text(254) NOT NULL,
	`access_subject` text(255),
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`time_last_seen` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "platform_admin_email_normalized_check" CHECK("email" = lower(trim("email")) and length("email") between 3 and 254),
	CONSTRAINT "platform_admin_role_check" CHECK("role" in ('owner', 'administrator', 'support', 'finance', 'operations')),
	CONSTRAINT "platform_admin_status_check" CHECK("status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE INDEX `admin_audit_log_time_created` ON `admin_audit_log` (`time_created`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_admin_time_created` ON `admin_audit_log` (`admin_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_action_time_created` ON `admin_audit_log` (`action`,`time_created`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_admin_email` ON `platform_admin` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_admin_access_subject` ON `platform_admin` (`access_subject`);--> statement-breakpoint
CREATE INDEX `platform_admin_status_role` ON `platform_admin` (`status`,`role`);--> statement-breakpoint
CREATE TRIGGER `admin_audit_log_no_update`
BEFORE UPDATE ON `admin_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'admin_audit_log is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `admin_audit_log_no_delete`
BEFORE DELETE ON `admin_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'admin_audit_log is immutable');
END;

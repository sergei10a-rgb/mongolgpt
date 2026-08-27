CREATE TABLE `plan_config_active` (
	`id` integer PRIMARY KEY,
	`active_version_id` text(30) NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_by` text(30) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "plan_config_active_singleton_check" CHECK("id" = 1),
	CONSTRAINT "plan_config_active_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `plan_config_version` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`limits` text NOT NULL,
	`created_by` text(30) NOT NULL,
	`source_version_id` text(30),
	`note` text(500),
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "plan_config_version_revision_check" CHECK("revision" > 0),
	CONSTRAINT "plan_config_version_limits_json_check" CHECK(json_valid("limits")),
	CONSTRAINT "plan_config_version_note_check" CHECK("note" is null or length(trim("note")) between 1 and 500)
);
--> statement-breakpoint
CREATE INDEX `plan_config_active_version` ON `plan_config_active` (`active_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_config_version_revision` ON `plan_config_version` (`revision`);--> statement-breakpoint
CREATE INDEX `plan_config_version_time_created` ON `plan_config_version` (`time_created`);--> statement-breakpoint
CREATE INDEX `plan_config_version_source_version` ON `plan_config_version` (`source_version_id`);
--> statement-breakpoint
CREATE TRIGGER `plan_config_version_no_update`
BEFORE UPDATE ON `plan_config_version`
BEGIN
	SELECT RAISE(ABORT, 'plan_config_version is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `plan_config_version_no_delete`
BEFORE DELETE ON `plan_config_version`
BEGIN
	SELECT RAISE(ABORT, 'plan_config_version is immutable');
END;

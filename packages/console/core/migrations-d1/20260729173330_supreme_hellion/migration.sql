ALTER TABLE `account` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `account` ADD `auth_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `account` ADD `suspension_reason` text(500);--> statement-breakpoint
ALTER TABLE `account` ADD `suspended_by` text(30);--> statement-breakpoint
ALTER TABLE `account` ADD `time_suspended` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`auth_version` integer DEFAULT 0 NOT NULL,
	`suspension_reason` text(500),
	`suspended_by` text(30),
	`time_suspended` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "account_status_check" CHECK("status" in ('active', 'suspended')),
	CONSTRAINT "account_auth_version_check" CHECK("auth_version" >= 0),
	CONSTRAINT "account_suspension_check" CHECK((
        "status" = 'active'
        and "suspension_reason" is null
        and "suspended_by" is null
        and "time_suspended" is null
      ) or (
        "status" = 'suspended'
        and length(trim("suspension_reason")) between 10 and 500
        and "suspended_by" is not null
        and "time_suspended" is not null
      ))
);
--> statement-breakpoint
INSERT INTO `__new_account`(`id`, `time_created`, `time_updated`, `time_deleted`) SELECT `id`, `time_created`, `time_updated`, `time_deleted` FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `account_status_id` ON `account` (`status`,`id`);
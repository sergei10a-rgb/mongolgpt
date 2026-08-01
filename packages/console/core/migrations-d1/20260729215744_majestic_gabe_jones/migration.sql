CREATE TABLE `account_deletion` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`account_id` text(30) NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text(64),
	`time_eligible` integer NOT NULL,
	`time_started` integer,
	`time_completed` integer,
	`time_cancelled` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "account_deletion_status_check" CHECK("status" in ('requested', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "account_deletion_attempts_check" CHECK("attempts" >= 0 and "attempts" <= 5),
	CONSTRAINT "account_deletion_state_check" CHECK((
        "status" = 'requested'
        and "time_started" is null
        and "time_completed" is null
        and "time_cancelled" is null
        and "last_error_code" is null
      ) or (
        "status" = 'failed'
        and "time_started" is not null
        and "time_completed" is null
        and "time_cancelled" is null
        and length(trim("last_error_code")) between 1 and 64
      ) or (
        "status" = 'processing'
        and "time_started" is not null
        and "time_completed" is null
        and "time_cancelled" is null
        and "last_error_code" is null
      ) or (
        "status" = 'completed'
        and "time_started" is not null
        and "time_completed" is not null
        and "time_cancelled" is null
        and "last_error_code" is null
      ) or (
        "status" = 'cancelled'
        and "time_started" is null
        and "time_completed" is null
        and "time_cancelled" is not null
        and "last_error_code" is null
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_account_id` ON `account_deletion` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_deletion_status_eligible` ON `account_deletion` (`status`,`time_eligible`);
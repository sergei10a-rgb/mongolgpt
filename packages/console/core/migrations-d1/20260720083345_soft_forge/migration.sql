CREATE TABLE `plan_subscription` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`invoice_id` text(30) NOT NULL,
	`plan` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`time_period_start` integer NOT NULL,
	`time_period_end` integer NOT NULL,
	`time_cancelled` integer,
	`time_refunded` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "plan_subscription_plan_check" CHECK("plan" in ('basic', 'pro', 'max')),
	CONSTRAINT "plan_subscription_status_check" CHECK("status" in ('active', 'expired', 'cancelled', 'refunded')),
	CONSTRAINT "plan_subscription_period_check" CHECK("time_period_end" > "time_period_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_subscription_invoice_id` ON `plan_subscription` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `plan_subscription_workspace_period_end` ON `plan_subscription` (`workspace_id`,`time_period_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_subscription_workspace_active` ON `plan_subscription` (`workspace_id`) WHERE "plan_subscription"."status" = 'active' and "plan_subscription"."time_deleted" is null;
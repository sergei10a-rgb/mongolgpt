CREATE TABLE `account` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer
);
--> statement-breakpoint
CREATE TABLE `auth` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`provider` text NOT NULL,
	`subject` text(255) NOT NULL,
	`account_id` text(30) NOT NULL,
	CONSTRAINT "auth_provider_check" CHECK("provider" in ('email', 'github', 'google'))
);
--> statement-breakpoint
CREATE TABLE `benchmark` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`model` text(64) NOT NULL,
	`agent` text(64) NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`customer_id` text(255),
	`payment_method_id` text(255),
	`payment_method_type` text(32),
	`payment_method_last4` text(4),
	`balance` integer NOT NULL,
	`monthly_limit` integer,
	`monthly_usage` integer,
	`time_monthly_usage_updated` integer,
	`reload` integer,
	`reload_trigger` integer,
	`reload_amount` integer,
	`reload_error` text(255),
	`time_reload_error` integer,
	`time_reload_locked_till` integer,
	`subscription` text,
	`subscription_id` text(28),
	`subscription_plan` text,
	`time_subscription_booked` integer,
	`time_subscription_selected` integer,
	`lite_subscription_id` text(28),
	`lite` text,
	CONSTRAINT `billing_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "billing_subscription_plan_check" CHECK("subscription_plan" is null or "subscription_plan" in ('basic', 'pro', 'max')),
	CONSTRAINT "billing_subscription_json_check" CHECK("subscription" is null or json_valid("subscription")),
	CONSTRAINT "billing_lite_json_check" CHECK("lite" is null or json_valid("lite"))
);
--> statement-breakpoint
CREATE TABLE `coupon` (
	`email` text(255),
	`type` text NOT NULL,
	`time_redeemed` integer,
	CONSTRAINT `coupon_pk` PRIMARY KEY(`email`, `type`),
	CONSTRAINT "coupon_type_check" CHECK("type" in ('BUILDATHON', 'GO1MONTH50', 'GOFREEMONTH', 'GO3MONTHS100', 'GO6MONTHS100', 'GO12MONTHS100'))
);
--> statement-breakpoint
CREATE TABLE `ip_rate_limit` (
	`ip` text(45) NOT NULL,
	`interval` text(10) NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `ip_rate_limit_pk` PRIMARY KEY(`ip`, `interval`)
);
--> statement-breakpoint
CREATE TABLE `ip` (
	`ip` text(45) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`usage` integer
);
--> statement-breakpoint
CREATE TABLE `key_rate_limit` (
	`key` text(255) NOT NULL,
	`interval` text(40) NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `key_rate_limit_pk` PRIMARY KEY(`key`, `interval`)
);
--> statement-breakpoint
CREATE TABLE `key` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`name` text(255) NOT NULL,
	`key` text(255) NOT NULL,
	`user_id` text(30) NOT NULL,
	`time_used` integer,
	CONSTRAINT `key_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `lite` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`user_id` text(30) NOT NULL,
	`rolling_usage` integer,
	`weekly_usage` integer,
	`monthly_usage` integer,
	`time_rolling_updated` integer,
	`time_weekly_updated` integer,
	`time_monthly_updated` integer,
	CONSTRAINT `lite_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `model_sticky_provider` (
	`id` text(255) PRIMARY KEY NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`provider_id` text(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`model` text(64) NOT NULL,
	CONSTRAINT `model_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `model_tpm_rate_limit` (
	`id` text(255) NOT NULL,
	`interval` integer NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `model_tpm_rate_limit_pk` PRIMARY KEY(`id`, `interval`)
);
--> statement-breakpoint
CREATE TABLE `model_tps_rate_limit` (
	`id` text(255) NOT NULL,
	`interval` integer NOT NULL,
	`qualify` integer NOT NULL,
	`unqualify` integer NOT NULL,
	CONSTRAINT `model_tps_rate_limit_pk` PRIMARY KEY(`id`, `interval`)
);
--> statement-breakpoint
CREATE TABLE `payment` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`customer_id` text(255),
	`invoice_id` text(255),
	`payment_id` text(255),
	`amount` integer NOT NULL,
	`time_refunded` integer,
	`enrichment` text,
	CONSTRAINT `payment_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "payment_enrichment_json_check" CHECK("enrichment" is null or json_valid("enrichment"))
);
--> statement-breakpoint
CREATE TABLE `provider` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`provider` text(64) NOT NULL,
	`credentials` text NOT NULL,
	CONSTRAINT `provider_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `referral_code` (
	`workspace_id` text(30) PRIMARY KEY NOT NULL,
	`code` text(10) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer
);
--> statement-breakpoint
CREATE TABLE `referral_reward` (
	`workspace_id` text(30) NOT NULL,
	`referral_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`amount` integer NOT NULL,
	`time_applied` integer,
	CONSTRAINT `referral_reward_pk` PRIMARY KEY(`workspace_id`, `referral_id`)
);
--> statement-breakpoint
CREATE TABLE `referral` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`invitee_account_id` text(30) NOT NULL,
	CONSTRAINT `referral_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`user_id` text(30) NOT NULL,
	`rolling_usage` integer,
	`fixed_usage` integer,
	`weekly_tokens` integer,
	`time_rolling_updated` integer,
	`time_fixed_updated` integer,
	`time_weekly_tokens_updated` integer,
	CONSTRAINT `subscription_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`model` text(255) NOT NULL,
	`provider` text(255) NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reasoning_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_5m_tokens` integer,
	`cache_write_1h_tokens` integer,
	`cost` integer NOT NULL,
	`key_id` text(30),
	`session_id` text(30),
	`enrichment` text,
	CONSTRAINT `usage_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "usage_enrichment_json_check" CHECK("enrichment" is null or json_valid("enrichment"))
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`account_id` text(30),
	`email` text(255),
	`name` text(255) NOT NULL,
	`time_seen` integer,
	`color` integer,
	`role` text NOT NULL,
	`monthly_limit` integer,
	`monthly_usage` integer,
	`time_monthly_usage_updated` integer,
	CONSTRAINT `user_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "user_role_check" CHECK("role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`slug` text(255),
	`name` text(255) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_provider_subject` ON `auth` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `auth_account_id` ON `auth` (`account_id`);--> statement-breakpoint
CREATE INDEX `benchmark_time_created` ON `benchmark` (`time_created`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_global_customer_id` ON `billing` (`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_global_subscription_id` ON `billing` (`subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `key_global_key` ON `key` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `lite_workspace_user_id` ON `lite` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `model_workspace_model` ON `model` (`workspace_id`,`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_workspace_provider` ON `provider` (`workspace_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_code_code` ON `referral_code` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_invitee_account_id` ON `referral` (`invitee_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_workspace_user_id` ON `subscription` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `usage_workspace_time_created` ON `usage` (`workspace_id`,`time_created`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_workspace_account_id` ON `user` (`workspace_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_workspace_email` ON `user` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `user_global_account_id` ON `user` (`account_id`);--> statement-breakpoint
CREATE INDEX `user_global_email` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_slug` ON `workspace` (`slug`);
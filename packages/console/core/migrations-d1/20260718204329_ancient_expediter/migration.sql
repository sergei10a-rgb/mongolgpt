CREATE TABLE `payment_event` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`invoice_id` text(30) NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`provider` text NOT NULL,
	`merchant_account_id` text(255) NOT NULL,
	`external_event_id` text(255) NOT NULL,
	`external_invoice_id` text(255) NOT NULL,
	`external_payment_id` text(255),
	`amount` integer,
	`currency` text,
	`type` text NOT NULL,
	`outcome` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`payload_hash` text(64) NOT NULL,
	`time_occurred` integer NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "payment_event_provider_check" CHECK("provider" in ('qpay', 'bonum')),
	CONSTRAINT "payment_event_amount_currency_check" CHECK(("amount" is null and "currency" is null)
        or ("amount" > 0 and "currency" = 'MNT')),
	CONSTRAINT "payment_event_type_check" CHECK("type" in ('pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
	CONSTRAINT "payment_event_outcome_check" CHECK("outcome" in ('applied', 'noop', 'rejected')),
	CONSTRAINT "payment_event_from_status_check" CHECK("from_status" in ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
	CONSTRAINT "payment_event_to_status_check" CHECK("to_status" in ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
	CONSTRAINT "payment_event_payload_hash_check" CHECK(length("payload_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE `payment_invoice` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`provider` text NOT NULL,
	`merchant_account_id` text(255) NOT NULL,
	`external_invoice_id` text(255) NOT NULL,
	`external_payment_id` text(255),
	`purpose` text NOT NULL,
	`plan` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'MNT' NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`time_expires` integer,
	`time_failed` integer,
	`time_expired` integer,
	`time_cancelled` integer,
	`time_verified` integer,
	`time_refunded` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "payment_invoice_provider_check" CHECK("provider" in ('qpay', 'bonum')),
	CONSTRAINT "payment_invoice_purpose_check" CHECK("purpose" in ('subscription', 'credit')),
	CONSTRAINT "payment_invoice_plan_check" CHECK(("purpose" = 'subscription' and "plan" in ('basic', 'pro', 'max'))
        or ("purpose" = 'credit' and "plan" is null)),
	CONSTRAINT "payment_invoice_amount_check" CHECK("amount" > 0),
	CONSTRAINT "payment_invoice_currency_check" CHECK("currency" = 'MNT'),
	CONSTRAINT "payment_invoice_status_check" CHECK("status" in ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE INDEX `payment_event_invoice_time_created` ON `payment_event` (`invoice_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `payment_event_workspace_time_created` ON `payment_event` (`workspace_id`,`time_created`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_event_merchant_external_event` ON `payment_event` (`provider`,`merchant_account_id`,`external_event_id`);--> statement-breakpoint
CREATE INDEX `payment_invoice_workspace_time_created` ON `payment_invoice` (`workspace_id`,`time_created`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_invoice_merchant_external_invoice` ON `payment_invoice` (`provider`,`merchant_account_id`,`external_invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_invoice_merchant_external_payment` ON `payment_invoice` (`provider`,`merchant_account_id`,`external_payment_id`);
CREATE TABLE `payment_checkout` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`account_id` text(30) NOT NULL,
	`request_key` text(64) NOT NULL,
	`provider` text NOT NULL,
	`merchant_account_id` text(255) NOT NULL,
	`external_invoice_id` text(255),
	`purpose` text NOT NULL,
	`plan` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'MNT' NOT NULL,
	`checkout` text,
	`creation_error_code` text(64),
	`status` text DEFAULT 'creating' NOT NULL,
	`time_expires` integer NOT NULL,
	`time_ready` integer,
	`time_failed` integer,
	`time_expired` integer,
	`time_cancelled` integer,
	`time_paid` integer,
	`time_refunded` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "payment_checkout_provider_check" CHECK("provider" in ('qpay', 'bonum')),
	CONSTRAINT "payment_checkout_purpose_check" CHECK("purpose" in ('subscription', 'credit')),
	CONSTRAINT "payment_checkout_plan_check" CHECK(("purpose" = 'subscription' and "plan" in ('basic', 'pro', 'max'))
        or ("purpose" = 'credit' and "plan" is null)),
	CONSTRAINT "payment_checkout_amount_check" CHECK("amount" > 0),
	CONSTRAINT "payment_checkout_currency_check" CHECK("currency" = 'MNT'),
	CONSTRAINT "payment_checkout_json_check" CHECK("checkout" is null or json_valid("checkout")),
	CONSTRAINT "payment_checkout_status_check" CHECK("status" in ('creating', 'unknown', 'ready', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
	CONSTRAINT "payment_checkout_ready_check" CHECK(("status" in ('creating', 'unknown', 'failed') and "external_invoice_id" is null and "checkout" is null)
        or ("status" = 'expired' and (
          ("external_invoice_id" is null and "checkout" is null)
          or ("external_invoice_id" is not null and "checkout" is not null)
        ))
        or ("status" in ('ready', 'pending', 'paid', 'cancelled', 'refunded')
          and "external_invoice_id" is not null and "checkout" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkout_workspace_request_key` ON `payment_checkout` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkout_workspace_open_subscription` ON `payment_checkout` (`workspace_id`) WHERE "payment_checkout"."purpose" = 'subscription'
          and "payment_checkout"."status" in ('creating', 'unknown', 'ready', 'pending')
          and "payment_checkout"."time_deleted" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkout_merchant_external_invoice` ON `payment_checkout` (`provider`,`merchant_account_id`,`external_invoice_id`);--> statement-breakpoint
CREATE INDEX `payment_checkout_status_time_expires` ON `payment_checkout` (`status`,`time_expires`);
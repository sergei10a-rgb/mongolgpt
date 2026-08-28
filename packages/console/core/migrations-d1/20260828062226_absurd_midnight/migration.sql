CREATE TABLE `payment_refund` (
	`invoice_id` text(30) PRIMARY KEY NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`account_id` text(30) NOT NULL,
	`request_key` text(64) NOT NULL,
	`provider` text NOT NULL,
	`merchant_account_id` text(255) NOT NULL,
	`external_invoice_id` text(255) NOT NULL,
	`external_payment_id` text(255) NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'MNT' NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`error_code` text(64),
	`provider_payload_hash` text(64),
	`time_requested` integer NOT NULL,
	`time_completed` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "payment_refund_provider_check" CHECK("provider" in ('qpay', 'bonum')),
	CONSTRAINT "payment_refund_amount_check" CHECK("amount" > 0),
	CONSTRAINT "payment_refund_currency_check" CHECK("currency" = 'MNT'),
	CONSTRAINT "payment_refund_status_check" CHECK("status" in ('requested', 'unknown', 'refunded', 'failed')),
	CONSTRAINT "payment_refund_completion_check" CHECK(("status" in ('requested', 'unknown') and "time_completed" is null)
        or ("status" in ('refunded', 'failed') and "time_completed" is not null)),
	CONSTRAINT "payment_refund_provider_payload_hash_check" CHECK("provider_payload_hash" is null or length("provider_payload_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refund_workspace_request_key` ON `payment_refund` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refund_merchant_external_payment` ON `payment_refund` (`provider`,`merchant_account_id`,`external_payment_id`);--> statement-breakpoint
CREATE INDEX `payment_refund_status_time_requested` ON `payment_refund` (`status`,`time_requested`);
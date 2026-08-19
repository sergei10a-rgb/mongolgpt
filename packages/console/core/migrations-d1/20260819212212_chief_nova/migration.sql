CREATE TABLE `payment_recovery` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`message_hash` text(64) NOT NULL,
	`provider` text,
	`merchant_account_id` text(255),
	`external_event_id` text(255),
	`external_invoice_id` text(255),
	`payload_hash` text(64),
	`event` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text(64),
	`time_next_attempt` integer,
	`time_lease_expires` integer,
	`time_resolved` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "payment_recovery_message_hash_check" CHECK(length("message_hash") = 64),
	CONSTRAINT "payment_recovery_provider_check" CHECK("provider" is null or "provider" in ('qpay', 'bonum')),
	CONSTRAINT "payment_recovery_payload_hash_check" CHECK("payload_hash" is null or length("payload_hash") = 64),
	CONSTRAINT "payment_recovery_event_json_check" CHECK("event" is null or json_valid("event")),
	CONSTRAINT "payment_recovery_identity_check" CHECK(("event" is null
          and "provider" is null
          and "merchant_account_id" is null
          and "external_event_id" is null
          and "external_invoice_id" is null
          and "payload_hash" is null)
        or ("event" is not null
          and "provider" is not null
          and "merchant_account_id" is not null
          and "external_event_id" is not null
          and "external_invoice_id" is not null
          and "payload_hash" is not null)),
	CONSTRAINT "payment_recovery_status_check" CHECK("status" in ('pending', 'processing', 'resolved', 'manual_review')),
	CONSTRAINT "payment_recovery_attempts_check" CHECK("attempts" >= 0 and "attempts" <= 6),
	CONSTRAINT "payment_recovery_state_check" CHECK(("status" = 'pending'
          and "event" is not null
          and "time_next_attempt" is not null
          and "time_lease_expires" is null
          and "time_resolved" is null)
        or ("status" = 'processing'
          and "event" is not null
          and "time_next_attempt" is null
          and "time_lease_expires" is not null
          and "time_resolved" is null
          and "last_error_code" is null)
        or ("status" = 'resolved'
          and "event" is not null
          and "time_next_attempt" is null
          and "time_lease_expires" is null
          and "time_resolved" is not null
          and "last_error_code" is null)
        or ("status" = 'manual_review'
          and "time_next_attempt" is null
          and "time_lease_expires" is null
          and "time_resolved" is null
          and length(trim("last_error_code")) between 1 and 64))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_recovery_message_hash` ON `payment_recovery` (`message_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_recovery_merchant_external_event` ON `payment_recovery` (`provider`,`merchant_account_id`,`external_event_id`);--> statement-breakpoint
CREATE INDEX `payment_recovery_status_next_attempt` ON `payment_recovery` (`status`,`time_next_attempt`);--> statement-breakpoint
CREATE INDEX `payment_recovery_status_lease_expires` ON `payment_recovery` (`status`,`time_lease_expires`);
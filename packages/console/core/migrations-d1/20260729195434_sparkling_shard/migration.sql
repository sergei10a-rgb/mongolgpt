CREATE TABLE `finance_cost_entry` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`category` text NOT NULL,
	`direction` text NOT NULL,
	`basis` text NOT NULL,
	`source_type` text NOT NULL,
	`source_reference` text(255) NOT NULL,
	`usage_id` text(30),
	`payment_invoice_id` text(30),
	`payment_event_id` text(30),
	`provider` text(255),
	`model` text(255),
	`original_amount` integer NOT NULL,
	`original_currency` text NOT NULL,
	`fx_rate_id` text(30),
	`amount_mnt_micros` integer,
	`idempotency_key` text(255) NOT NULL,
	`payload_hash` text(64) NOT NULL,
	`time_effective` integer NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "finance_cost_entry_category_check" CHECK("category" in ('model_cost', 'payment_fee', 'tax', 'adjustment')),
	CONSTRAINT "finance_cost_entry_direction_check" CHECK("direction" in ('debit', 'credit')),
	CONSTRAINT "finance_cost_entry_basis_check" CHECK("basis" in ('estimated', 'actual', 'allocated')),
	CONSTRAINT "finance_cost_entry_source_type_check" CHECK("source_type" in ('usage', 'provider_statement', 'payment_settlement', 'manual')),
	CONSTRAINT "finance_cost_entry_original_amount_check" CHECK("original_amount" > 0),
	CONSTRAINT "finance_cost_entry_currency_check" CHECK((
        "original_currency" = 'MNT'
        and "fx_rate_id" is null
        and "amount_mnt_micros" > 0
      ) or (
        "original_currency" = 'USD'
        and (
          ("fx_rate_id" is null and "amount_mnt_micros" is null)
          or ("fx_rate_id" is not null and "amount_mnt_micros" > 0)
        )
      )),
	CONSTRAINT "finance_cost_entry_source_reference_check" CHECK(length(trim("source_reference")) between 1 and 255
        and length(trim("idempotency_key")) between 1 and 255),
	CONSTRAINT "finance_cost_entry_source_link_check" CHECK(("source_type" = 'usage' and "usage_id" is not null and "source_reference" = "usage_id")
        or "source_type" = 'provider_statement'
        or ("source_type" = 'payment_settlement'
          and ("payment_invoice_id" is not null or "payment_event_id" is not null))
        or "source_type" = 'manual'),
	CONSTRAINT "finance_cost_entry_usage_model_check" CHECK("source_type" <> 'usage'
        or ("category" = 'model_cost' and "provider" is not null and "model" is not null)),
	CONSTRAINT "finance_cost_entry_payload_hash_check" CHECK(length("payload_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE `finance_fx_rate` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`quote_currency` text DEFAULT 'MNT' NOT NULL,
	`rate_micromnt_per_usd` integer NOT NULL,
	`source` text(64) NOT NULL,
	`source_reference` text(255) NOT NULL,
	`idempotency_key` text(255) NOT NULL,
	`payload_hash` text(64) NOT NULL,
	`time_effective` integer NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "finance_fx_rate_pair_check" CHECK("base_currency" = 'USD' and "quote_currency" = 'MNT'),
	CONSTRAINT "finance_fx_rate_value_check" CHECK("rate_micromnt_per_usd" > 0),
	CONSTRAINT "finance_fx_rate_identity_check" CHECK(length(trim("source")) between 1 and 64
        and length(trim("source_reference")) between 1 and 255
        and length(trim("idempotency_key")) between 1 and 255),
	CONSTRAINT "finance_fx_rate_payload_hash_check" CHECK(length("payload_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_cost_entry_idempotency_key` ON `finance_cost_entry` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_cost_entry_source_identity` ON `finance_cost_entry` (`source_type`,`source_reference`,`category`,`direction`,`basis`);--> statement-breakpoint
CREATE INDEX `finance_cost_entry_workspace_time_effective` ON `finance_cost_entry` (`workspace_id`,`time_effective`);--> statement-breakpoint
CREATE INDEX `finance_cost_entry_usage_id` ON `finance_cost_entry` (`usage_id`);--> statement-breakpoint
CREATE INDEX `finance_cost_entry_payment_invoice_id` ON `finance_cost_entry` (`payment_invoice_id`);--> statement-breakpoint
CREATE INDEX `finance_cost_entry_provider_time_effective` ON `finance_cost_entry` (`provider`,`time_effective`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_fx_rate_idempotency_key` ON `finance_fx_rate` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_fx_rate_source_reference` ON `finance_fx_rate` (`source`,`source_reference`);--> statement-breakpoint
CREATE INDEX `finance_fx_rate_pair_time_effective` ON `finance_fx_rate` (`base_currency`,`quote_currency`,`time_effective`);--> statement-breakpoint
CREATE TRIGGER `finance_fx_rate_no_update`
BEFORE UPDATE ON `finance_fx_rate`
BEGIN
	SELECT RAISE(ABORT, 'finance_fx_rate is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `finance_fx_rate_no_delete`
BEFORE DELETE ON `finance_fx_rate`
BEGIN
	SELECT RAISE(ABORT, 'finance_fx_rate is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `finance_cost_entry_no_update`
BEFORE UPDATE ON `finance_cost_entry`
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_entry is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `finance_cost_entry_no_delete`
BEFORE DELETE ON `finance_cost_entry`
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_entry is immutable');
END;

CREATE TABLE `finance_cost_valuation` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`cost_entry_id` text(30) NOT NULL,
	`fx_rate_id` text(30) NOT NULL,
	`method` text NOT NULL,
	`version` integer NOT NULL,
	`amount_mnt_micros` integer NOT NULL,
	`idempotency_key` text(255) NOT NULL,
	`payload_hash` text(64) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "finance_cost_valuation_method_check" CHECK("method" in ('historical_spot', 'provider_settlement', 'manual')),
	CONSTRAINT "finance_cost_valuation_version_check" CHECK("version" > 0),
	CONSTRAINT "finance_cost_valuation_amount_check" CHECK("amount_mnt_micros" > 0),
	CONSTRAINT "finance_cost_valuation_identity_check" CHECK(length(trim("idempotency_key")) between 1 and 255),
	CONSTRAINT "finance_cost_valuation_payload_hash_check" CHECK(length("payload_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_cost_valuation_idempotency_key` ON `finance_cost_valuation` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_cost_valuation_entry_version` ON `finance_cost_valuation` (`cost_entry_id`,`version`);--> statement-breakpoint
CREATE INDEX `finance_cost_valuation_entry_created` ON `finance_cost_valuation` (`cost_entry_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `finance_cost_valuation_fx_rate_id` ON `finance_cost_valuation` (`fx_rate_id`);--> statement-breakpoint
CREATE TRIGGER `finance_cost_valuation_validate_version`
BEFORE INSERT ON `finance_cost_valuation`
WHEN EXISTS (
	SELECT 1
	FROM `finance_cost_entry`
	WHERE `id` = NEW.`cost_entry_id`
	  AND `original_currency` = 'USD'
	  AND `fx_rate_id` IS NULL
	  AND `amount_mnt_micros` IS NULL
)
AND EXISTS (
	SELECT 1
	FROM `finance_fx_rate`
	WHERE `id` = NEW.`fx_rate_id`
	  AND `base_currency` = 'USD'
	  AND `quote_currency` = 'MNT'
)
AND NOT EXISTS (
	SELECT 1
	FROM `finance_cost_valuation`
	WHERE `idempotency_key` = NEW.`idempotency_key`
	   OR (`cost_entry_id` = NEW.`cost_entry_id` AND `version` = NEW.`version`)
)
AND NEW.`version` <> (
	SELECT COALESCE(MAX(`version`), 0) + 1
	FROM `finance_cost_valuation`
	WHERE `cost_entry_id` = NEW.`cost_entry_id`
)
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_valuation version must be sequential');
END;--> statement-breakpoint
CREATE TRIGGER `finance_cost_valuation_validate_fx_rate`
BEFORE INSERT ON `finance_cost_valuation`
WHEN EXISTS (
	SELECT 1
	FROM `finance_cost_entry`
	WHERE `id` = NEW.`cost_entry_id`
	  AND `original_currency` = 'USD'
	  AND `fx_rate_id` IS NULL
	  AND `amount_mnt_micros` IS NULL
)
AND NOT EXISTS (
	SELECT 1
	FROM `finance_fx_rate`
	WHERE `id` = NEW.`fx_rate_id`
	  AND `base_currency` = 'USD'
	  AND `quote_currency` = 'MNT'
)
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_valuation requires a USD/MNT FX rate');
END;--> statement-breakpoint
CREATE TRIGGER `finance_cost_valuation_validate_cost_entry`
BEFORE INSERT ON `finance_cost_valuation`
WHEN NOT EXISTS (
	SELECT 1
	FROM `finance_cost_entry`
	WHERE `id` = NEW.`cost_entry_id`
	  AND `original_currency` = 'USD'
	  AND `fx_rate_id` IS NULL
	  AND `amount_mnt_micros` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_valuation requires an unvalued USD cost entry');
END;--> statement-breakpoint
CREATE TRIGGER `finance_cost_valuation_no_update`
BEFORE UPDATE ON `finance_cost_valuation`
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_valuation is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `finance_cost_valuation_no_delete`
BEFORE DELETE ON `finance_cost_valuation`
BEGIN
	SELECT RAISE(ABORT, 'finance_cost_valuation is immutable');
END;

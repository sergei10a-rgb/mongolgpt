CREATE TABLE `finance_payment_settlement` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`workspace_id` text(30) NOT NULL,
	`payment_invoice_id` text(30) NOT NULL,
	`payment_event_id` text(30),
	`provider` text NOT NULL,
	`merchant_account_id` text(255) NOT NULL,
	`external_settlement_id` text(255) NOT NULL,
	`kind` text NOT NULL,
	`gross_amount_mnt` integer NOT NULL,
	`fee_amount_mnt` integer NOT NULL,
	`tax_amount_mnt` integer NOT NULL,
	`net_amount_mnt` integer NOT NULL,
	`currency` text DEFAULT 'MNT' NOT NULL,
	`idempotency_key` text(255) NOT NULL,
	`payload_hash` text(64) NOT NULL,
	`time_effective` integer NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "finance_payment_settlement_provider_check" CHECK("provider" in ('qpay', 'bonum')),
	CONSTRAINT "finance_payment_settlement_kind_check" CHECK("kind" in ('payment', 'refund', 'adjustment')),
	CONSTRAINT "finance_payment_settlement_gross_sign_check" CHECK(("kind" = 'payment' and "gross_amount_mnt" > 0)
        or ("kind" = 'refund' and "gross_amount_mnt" < 0)
        or ("kind" = 'adjustment' and "gross_amount_mnt" <> 0)),
	CONSTRAINT "finance_payment_settlement_balance_check" CHECK("net_amount_mnt" = "gross_amount_mnt" - "fee_amount_mnt" - "tax_amount_mnt"),
	CONSTRAINT "finance_payment_settlement_currency_check" CHECK("currency" = 'MNT'),
	CONSTRAINT "finance_payment_settlement_identity_check" CHECK(length(trim("merchant_account_id")) between 1 and 255
        and length(trim("external_settlement_id")) between 1 and 255
        and length(trim("idempotency_key")) between 1 and 255),
	CONSTRAINT "finance_payment_settlement_payload_hash_check" CHECK(length("payload_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_payment_settlement_idempotency_key` ON `finance_payment_settlement` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_payment_settlement_provider_external` ON `finance_payment_settlement` (`provider`,`merchant_account_id`,`external_settlement_id`);--> statement-breakpoint
CREATE INDEX `finance_payment_settlement_invoice_time` ON `finance_payment_settlement` (`payment_invoice_id`,`time_effective`);--> statement-breakpoint
CREATE INDEX `finance_payment_settlement_workspace_time` ON `finance_payment_settlement` (`workspace_id`,`time_effective`);--> statement-breakpoint
CREATE INDEX `finance_payment_settlement_event_id` ON `finance_payment_settlement` (`payment_event_id`);--> statement-breakpoint
CREATE TRIGGER `finance_payment_settlement_validate_insert`
BEFORE INSERT ON `finance_payment_settlement`
BEGIN
	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1
			FROM `payment_invoice`
			WHERE `id` = NEW.`payment_invoice_id`
			  AND `workspace_id` = NEW.`workspace_id`
			  AND `provider` = NEW.`provider`
			  AND `merchant_account_id` = NEW.`merchant_account_id`
			  AND `currency` = NEW.`currency`
			  AND (
				(NEW.`kind` = 'payment' AND `status` IN ('paid', 'refunded') AND NEW.`gross_amount_mnt` = `amount`)
				OR (NEW.`kind` = 'refund' AND `status` = 'refunded' AND -NEW.`gross_amount_mnt` = `amount`)
				OR (NEW.`kind` = 'adjustment' AND `status` IN ('paid', 'refunded'))
			  )
		) THEN RAISE(ABORT, 'finance_payment_settlement does not match a verified invoice')
		WHEN NEW.`payment_event_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1
			FROM `payment_event`
			WHERE `id` = NEW.`payment_event_id`
			  AND `invoice_id` = NEW.`payment_invoice_id`
			  AND `workspace_id` = NEW.`workspace_id`
			  AND `provider` = NEW.`provider`
			  AND `merchant_account_id` = NEW.`merchant_account_id`
			  AND `outcome` <> 'rejected'
			  AND (
				(NEW.`kind` = 'payment' AND `type` = 'paid')
				OR (NEW.`kind` = 'refund' AND `type` = 'refunded')
				OR (NEW.`kind` = 'adjustment' AND `type` IN ('paid', 'refunded'))
			  )
		) THEN RAISE(ABORT, 'finance_payment_settlement does not match a verified payment event')
	END;
END;--> statement-breakpoint
CREATE TRIGGER `finance_payment_settlement_no_update`
BEFORE UPDATE ON `finance_payment_settlement`
BEGIN
	SELECT RAISE(ABORT, 'finance_payment_settlement is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `finance_payment_settlement_no_delete`
BEFORE DELETE ON `finance_payment_settlement`
BEGIN
	SELECT RAISE(ABORT, 'finance_payment_settlement is immutable');
END;

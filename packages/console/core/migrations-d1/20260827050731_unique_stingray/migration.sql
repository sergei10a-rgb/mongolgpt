CREATE TABLE `support_message` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`ticket_id` text(30) NOT NULL,
	`author_type` text NOT NULL,
	`account_id` text(30),
	`admin_id` text(30),
	`body` text(5000) NOT NULL,
	`internal` integer DEFAULT false NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "support_message_id_check" CHECK(length("id") = 30 and substr("id", 1, 4) = 'spm_'),
	CONSTRAINT "support_message_body_check" CHECK(length(trim("body")) between 1 and 5000),
	CONSTRAINT "support_message_author_type_check" CHECK("author_type" in ('customer', 'admin')),
	CONSTRAINT "support_message_author_check" CHECK(("author_type" = 'customer' and "account_id" is not null and "admin_id" is null and "internal" = 0)
        or ("author_type" = 'admin' and "account_id" is null and "admin_id" is not null))
);
--> statement-breakpoint
CREATE TABLE `support_ticket` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`account_id` text(30) NOT NULL,
	`requester_email` text(254) NOT NULL,
	`workspace_id` text(30),
	`subject` text(160) NOT NULL,
	`category` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assigned_admin_id` text(30),
	`lock_version` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer NOT NULL,
	`time_resolved` integer,
	`time_closed` integer,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "support_ticket_id_check" CHECK(length("id") = 30 and substr("id", 1, 4) = 'spt_'),
	CONSTRAINT "support_ticket_requester_email_check" CHECK("requester_email" = lower(trim("requester_email")) and length("requester_email") between 3 and 254),
	CONSTRAINT "support_ticket_subject_check" CHECK(length(trim("subject")) between 1 and 160),
	CONSTRAINT "support_ticket_category_check" CHECK("category" in ('account', 'billing', 'technical', 'feedback', 'other')),
	CONSTRAINT "support_ticket_status_check" CHECK("status" in ('open', 'pending_user', 'pending_support', 'resolved', 'closed')),
	CONSTRAINT "support_ticket_priority_check" CHECK("priority" in ('normal', 'high', 'urgent')),
	CONSTRAINT "support_ticket_lock_version_check" CHECK("lock_version" >= 0),
	CONSTRAINT "support_ticket_status_time_check" CHECK(("status" in ('open', 'pending_user', 'pending_support') and "time_resolved" is null and "time_closed" is null)
        or ("status" = 'resolved' and "time_resolved" is not null and "time_closed" is null)
        or ("status" = 'closed' and "time_resolved" is not null and "time_closed" is not null and "time_closed" >= "time_resolved"))
);
--> statement-breakpoint
CREATE INDEX `support_message_ticket_time` ON `support_message` (`ticket_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `support_ticket_account_last_message` ON `support_ticket` (`account_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `support_ticket_workspace_last_message` ON `support_ticket` (`workspace_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `support_ticket_status_priority_last_message` ON `support_ticket` (`status`,`priority`,`last_message_at`);
--> statement-breakpoint
CREATE TRIGGER `support_message_no_update`
BEFORE UPDATE ON `support_message`
BEGIN
	SELECT RAISE(ABORT, 'support_message is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `support_message_no_delete`
BEFORE DELETE ON `support_message`
BEGIN
	SELECT RAISE(ABORT, 'support_message is immutable');
END;

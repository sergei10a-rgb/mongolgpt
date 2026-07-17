CREATE TABLE `newsletter_subscriber` (
	`email` text(254) PRIMARY KEY NOT NULL,
	`locale` text(16) DEFAULT 'mn' NOT NULL,
	`source` text DEFAULT 'stats' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`consent_version` text(32) NOT NULL,
	`time_consented` integer NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	`time_unsubscribed` integer,
	CONSTRAINT "newsletter_subscriber_source_check" CHECK("source" in ('stats')),
	CONSTRAINT "newsletter_subscriber_status_check" CHECK("status" in ('active', 'unsubscribed'))
);
--> statement-breakpoint
CREATE INDEX `newsletter_subscriber_status_time_created` ON `newsletter_subscriber` (`status`,`time_created`);
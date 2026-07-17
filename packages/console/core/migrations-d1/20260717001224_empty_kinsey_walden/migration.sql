PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_newsletter_subscriber` (
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
	CONSTRAINT "newsletter_subscriber_source_check" CHECK("source" in ('console', 'stats')),
	CONSTRAINT "newsletter_subscriber_status_check" CHECK("status" in ('active', 'unsubscribed'))
);
--> statement-breakpoint
INSERT INTO `__new_newsletter_subscriber`(`email`, `locale`, `source`, `status`, `consent_version`, `time_consented`, `time_created`, `time_updated`, `time_deleted`, `time_unsubscribed`) SELECT `email`, `locale`, `source`, `status`, `consent_version`, `time_consented`, `time_created`, `time_updated`, `time_deleted`, `time_unsubscribed` FROM `newsletter_subscriber`;--> statement-breakpoint
DROP TABLE `newsletter_subscriber`;--> statement-breakpoint
ALTER TABLE `__new_newsletter_subscriber` RENAME TO `newsletter_subscriber`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `newsletter_subscriber_status_time_created` ON `newsletter_subscriber` (`status`,`time_created`);
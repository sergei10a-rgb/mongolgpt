CREATE TABLE `enterprise_inquiry` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`name` text(120) NOT NULL,
	`role` text(120) NOT NULL,
	`company` text(200),
	`email` text(254) NOT NULL,
	`phone` text(64),
	`message` text(5000) NOT NULL,
	`locale` text(16) DEFAULT 'mn' NOT NULL,
	`source` text DEFAULT 'enterprise' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`form_version` text(32) NOT NULL,
	`time_created` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_updated` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`time_deleted` integer,
	CONSTRAINT "enterprise_inquiry_source_check" CHECK("source" in ('enterprise')),
	CONSTRAINT "enterprise_inquiry_status_check" CHECK("status" in ('new', 'reviewing', 'resolved', 'spam'))
);
--> statement-breakpoint
CREATE INDEX `enterprise_inquiry_status_time_created` ON `enterprise_inquiry` (`status`,`time_created`);--> statement-breakpoint
CREATE INDEX `enterprise_inquiry_email` ON `enterprise_inquiry` (`email`);
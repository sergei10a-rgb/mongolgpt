ALTER TABLE `usage` ADD `input_cost` integer;--> statement-breakpoint
ALTER TABLE `usage` ADD `output_cost` integer;--> statement-breakpoint
ALTER TABLE `usage` ADD `cache_read_cost` integer;--> statement-breakpoint
ALTER TABLE `usage` ADD `cache_write_cost` integer;--> statement-breakpoint
ALTER TABLE `usage` ADD `country` text(2);--> statement-breakpoint
ALTER TABLE `usage` ADD `continent` text(2);--> statement-breakpoint
CREATE INDEX `usage_time_model_provider` ON `usage` (`time_created`,`model`,`provider`);
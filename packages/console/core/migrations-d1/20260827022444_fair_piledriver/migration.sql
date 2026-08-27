ALTER TABLE `subscription` ADD `weekly_requests` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `monthly_cost` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `monthly_tokens` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `monthly_requests` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `time_weekly_requests_updated` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `time_monthly_cost_updated` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `time_monthly_tokens_updated` integer;--> statement-breakpoint
ALTER TABLE `subscription` ADD `time_monthly_requests_updated` integer;
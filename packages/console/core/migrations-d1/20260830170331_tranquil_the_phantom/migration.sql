CREATE TABLE `provider_attempt` (
	`id` text(30) PRIMARY KEY NOT NULL,
	`provider` text(255) NOT NULL,
	`provider_kind` text(64),
	`usage_mode` text NOT NULL,
	`model` text(255) NOT NULL,
	`outcome` text NOT NULL,
	`response_status` integer,
	`latency_ms` integer NOT NULL,
	`retry_count` integer NOT NULL,
	`fallback` integer NOT NULL,
	`time_created` integer NOT NULL,
	CONSTRAINT "provider_attempt_id_check" CHECK(length("id") = 30 and substr("id", 1, 4) = 'pat_'),
	CONSTRAINT "provider_attempt_identity_check" CHECK(length(trim("provider")) between 1 and 255 and length(trim("model")) between 1 and 255),
	CONSTRAINT "provider_attempt_provider_kind_check" CHECK("provider_kind" is null or length(trim("provider_kind")) between 1 and 64),
	CONSTRAINT "provider_attempt_usage_mode_check" CHECK("usage_mode" in ('managed', 'trial')),
	CONSTRAINT "provider_attempt_outcome_check" CHECK("outcome" in ('success', 'transient-error', 'permanent-error')),
	CONSTRAINT "provider_attempt_response_status_check" CHECK("response_status" is null or "response_status" between 100 and 599),
	CONSTRAINT "provider_attempt_latency_check" CHECK("latency_ms" between 0 and 600000),
	CONSTRAINT "provider_attempt_retry_check" CHECK("retry_count" between 0 and 10)
);
--> statement-breakpoint
CREATE INDEX `provider_attempt_provider_time` ON `provider_attempt` (`provider`,`time_created`);--> statement-breakpoint
CREATE INDEX `provider_attempt_time_outcome` ON `provider_attempt` (`time_created`,`outcome`);
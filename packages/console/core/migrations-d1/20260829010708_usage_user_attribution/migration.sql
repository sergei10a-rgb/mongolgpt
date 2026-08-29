ALTER TABLE `usage` ADD `user_id` text(30);--> statement-breakpoint
UPDATE `usage`
SET `user_id` = (
  SELECT `key`.`user_id`
  FROM `key`
  WHERE `key`.`id` = `usage`.`key_id`
    AND `key`.`workspace_id` = `usage`.`workspace_id`
  LIMIT 1
)
WHERE `usage`.`user_id` IS NULL
  AND `usage`.`key_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_workspace_user_time_created` ON `usage` (`workspace_id`,`user_id`,`time_created`);

CREATE TABLE `auto_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`details` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auto_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`bar_time` text NOT NULL,
	`signal` integer NOT NULL,
	`payload` text NOT NULL,
	`client_key` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auto_decisions_run` ON `auto_decisions` (`run_id`);--> statement-breakpoint
CREATE TABLE `auto_strategy` (
	`id` integer PRIMARY KEY NOT NULL,
	`run_id` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`config` text,
	`backtest_id` text,
	`budget` real DEFAULT 1000 NOT NULL,
	`actor` text,
	`reason` text DEFAULT '尚未启动' NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`heartbeat_at` text,
	`heartbeat_source` text,
	`last_check_at` text,
	`last_outcome` text
);

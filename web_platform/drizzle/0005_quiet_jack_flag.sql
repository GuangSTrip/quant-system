CREATE TABLE `portfolio_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`signal_id` text NOT NULL,
	`phase` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_quotes` (
	`market` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_runs` (
	`exit_requested` integer DEFAULT 0 NOT NULL,
	`market` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`version` text NOT NULL,
	`connection_tag` text NOT NULL,
	`budget` real NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`last_decision` text,
	`reason` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`signal_date` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portfolio_signal` ON `portfolio_signals` (`strategy_id`,`signal_date`);
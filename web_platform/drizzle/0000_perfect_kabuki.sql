CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_kind_created` ON `artifacts` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `control` (
	`id` integer PRIMARY KEY NOT NULL,
	`halted` integer DEFAULT 1 NOT NULL,
	`reason` text DEFAULT '初次启用前请完成对账并恢复' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`owner_id` text,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`max_order` real DEFAULT 2500 NOT NULL,
	`max_daily` real DEFAULT 10000 NOT NULL,
	`max_position` real DEFAULT 0.25 NOT NULL,
	`max_loss` real DEFAULT 0.05 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text,
	`details` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`client_id` text PRIMARY KEY NOT NULL,
	`broker_id` text,
	`request_hash` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`estimated_notional` real NOT NULL,
	`broker_data` text,
	`error` text,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_orders_created` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`);
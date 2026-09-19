CREATE TABLE `lb_auto` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`run_id` text,
	`config` text,
	`next_at` integer DEFAULT 0 NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`heartbeat_at` text,
	`last_at` text,
	`outcome` text,
	`reason` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lb_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`connection_tag` text,
	`max_order` real DEFAULT 2000 NOT NULL,
	`max_daily` real DEFAULT 5000 NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lb_orders` (
	`client_id` text PRIMARY KEY NOT NULL,
	`connection_tag` text NOT NULL,
	`broker_id` text,
	`payload` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`notional` real NOT NULL,
	`initial_qty` real NOT NULL,
	`broker_data` text,
	`error` text,
	`actor` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

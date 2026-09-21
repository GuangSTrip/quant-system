CREATE TABLE `broker_locks` (
	`market` text PRIMARY KEY NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);

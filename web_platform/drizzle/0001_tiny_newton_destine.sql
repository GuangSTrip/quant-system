CREATE TABLE `auth_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`credential_tag` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expiry` ON `auth_sessions` (`expires_at`);
ALTER TABLE `emails` ADD `thread_key` text;--> statement-breakpoint
CREATE INDEX `emails_recipient_thread_idx` ON `emails` (`recipient`,`thread_key`);--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `thread_key` text;--> statement-breakpoint
CREATE INDEX `sent_emails_from_thread_idx` ON `sent_emails` (`from_address`,`thread_key`);--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `threading_mode` text DEFAULT 'relationship' NOT NULL;
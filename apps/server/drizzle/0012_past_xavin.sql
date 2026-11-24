ALTER TABLE "assets" ADD COLUMN "name" varchar(120) DEFAULT 'Untitled image' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "category" varchar(16) DEFAULT 'OTHER' NOT NULL;
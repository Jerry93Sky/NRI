ALTER TABLE "tokens" ADD COLUMN "width" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "height" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "rotation" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "opacity" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "border_color" varchar(7) DEFAULT '#e8d7c3' NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "z_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "show_name" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_dimensions_check" CHECK ("tokens"."width" BETWEEN 0.25 AND 100 AND "tokens"."height" BETWEEN 0.25 AND 100 AND "tokens"."opacity" BETWEEN 0 AND 1 AND "tokens"."rotation" BETWEEN -360000 AND 360000);
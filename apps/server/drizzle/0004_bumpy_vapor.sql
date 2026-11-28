ALTER TABLE "scenes" ADD COLUMN "grid_color" varchar(7) DEFAULT '#44453e' NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "grid_opacity" double precision DEFAULT 0.38 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "grid_offset_x" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "grid_offset_y" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "grid_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "snap_to_grid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "units_per_cell" double precision DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "unit_label" varchar(24) DEFAULT 'ft' NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "camera_x" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "camera_y" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "camera_zoom" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
WITH ranked AS (SELECT "id", row_number() OVER (PARTITION BY "campaign_id" ORDER BY "id") - 1 AS ordinal, row_number() OVER (PARTITION BY "campaign_id" ORDER BY "id") = 1 AS first_scene FROM "scenes" WHERE "archived_at" IS NULL) UPDATE "scenes" AS s SET "sort_order" = ranked.ordinal::integer, "is_active" = ranked.first_scene, "published" = ranked.first_scene FROM ranked WHERE s."id" = ranked."id";--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_one_active_per_campaign_idx" ON "scenes" USING btree ("campaign_id") WHERE "scenes"."is_active" = true;

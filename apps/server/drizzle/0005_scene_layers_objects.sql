CREATE TABLE "scene_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"name" varchar(48) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"visible_to_players" boolean DEFAULT true NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"layer_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision DEFAULT 64 NOT NULL,
	"height" double precision DEFAULT 64 NOT NULL,
	"rotation" double precision DEFAULT 0 NOT NULL,
	"opacity" double precision DEFAULT 1 NOT NULL,
	"z_index" integer DEFAULT 0 NOT NULL,
	"asset_id" uuid,
	"color" varchar(7),
	"stroke_width" double precision,
	"points" jsonb,
	"text" varchar(500),
	"visible" boolean DEFAULT true NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scene_layers" ADD CONSTRAINT "scene_layers_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_layer_id_scene_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."scene_layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scene_layers_scene_idx" ON "scene_layers" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "scene_layers_scene_kind_idx" ON "scene_layers" USING btree ("scene_id","kind");--> statement-breakpoint
CREATE INDEX "scene_objects_scene_layer_z_idx" ON "scene_objects" USING btree ("scene_id","layer_id","z_index");
--> statement-breakpoint
INSERT INTO "scene_layers" ("scene_id", "name", "kind", "sort_order", "visible_to_players", "locked")
SELECT "id", 'Background', 'BACKGROUND', 0, true, true FROM "scenes";
--> statement-breakpoint
INSERT INTO "scene_layers" ("scene_id", "name", "kind", "sort_order", "visible_to_players", "locked")
SELECT "id", 'Objects', 'OBJECTS', 1, true, false FROM "scenes";
--> statement-breakpoint
INSERT INTO "scene_layers" ("scene_id", "name", "kind", "sort_order", "visible_to_players", "locked")
SELECT "id", 'Tokens', 'TOKENS', 2, true, false FROM "scenes";
--> statement-breakpoint
INSERT INTO "scene_layers" ("scene_id", "name", "kind", "sort_order", "visible_to_players", "locked")
SELECT "id", 'GM', 'GM', 3, false, false FROM "scenes";

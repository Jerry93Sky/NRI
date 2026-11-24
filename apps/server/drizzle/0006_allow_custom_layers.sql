ALTER TABLE "scene_layers" DROP CONSTRAINT IF EXISTS "scene_layers_kind_check";--> statement-breakpoint
ALTER TABLE "scene_objects" DROP CONSTRAINT IF EXISTS "scene_objects_kind_check";--> statement-breakpoint
ALTER TABLE "scene_objects" DROP CONSTRAINT IF EXISTS "scene_objects_dimensions_check";--> statement-breakpoint
DROP INDEX "scene_layers_scene_kind_idx";--> statement-breakpoint
CREATE INDEX "scene_layers_scene_kind_idx" ON "scene_layers" USING btree ("scene_id","kind");

ALTER TABLE "scene_layers" DROP CONSTRAINT IF EXISTS "scene_layers_kind_check";--> statement-breakpoint
ALTER TABLE "scene_objects" DROP CONSTRAINT IF EXISTS "scene_objects_kind_check";--> statement-breakpoint
ALTER TABLE "scene_objects" DROP CONSTRAINT IF EXISTS "scene_objects_dimensions_check";--> statement-breakpoint
ALTER TABLE "scene_layers" ADD CONSTRAINT "scene_layers_kind_check" CHECK ("scene_layers"."kind" IN ('BACKGROUND', 'OBJECTS', 'TOKENS', 'GM', 'CUSTOM'));--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_kind_check" CHECK ("scene_objects"."kind" IN ('IMAGE', 'LINE', 'FREEHAND', 'RECTANGLE', 'ELLIPSE', 'TEXT'));--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_dimensions_check" CHECK ("scene_objects"."width" > 0 AND "scene_objects"."height" > 0 AND "scene_objects"."opacity" BETWEEN 0 AND 1 AND "scene_objects"."rotation" BETWEEN -360000 AND 360000);

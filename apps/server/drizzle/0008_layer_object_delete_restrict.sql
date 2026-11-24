ALTER TABLE "scene_objects" DROP CONSTRAINT "scene_objects_layer_id_scene_layers_id_fk";
--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_layer_id_scene_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."scene_layers"("id") ON DELETE restrict ON UPDATE no action;
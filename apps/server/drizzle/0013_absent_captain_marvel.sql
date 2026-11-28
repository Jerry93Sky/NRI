ALTER TABLE "scene_objects" DROP CONSTRAINT "scene_objects_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "scenes" DROP CONSTRAINT "scenes_background_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "image_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_background_asset_id_assets_id_fk" FOREIGN KEY ("background_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_image_asset_id_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "campaigns" ADD COLUMN "players_can_draw" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scene_objects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scene_objects_creator_idx" ON "scene_objects" USING btree ("created_by");
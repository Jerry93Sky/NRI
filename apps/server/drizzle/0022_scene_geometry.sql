CREATE TABLE "scene_geometry" (
  "scene_id" uuid PRIMARY KEY REFERENCES "scenes"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL DEFAULT 0,
  "tactical_visibility_enabled" boolean NOT NULL DEFAULT false,
  "obstacle_movement_enabled" boolean NOT NULL DEFAULT false,
  CONSTRAINT "scene_geometry_revision_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "scene_obstacles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scene_id" uuid NOT NULL REFERENCES "scenes"("id") ON DELETE CASCADE,
  "start_x" integer NOT NULL,
  "start_y" integer NOT NULL,
  "end_x" integer NOT NULL,
  "end_y" integer NOT NULL,
  "kind" varchar(16) NOT NULL,
  "door_state" varchar(16),
  "visibility" varchar(16) NOT NULL,
  "blocks_movement" boolean NOT NULL,
  "blocks_vision" boolean NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  CONSTRAINT "scene_obstacles_position_check" CHECK (
    "start_x" BETWEEN 0 AND 16384000 AND "start_y" BETWEEN 0 AND 16384000 AND
    "end_x" BETWEEN 0 AND 16384000 AND "end_y" BETWEEN 0 AND 16384000 AND
    ("start_x" <> "end_x" OR "start_y" <> "end_y")
  ),
  CONSTRAINT "scene_obstacles_kind_check" CHECK (
    ("kind" = 'DOOR' AND "door_state" IS NOT NULL AND "door_state" IN ('OPEN', 'CLOSED', 'LOCKED')) OR
    ("kind" IN ('WALL', 'WINDOW') AND "door_state" IS NULL)
  ),
  CONSTRAINT "scene_obstacles_visibility_check" CHECK ("visibility" IN ('STANDARD', 'SECRET')),
  CONSTRAINT "scene_obstacles_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE INDEX "scene_obstacles_scene_idx" ON "scene_obstacles" ("scene_id", "id");

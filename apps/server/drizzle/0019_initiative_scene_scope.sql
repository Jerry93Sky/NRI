ALTER TABLE "initiative_trackers" ADD COLUMN "scene_id" uuid;--> statement-breakpoint
ALTER TABLE "initiative_trackers" ADD CONSTRAINT "initiative_trackers_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Token-linked entries created through the old API identify their originating scene.
WITH "known_scene" AS (
  SELECT entry."tracker_id", min(token."scene_id"::text)::uuid AS "scene_id"
  FROM "initiative_entries" entry
  JOIN "initiative_trackers" tracker ON tracker."id" = entry."tracker_id"
  JOIN "tokens" token ON token."id" = entry."token_id"
  JOIN "scenes" scene ON scene."id" = token."scene_id" AND scene."campaign_id" = tracker."campaign_id"
  GROUP BY entry."tracker_id"
  HAVING count(DISTINCT token."scene_id") = 1
)
UPDATE "initiative_trackers" tracker SET "scene_id" = known."scene_id"
FROM "known_scene" known WHERE tracker."id" = known."tracker_id";--> statement-breakpoint
-- Retain old entries but make trackers without a current scene unavailable until the next start.
UPDATE "initiative_trackers" tracker SET "scene_id" = NULL, "active" = false, "version" = tracker."version" + 1
WHERE (tracker."active" OR tracker."scene_id" IS NOT NULL) AND NOT EXISTS (
  SELECT 1 FROM "scenes" scene
  WHERE scene."id" = tracker."scene_id" AND scene."campaign_id" = tracker."campaign_id"
    AND scene."is_active" AND scene."archived_at" IS NULL
);

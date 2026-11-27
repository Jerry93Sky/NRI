CREATE TABLE "rest_operation_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "campaign_id" uuid REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "operation_type" varchar(48) NOT NULL,
  "request_id" uuid NOT NULL,
  "payload_digest" varchar(64) NOT NULL,
  "result_ids" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  CONSTRAINT "rest_operation_receipts_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "rest_operation_receipts_ids_check" CHECK (jsonb_typeof("result_ids") = 'array' AND jsonb_array_length("result_ids") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rest_operation_receipts_scope_idx"
  ON "rest_operation_receipts" ("actor_id", "campaign_id", "operation_type", "request_id") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "rest_operation_receipts_expiry_idx" ON "rest_operation_receipts" ("expires_at");

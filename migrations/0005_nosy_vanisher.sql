CREATE TABLE IF NOT EXISTS "validation_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"valid" boolean NOT NULL,
	"error_code" text,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_audit_tenant_created_idx" ON "validation_audit" USING btree ("tenant_id","created_at");
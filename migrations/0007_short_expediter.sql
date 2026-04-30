CREATE TABLE IF NOT EXISTS "google_purchase_chains" (
	"tenant_id" text NOT NULL,
	"current_token" text NOT NULL,
	"previous_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_purchase_chains_tenant_id_current_token_pk" PRIMARY KEY("tenant_id","current_token")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "subject_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_purchase_chains" ADD CONSTRAINT "google_purchase_chains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_purchase_chains_previous_idx" ON "google_purchase_chains" USING btree ("tenant_id","previous_token");
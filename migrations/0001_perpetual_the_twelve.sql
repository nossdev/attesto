CREATE TABLE IF NOT EXISTS "apple_credentials" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"key_id" text NOT NULL,
	"issuer_id" text NOT NULL,
	"private_key_enc" "bytea" NOT NULL,
	"environment" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "apple_credentials" ADD CONSTRAINT "apple_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

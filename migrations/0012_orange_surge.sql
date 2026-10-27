CREATE INDEX IF NOT EXISTS "google_purchase_chains_created_at_idx" ON "google_purchase_chains" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_audit_created_at_idx" ON "validation_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");
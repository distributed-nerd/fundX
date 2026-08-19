CREATE TABLE "address_pool" (
	"derivation_index" integer PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "address_pool_address_key" ON "address_pool" USING btree ("address");--> statement-breakpoint
CREATE INDEX "address_pool_unclaimed_idx" ON "address_pool" USING btree ("claimed_at");
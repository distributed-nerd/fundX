CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_usd" bigint NOT NULL,
	"amount_ngn" bigint NOT NULL,
	"rate" integer NOT NULL,
	"bank_account_number" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reference" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_idempotency_key" ON "payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payouts_user_idx" ON "payouts" USING btree ("user_id","created_at");
CREATE TABLE "indexer_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_block" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"from_user_id" text,
	"to_user_id" text,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" bigint NOT NULL,
	"memo" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"address" text NOT NULL,
	"pin_hash" text NOT NULL,
	"pin_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ussd_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"flow" text NOT NULL,
	"step" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_text" text,
	"last_response" text,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_phone_idx" ON "otp_codes" USING btree ("phone","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_idempotency_key" ON "transfers" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "transfers_from_user_idx" ON "transfers" USING btree ("from_user_id","created_at");--> statement-breakpoint
CREATE INDEX "transfers_to_user_idx" ON "transfers" USING btree ("to_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_tx_hash_key" ON "transfers" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_key" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_derivation_index_key" ON "users" USING btree ("derivation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "users_address_key" ON "users" USING btree ("address");--> statement-breakpoint
CREATE INDEX "web_sessions_user_idx" ON "web_sessions" USING btree ("user_id");
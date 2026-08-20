CREATE TABLE "fx_rates" (
	"pair" text PRIMARY KEY NOT NULL,
	"rate_hundredths" integer NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

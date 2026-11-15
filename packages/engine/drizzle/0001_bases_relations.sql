CREATE TABLE "db_calc_dirty" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"table_id" text NOT NULL,
	"row_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_cell_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"table_id" text NOT NULL,
	"row_id" text NOT NULL,
	"prop_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requester" jsonb NOT NULL,
	"row_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "db_calc_dirty" ADD CONSTRAINT "db_calc_dirty_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_cell_jobs" ADD CONSTRAINT "db_cell_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_cell_jobs" ADD CONSTRAINT "db_cell_jobs_table_id_db_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."db_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_cell_jobs" ADD CONSTRAINT "db_cell_jobs_row_id_db_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."db_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "db_calc_dirty_table_idx" ON "db_calc_dirty" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "db_cell_jobs_live_uq" ON "db_cell_jobs" USING btree ("row_id","prop_id") WHERE status in ('queued', 'running', 'review');--> statement-breakpoint
CREATE INDEX "db_cell_jobs_queue_idx" ON "db_cell_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "db_cell_jobs_table_idx" ON "db_cell_jobs" USING btree ("table_id","prop_id","created_at");
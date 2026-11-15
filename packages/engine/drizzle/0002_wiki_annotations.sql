CREATE TABLE "page_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" text,
	"author" jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"anchor" jsonb,
	"hunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parent_version" integer,
	"status" text NOT NULL,
	"agent_id" text,
	"message_id" text,
	"handled_by" jsonb,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_change_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text,
	"action" text NOT NULL,
	"title" text NOT NULL,
	"author" jsonb NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_checks" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test_model" boolean DEFAULT false NOT NULL,
	"ran_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_pages" ADD COLUMN "access" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_pages" ADD COLUMN "agent_edits" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "page_annotations" ADD CONSTRAINT "page_annotations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_annotations" ADD CONSTRAINT "page_annotations_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_change_log" ADD CONSTRAINT "wiki_change_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_change_log" ADD CONSTRAINT "wiki_change_log_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_checks" ADD CONSTRAINT "wiki_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_annotations_page_idx" ON "page_annotations" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "wiki_change_log_workspace_at_idx" ON "wiki_change_log" USING btree ("workspace_id","at");
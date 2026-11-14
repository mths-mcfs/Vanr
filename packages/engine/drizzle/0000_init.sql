-- Trigram search (gin_trgm_ops below) needs pg_trgm; it ships in the contrib of every Postgres.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"role" text DEFAULT 'custom' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility_mode" text DEFAULT 'everyone' NOT NULL,
	"audience_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"appearance" jsonb NOT NULL,
	"harness_kind" text DEFAULT 'model' NOT NULL,
	"harness_model" text,
	"harness_fallback" boolean DEFAULT true NOT NULL,
	"advisor_model" text,
	"advisor_max_uses" integer DEFAULT 2 NOT NULL,
	"environment_id" text,
	"assignment_command_policy" text DEFAULT 'when_safe' NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_id" text,
	"budget_per_month_usd" double precision,
	"budget_notice" text,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"secret" text NOT NULL,
	"key_preview" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"requester_agent_id" text NOT NULL,
	"delegate_agent_id" text NOT NULL,
	"run_id" text,
	"channel_id" text,
	"question" text NOT NULL,
	"answer" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text,
	"scope" text DEFAULT 'agent' NOT NULL,
	"owner_user_id" text,
	"path" text,
	"text" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"about" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"untrusted_source" boolean DEFAULT false NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"vetted_at" timestamp with time zone,
	"source" text,
	"origin" jsonb,
	"origin_message_id" text,
	"replaces" text,
	"text_before" text,
	"editor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_dispatches" (
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"state" text NOT NULL,
	"run_id" text,
	"status" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_dispatches_message_id_agent_id_pk" PRIMARY KEY("message_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"text" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text,
	"source_channel_id" text,
	"debate_id" text,
	"thread_id" text,
	"source_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"what" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"error" text,
	"error_code" text,
	"error_vars" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"last_ping_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_grants" (
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "skill_grants_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"source_url" text,
	"source_run_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"auto_grant_new_agents" boolean DEFAULT false NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_command_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"rule" text NOT NULL,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_command_stats" (
	"assignment_id" text PRIMARY KEY NOT NULL,
	"auto" integer DEFAULT 0 NOT NULL,
	"asked" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"job_id" text,
	"run_id" text,
	"command" text NOT NULL,
	"tool" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"always" boolean DEFAULT false NOT NULL,
	"decided_by" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assignment_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"status" text NOT NULL,
	"chosen" text,
	"selected_by" text,
	"selected_at" timestamp with time zone,
	"blocking" boolean DEFAULT true NOT NULL,
	"recommendation" text,
	"why" text,
	"impact" text,
	"opinions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_id" text,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"key" text,
	"kind" text NOT NULL,
	"actor" jsonb NOT NULL,
	"item_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_join_requests" (
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "assignment_join_requests_assignment_id_user_id_pk" PRIMARY KEY("assignment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "assignment_participants" (
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_participants_assignment_id_user_id_pk" PRIMARY KEY("assignment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "assignment_plan_items" (
	"assignment_id" text NOT NULL,
	"id" text NOT NULL,
	"ord" integer NOT NULL,
	"title" text NOT NULL,
	"criteria" text DEFAULT '' NOT NULL,
	"milestone" text,
	"kind" text DEFAULT 'work' NOT NULL,
	"fixes" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"passes" boolean,
	"verdict" text,
	"verified_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"turns" integer DEFAULT 0 NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "assignment_plan_items_assignment_id_id_pk" PRIMARY KEY("assignment_id","id")
);
--> statement-breakpoint
CREATE TABLE "assignment_plan_versions" (
	"assignment_id" text NOT NULL,
	"version" integer NOT NULL,
	"author" jsonb NOT NULL,
	"note" text,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_plan_versions_assignment_id_version_pk" PRIMARY KEY("assignment_id","version")
);
--> statement-breakpoint
CREATE TABLE "assignment_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"item_id" text,
	"job_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"file_id" text,
	"url" text,
	"by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pr_url" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_seen" (
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_seen_assignment_id_user_id_pk" PRIMARY KEY("assignment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "assignment_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"note" text NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"changes_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_work" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"item_id" text NOT NULL,
	"n" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"executor" text DEFAULT 'agent' NOT NULL,
	"runner_id" text,
	"checkout_path" text,
	"owner_id" text NOT NULL,
	"command_policy" text DEFAULT 'when_safe' NOT NULL,
	"resume_jobs" boolean DEFAULT true NOT NULL,
	"model" text,
	"plan" jsonb DEFAULT '{"version":0,"items":[]}'::jsonb NOT NULL,
	"plan_version" integer DEFAULT 0 NOT NULL,
	"workflow_id" text,
	"limits" jsonb DEFAULT '{"dollars":5,"minutes":480,"steps":30}'::jsonb NOT NULL,
	"ceiling" text,
	"due_at" timestamp with time zone,
	"wake_at" timestamp with time zone,
	"wait_reason" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"wiki_page_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"email" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"locale" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "db_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"icon" text,
	"kind" text DEFAULT 'database' NOT NULL,
	"page_id" text,
	"source_file_id" text,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"table_id" text NOT NULL,
	"position" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"version" integer DEFAULT 1 NOT NULL,
	"calc_version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"edited_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"database_id" text NOT NULL,
	"name" text NOT NULL,
	"defs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title_prop_id" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"calc_version" integer DEFAULT 1 NOT NULL,
	"calc_done_version" integer DEFAULT 1 NOT NULL,
	"calc_day" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_views" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"database_id" text NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"position" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_memberships" (
	"channel_id" text NOT NULL,
	"member_type" text NOT NULL,
	"member_id" text NOT NULL,
	"auto_answer" boolean DEFAULT false NOT NULL,
	"last_read_at" timestamp with time zone,
	"last_read_message_id" text,
	"member_since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_memberships_channel_id_member_type_member_id_pk" PRIMARY KEY("channel_id","member_type","member_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"kind" text DEFAULT 'channel' NOT NULL,
	"dm_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"budget_per_month_usd" double precision,
	"budget_notice" text
);
--> statement-breakpoint
CREATE TABLE "emoji_reactions" (
	"message_id" text NOT NULL,
	"reaction" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emoji_reactions_message_id_reaction_actor_type_actor_id_pk" PRIMARY KEY("message_id","reaction","actor_type","actor_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_id" text,
	"run_id" text,
	"agent_mention_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mentioned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pins" (
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"pinned_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pins_channel_id_message_id_pk" PRIMARY KEY("channel_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "thread_subscriptions" (
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"following" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_subscriptions_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"source_channel_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"root_message_id" text,
	"last_message_id" text,
	"omitted_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"resolved_suggestion" boolean DEFAULT false NOT NULL,
	"first_reply_at" timestamp with time zone,
	"last_touched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"debate_id" text NOT NULL,
	"author" jsonb NOT NULL,
	"kind" text NOT NULL,
	"round" integer NOT NULL,
	"body" text NOT NULL,
	"claim_data" jsonb,
	"hidden_until_round_end" boolean DEFAULT false NOT NULL,
	"reply_to" text,
	"wants_extra_round" boolean DEFAULT false NOT NULL,
	"run_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"phase" text,
	"round" integer DEFAULT 1 NOT NULL,
	"round_limit" integer DEFAULT 3 NOT NULL,
	"format" text DEFAULT 'decision' NOT NULL,
	"deadline" timestamp with time zone,
	"created_by" jsonb NOT NULL,
	"requester_user_id" text,
	"lead_user_id" text,
	"agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lead_agent_id" text,
	"pending_speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stall_info" jsonb,
	"channel_id" text,
	"origin" jsonb,
	"synthesis" jsonb,
	"issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pseudonyms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spend_cap_percent" double precision,
	"spend_cap_usd" double precision,
	"end_reason" text,
	"verdict_state" jsonb,
	"blind_reviews" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_versions" (
	"file_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb,
	"blob_key" text,
	"file_name" text,
	"content_type" text,
	"size" integer,
	"text" text,
	"pages" jsonb,
	"extract_status" text DEFAULT 'none' NOT NULL,
	"extract_claimed_at" timestamp with time zone,
	"extract_attempts" integer DEFAULT 0 NOT NULL,
	"extract_error" text,
	"detected_type" text,
	"sha256" text,
	"thumb_key" text,
	"preview_key" text,
	"note" text,
	"author" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_versions_file_id_version_pk" PRIMARY KEY("file_id","version")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"channel_id" text,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" jsonb,
	"expunge_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"source_type" text,
	"updated_by" jsonb NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" jsonb,
	"expunge_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_links" (
	"source_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"workspace_id" text NOT NULL,
	"target_id" text,
	"target_text" text NOT NULL,
	"target_slug" text DEFAULT '' NOT NULL,
	"anchor" text,
	"link_text" text,
	"embed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "page_links_source_id_ordinal_pk" PRIMARY KEY("source_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "page_revisions" (
	"page_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"props" jsonb,
	"author" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_revisions_page_id_version_pk" PRIMARY KEY("page_id","version")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"file_id" text,
	"parent_version" integer,
	"channel_id" text,
	"thread_id" text,
	"title" text,
	"note" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'open' NOT NULL,
	"result_file_id" text,
	"result_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_attachments" (
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"path_key" text NOT NULL,
	"file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_attachments_workspace_id_path_key_pk" PRIMARY KEY("workspace_id","path_key")
);
--> statement-breakpoint
CREATE TABLE "wiki_page_docs" (
	"page_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"parent_version" integer NOT NULL,
	"dirty" boolean DEFAULT false NOT NULL,
	"editors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edited_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page_views" (
	"page_id" text NOT NULL,
	"reader_type" text NOT NULL,
	"reader_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_page_views_page_id_reader_type_reader_id_pk" PRIMARY KEY("page_id","reader_type","reader_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_prop_schemas" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"defs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool" text NOT NULL,
	"rule_key" text NOT NULL,
	"label" text NOT NULL,
	"approval_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text,
	"thread_id" text,
	"message_id" text,
	"run_id" text,
	"tool" text NOT NULL,
	"scope" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"issue" jsonb,
	"connector" text,
	"linked_account" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"effect" text,
	"gate_reason" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview" jsonb,
	"input" jsonb,
	"original_input" jsonb,
	"payload_hash" text,
	"editable" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"rule_key" text,
	"rule_label" text,
	"requester_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decider_user_id" text,
	"reason" text,
	"applied_at" timestamp with time zone,
	"result" jsonb,
	"trail" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"canceled_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"recipient_agent_id" text,
	"target_path" text,
	"title" text NOT NULL,
	"before" text NOT NULL,
	"after" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"channel_id" text,
	"message_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"trail" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"message_id" text,
	"asked_user_id" text,
	"text" text NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"responder_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reversible_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text,
	"message_id" text,
	"requester_user_id" text,
	"kind" text NOT NULL,
	"target" jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revertible_until" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"reverter_user_id" text
);
--> statement-breakpoint
CREATE TABLE "agent_channel_access" (
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "agent_channel_access_agent_id_channel_id_connection_id_pk" PRIMARY KEY("agent_id","channel_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "agent_databases" (
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"level" text NOT NULL,
	"policy" jsonb NOT NULL,
	CONSTRAINT "agent_databases_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "agent_grants" (
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text DEFAULT '' NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "agent_grants_agent_id_connection_id_scope_pk" PRIMARY KEY("agent_id","connection_id","scope")
);
--> statement-breakpoint
CREATE TABLE "agent_mailboxes" (
	"agent_id" text NOT NULL,
	"account_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"level" text NOT NULL,
	"deletable" boolean DEFAULT false NOT NULL,
	"policy" jsonb NOT NULL,
	CONSTRAINT "agent_mailboxes_agent_id_account_id_pk" PRIMARY KEY("agent_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connector" text NOT NULL,
	"custom" boolean DEFAULT false NOT NULL,
	"label" text NOT NULL,
	"account_display_name" text,
	"server_url" text,
	"auth_kind" text NOT NULL,
	"secret" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vetted_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"agent_id" text,
	"scope_request" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"database" text NOT NULL,
	"username" text NOT NULL,
	"sslmode" text DEFAULT 'require' NOT NULL,
	"secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"disabled_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden_suggestion" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_username" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"repo_scope" text DEFAULT 'selected' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"preset" text,
	"via" text NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"secret" text,
	"disabled_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirm_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text,
	"secret" text,
	"next_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_storage" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"s3" jsonb,
	"secret" text,
	"access_key_id_preview" text,
	"secret_preview" text,
	"transfer" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_evals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"proposal_id" text,
	"before_text" text NOT NULL,
	"text_after" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb,
	"error" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"input" text NOT NULL,
	"must_include" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"must_not_include" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruction_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"seq" integer NOT NULL,
	"text" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text,
	"reason" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"proposal_id" text,
	"restored_from_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_consolidations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"covered" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"error" text,
	"run_id" text,
	"created_by" text,
	"decider_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"op" text NOT NULL,
	"memory_id" text,
	"path" text,
	"new_path" text,
	"text" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"about" text,
	"replaces" text,
	"base_sha256" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	"tool" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decider_user_id" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"result_memory_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"text" text NOT NULL,
	"path" text,
	"archived" boolean NOT NULL,
	"sha256" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text,
	"run_id" text,
	"reason" text DEFAULT '' NOT NULL,
	"approved_by_user_id" text,
	"restored_from_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_environments" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"last_used_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_interventions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"url" text,
	"controlling_user_id" text,
	"target_user_id" text,
	"note" text,
	"channel_id" text,
	"thread_id" text,
	"message_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"handled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "browser_log_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"run_id" text,
	"channel_id" text,
	"tool" text NOT NULL,
	"action" jsonb NOT NULL,
	"url" text,
	"outcome" text NOT NULL,
	"message" text,
	"blocked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shot_key" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_policies" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"permitted_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"level" text,
	"private_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"private_ranges_runner_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"channel_id" text,
	"thread_id" text,
	"message_id" text,
	"run_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"assignment_id" text,
	"thread_id" text,
	"channel_id" text,
	"title" text NOT NULL,
	"executor" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"resumed_job_id" text,
	"branch" text,
	"pr_url" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exit_code" integer,
	"tail_line" text,
	"result" text,
	"session" text,
	"output_tail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_signal_at" timestamp with time zone,
	"plan_item_id" text,
	"usage" jsonb,
	"denied" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diff" text,
	"settled_at" timestamp with time zone,
	"cost_recorded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runner_pairings" (
	"user_code" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"hostname" text NOT NULL,
	"version" text NOT NULL,
	"previous_runner_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"workspace_id" text,
	"runner_id" text,
	"signed_off_by" text,
	"token_sealed" text,
	"last_poll_at" timestamp with time zone,
	"interval_seconds" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_secrets" (
	"agent_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"name" text NOT NULL,
	"workspace_id" text NOT NULL,
	"target" text NOT NULL,
	"file_path" text,
	"delivered_by" text,
	"browser" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_secrets_agent_id_runner_id_name_pk" PRIMARY KEY("agent_id","runner_id","name")
);
--> statement-breakpoint
CREATE TABLE "runner_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"credential_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"arch" text DEFAULT '' NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"runner_release" text DEFAULT '' NOT NULL,
	"token_hash" text NOT NULL,
	"token_pending_hash" text,
	"token_prev_hash" text,
	"credential_rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"sandbox" jsonb,
	"store_key" text NOT NULL,
	"paired_by_user_id" text NOT NULL,
	"work_dir" text,
	"access" jsonb DEFAULT '{"folders":[],"tools":{"claude":false,"codex":false,"commands":false,"browser":false}}'::jsonb NOT NULL,
	"executors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cli" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"browser" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_online_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"network" text DEFAULT 'allowlist' NOT NULL,
	"permitted_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minutes_per_day" integer DEFAULT 120 NOT NULL,
	"command_timeout_sec" integer DEFAULT 120 NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"target" text NOT NULL,
	"file_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_user_id" text,
	"public_key" text NOT NULL,
	"channel_id" text,
	"thread_id" text,
	"message_id" text,
	"run_id" text,
	"decided_by" text,
	"browser" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"fulfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "search_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"title_fold" text NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"url" text NOT NULL,
	"scope_kind" text NOT NULL,
	"channel_id" text,
	"principals" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_id" text,
	"page" integer,
	"has" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_facets" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"untrusted" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"embed_state" text DEFAULT 'none' NOT NULL,
	"embed_claimed_at" timestamp with time zone,
	"text_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_counters" (
	"scope" text NOT NULL,
	"period" text NOT NULL,
	"workspace_id" text NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "budget_counters_scope_period_pk" PRIMARY KEY("scope","period")
);
--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text,
	"tool" text NOT NULL,
	"effect" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_id" text,
	"initiated_by" text,
	"credential" jsonb,
	"by" text,
	"rule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text,
	"user_id" text,
	"channel_id" text,
	"assignment_id" text,
	"run_id" text,
	"reservation_id" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"iteration" text DEFAULT 'message' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_5m_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_1h_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"batch" boolean DEFAULT false NOT NULL,
	"speed" text DEFAULT 'standard' NOT NULL,
	"inference_geo" text,
	"service_tier" text,
	"key_source" text DEFAULT 'platform' NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"price_version" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reservation_scopes" (
	"reservation_id" text NOT NULL,
	"scope" text NOT NULL,
	"period" text NOT NULL,
	CONSTRAINT "usage_reservation_scopes_reservation_id_scope_pk" PRIMARY KEY("reservation_id","scope")
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"estimate_micros" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"scopes" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"stage" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"rule" jsonb,
	"exdates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"series_id" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"location" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effect_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"tool" text NOT NULL,
	"run_id" text,
	"status" text NOT NULL,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_timeline" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"kind" text NOT NULL,
	"event" text,
	"text_key" text,
	"text_vars" jsonb,
	"text" text NOT NULL,
	"author" jsonb NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" serial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"column_id" text NOT NULL,
	"board_position" double precision DEFAULT 0 NOT NULL,
	"priority" text DEFAULT 'none' NOT NULL,
	"assignee" jsonb,
	"created_by" jsonb NOT NULL,
	"due_date" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" jsonb,
	"channel_id" text,
	"parent_id" text,
	"pull_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"notification_id" text NOT NULL,
	"channel" text NOT NULL,
	"cause" text DEFAULT 'event' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"group_key" text NOT NULL,
	"waiting" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"muted_until" timestamp with time zone,
	"saved_at" timestamp with time zone,
	"tab" text DEFAULT 'fyi' NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"rule_id" text,
	"priority" text,
	"remind_at" timestamp with time zone,
	"count" integer DEFAULT 1 NOT NULL,
	"actors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"trigger" text,
	"scheduled_for" timestamp with time zone,
	"dedupe_key" text,
	"reason" text,
	"not_before" timestamp with time zone,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempt" integer DEFAULT 1 NOT NULL,
	"retry_of" text,
	"retried" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"summary" text,
	"summary_key" text,
	"summary_vars" jsonb,
	"channel_id" text,
	"thread_id" text,
	"message_id" text,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"agent_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"trigger" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_fire_at" timestamp with time zone,
	"running_since" timestamp with time zone,
	"running_until" timestamp with time zone,
	"webhook_token" text,
	"webhook_secret" text,
	"cursor" jsonb,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule_from" timestamp with time zone,
	"paused_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"endorsed_by" text,
	"requested_new_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"handle" text NOT NULL,
	"timezone" text,
	"avatar_key" text,
	"member_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_online_at" timestamp with time zone,
	CONSTRAINT "members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"logo_key" text,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"primary_credential_id" text,
	"agent_budget_default_usd" double precision DEFAULT 20 NOT NULL,
	"approval_reviewer" boolean DEFAULT false NOT NULL,
	"default_channel_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_grants" ADD CONSTRAINT "skill_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_grants" ADD CONSTRAINT "skill_grants_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_command_rules" ADD CONSTRAINT "assignment_command_rules_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_command_stats" ADD CONSTRAINT "assignment_command_stats_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_commands" ADD CONSTRAINT "assignment_commands_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_decisions" ADD CONSTRAINT "assignment_decisions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_join_requests" ADD CONSTRAINT "assignment_join_requests_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_participants" ADD CONSTRAINT "assignment_participants_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_plan_items" ADD CONSTRAINT "assignment_plan_items_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_plan_versions" ADD CONSTRAINT "assignment_plan_versions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_proofs" ADD CONSTRAINT "assignment_proofs_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_reviews" ADD CONSTRAINT "assignment_reviews_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_seen" ADD CONSTRAINT "assignment_seen_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_work" ADD CONSTRAINT "assignment_work_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_databases" ADD CONSTRAINT "db_databases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_rows" ADD CONSTRAINT "db_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_rows" ADD CONSTRAINT "db_rows_table_id_db_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."db_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_tables" ADD CONSTRAINT "db_tables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_tables" ADD CONSTRAINT "db_tables_database_id_db_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."db_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_views" ADD CONSTRAINT "db_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_views" ADD CONSTRAINT "db_views_database_id_db_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."db_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_views" ADD CONSTRAINT "db_views_table_id_db_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."db_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_memberships" ADD CONSTRAINT "channel_memberships_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emoji_reactions" ADD CONSTRAINT "emoji_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_subscriptions" ADD CONSTRAINT "thread_subscriptions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_posts" ADD CONSTRAINT "debate_posts_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pages" ADD CONSTRAINT "knowledge_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_source_id_knowledge_pages_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_target_id_knowledge_pages_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_attachments" ADD CONSTRAINT "wiki_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_attachments" ADD CONSTRAINT "wiki_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_docs" ADD CONSTRAINT "wiki_page_docs_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_views" ADD CONSTRAINT "wiki_page_views_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_prop_schemas" ADD CONSTRAINT "wiki_prop_schemas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reversible_actions" ADD CONSTRAINT "reversible_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reversible_actions" ADD CONSTRAINT "reversible_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channel_access" ADD CONSTRAINT "agent_channel_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channel_access" ADD CONSTRAINT "agent_channel_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_databases" ADD CONSTRAINT "agent_databases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_databases" ADD CONSTRAINT "agent_databases_connection_id_data_sources_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_databases" ADD CONSTRAINT "agent_databases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_account_id_mail_connections_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_usage" ADD CONSTRAINT "integration_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_evals" ADD CONSTRAINT "agent_evals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_evals" ADD CONSTRAINT "agent_evals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_cases" ADD CONSTRAINT "agent_test_cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_test_cases" ADD CONSTRAINT "agent_test_cases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_versions" ADD CONSTRAINT "instruction_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_versions" ADD CONSTRAINT "instruction_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_consolidations" ADD CONSTRAINT "memory_consolidations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_consolidations" ADD CONSTRAINT "memory_consolidations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environments" ADD CONSTRAINT "agent_environments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_environments" ADD CONSTRAINT "agent_environments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_interventions" ADD CONSTRAINT "browser_interventions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_interventions" ADD CONSTRAINT "browser_interventions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policies" ADD CONSTRAINT "browser_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policies" ADD CONSTRAINT "browser_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_requests" ADD CONSTRAINT "network_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_requests" ADD CONSTRAINT "network_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_secrets" ADD CONSTRAINT "runner_secrets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_secrets" ADD CONSTRAINT "runner_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_sessions" ADD CONSTRAINT "runner_sessions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_policies" ADD CONSTRAINT "sandbox_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_prompts" ADD CONSTRAINT "secret_prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_prompts" ADD CONSTRAINT "secret_prompts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_counters" ADD CONSTRAINT "budget_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_lines" ADD CONSTRAINT "usage_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservation_scopes" ADD CONSTRAINT "usage_reservation_scopes_reservation_id_usage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."usage_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_proposals" ADD CONSTRAINT "calendar_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_proposals" ADD CONSTRAINT "calendar_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effect_keys" ADD CONSTRAINT "effect_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_timeline" ADD CONSTRAINT "issue_timeline_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_executions" ADD CONSTRAINT "routine_executions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_handle_uq" ON "agents" USING btree ("workspace_id","handle");--> statement-breakpoint
CREATE INDEX "agents_workspace_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credentials_workspace_idx" ON "credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "delegations_workspace_idx" ON "delegations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "memories_agent_idx" ON "memories" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memories_store_idx" ON "memories" USING btree ("workspace_id","scope","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_agent_path_uq" ON "memories" USING btree ("agent_id","path") WHERE scope = 'agent' and archived = false and path is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_person_path_uq" ON "memories" USING btree ("workspace_id","owner_user_id","path") WHERE scope = 'person' and archived = false and path is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_workspace_path_uq" ON "memories" USING btree ("workspace_id","path") WHERE scope = 'workspace' and archived = false and path is not null;--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("at") WHERE status = 'scheduled';--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "runs" USING btree ("workspace_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_active_idx" ON "runs" USING btree ("channel_id") WHERE status in ('queued','running','paused_for_input','paused_for_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_uq" ON "skills" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "assignment_command_rules_assignment_idx" ON "assignment_command_rules" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_commands_assignment_idx" ON "assignment_commands" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_decisions_assignment_idx" ON "assignment_decisions" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_events_key_uq" ON "assignment_events" USING btree ("key");--> statement-breakpoint
CREATE INDEX "assignment_events_assignment_idx" ON "assignment_events" USING btree ("assignment_id","seq");--> statement-breakpoint
CREATE INDEX "assignment_plan_items_ord_idx" ON "assignment_plan_items" USING btree ("assignment_id","ord");--> statement-breakpoint
CREATE INDEX "assignment_proofs_assignment_idx" ON "assignment_proofs" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_reviews_assignment_idx" ON "assignment_reviews" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "assignment_submissions_assignment_idx" ON "assignment_submissions" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_work_key_uq" ON "assignment_work" USING btree ("assignment_id","item_id","n");--> statement-breakpoint
CREATE INDEX "assignment_work_ref_idx" ON "assignment_work" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "assignments_workspace_idx" ON "assignments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "assignments_thread_idx" ON "assignments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "assignments_agent_idx" ON "assignments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "db_databases_workspace_idx" ON "db_databases" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "db_databases_file_uq" ON "db_databases" USING btree ("workspace_id","source_file_id");--> statement-breakpoint
CREATE INDEX "db_rows_table_pos_idx" ON "db_rows" USING btree ("table_id","position" collate "C","id");--> statement-breakpoint
CREATE INDEX "db_rows_props_gin" ON "db_rows" USING gin ("props" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "db_rows_calc_idx" ON "db_rows" USING btree ("table_id","calc_version");--> statement-breakpoint
CREATE INDEX "db_tables_database_idx" ON "db_tables" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "db_tables_pending_idx" ON "db_tables" USING btree ("workspace_id") WHERE calc_done_version < calc_version;--> statement-breakpoint
CREATE INDEX "db_views_database_idx" ON "db_views" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "db_views_table_idx" ON "db_views" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "channel_memberships_member_idx" ON "channel_memberships" USING btree ("member_type","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_uq" ON "channels" USING btree ("workspace_id","name") WHERE kind = 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_dm_uq" ON "channels" USING btree ("workspace_id","dm_key");--> statement-breakpoint
CREATE INDEX "channels_workspace_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_channel_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_uq" ON "messages" USING btree ("channel_id","author_id","client_id");--> statement-breakpoint
CREATE INDEX "threads_workspace_activity_idx" ON "threads" USING btree ("workspace_id","last_touched_at");--> statement-breakpoint
CREATE INDEX "debate_posts_topic_idx" ON "debate_posts" USING btree ("debate_id","created_at");--> statement-breakpoint
CREATE INDEX "debates_workspace_idx" ON "debates" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "file_versions_extract_idx" ON "file_versions" USING btree ("extract_status") WHERE extract_status in ('pending', 'working');--> statement-breakpoint
CREATE INDEX "files_workspace_idx" ON "files" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "files_purge_idx" ON "files" USING btree ("expunge_at") WHERE deleted_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_pages_slug_uq" ON "knowledge_pages" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_pages_workspace_idx" ON "knowledge_pages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_pages_purge_idx" ON "knowledge_pages" USING btree ("expunge_at") WHERE deleted_at is not null;--> statement-breakpoint
CREATE INDEX "page_links_target_idx" ON "page_links" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "page_links_workspace_idx" ON "page_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "page_links_workspace_slug_idx" ON "page_links" USING btree ("workspace_id","target_slug");--> statement-breakpoint
CREATE INDEX "upload_sessions_expires_idx" ON "upload_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_match_uq" ON "approval_rules" USING btree ("agent_id","tool","rule_key") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "approval_rules_workspace_idx" ON "approval_rules" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_workspace_idx" ON "approvals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("send_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "proposals_workspace_idx" ON "proposals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "questions_workspace_idx" ON "questions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "reversible_actions_message_idx" ON "reversible_actions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "reversible_actions_run_idx" ON "reversible_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "connections_workspace_idx" ON "connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "connections_agent_idx" ON "connections" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "data_sources_workspace_idx" ON "data_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_installations_workspace_idx" ON "github_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "integration_usage_idx" ON "integration_usage" USING btree ("agent_id","resource_id","kind","at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_connections_address_uq" ON "mail_connections" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX "oauth_states_exp_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_evals_agent_idx" ON "agent_evals" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_evals_running_uq" ON "agent_evals" USING btree ("agent_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "agent_test_cases_agent_idx" ON "agent_test_cases" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_versions_uq" ON "instruction_versions" USING btree ("agent_id","seq");--> statement-breakpoint
CREATE INDEX "memory_consolidations_agent_idx" ON "memory_consolidations" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_consolidations_open_uq" ON "memory_consolidations" USING btree ("agent_id") WHERE status in ('running', 'ready');--> statement-breakpoint
CREATE INDEX "memory_reviews_pending_idx" ON "memory_reviews" USING btree ("workspace_id","agent_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_versions_uq" ON "memory_versions" USING btree ("memory_id","seq");--> statement-breakpoint
CREATE INDEX "browser_interventions_agent_idx" ON "browser_interventions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "browser_log_entries_agent_idx" ON "browser_log_entries" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "browser_log_entries_run_idx" ON "browser_log_entries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "network_requests_agent_idx" ON "network_requests" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "network_requests_open_uq" ON "network_requests" USING btree ("agent_id","domain") WHERE "network_requests"."status" in ('pending', 'allowed');--> statement-breakpoint
CREATE INDEX "runner_jobs_thread_idx" ON "runner_jobs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "runner_jobs_runner_idx" ON "runner_jobs" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "runner_jobs_assignment_idx" ON "runner_jobs" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pairings_code_uq" ON "runner_pairings" USING btree ("device_code_hash");--> statement-breakpoint
CREATE INDEX "runner_sessions_runner_idx" ON "runner_sessions" USING btree ("runner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_token_uq" ON "runners" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "runners_token_pending_idx" ON "runners" USING btree ("token_pending_hash");--> statement-breakpoint
CREATE INDEX "runners_token_prev_idx" ON "runners" USING btree ("token_prev_hash");--> statement-breakpoint
CREATE INDEX "runners_workspace_idx" ON "runners" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "secret_prompts_agent_idx" ON "secret_prompts" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_chunks_source_uq" ON "search_chunks" USING btree ("source_kind","source_id","ordinal");--> statement-breakpoint
CREATE INDEX "search_chunks_workspace_idx" ON "search_chunks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "search_chunks_tsv_idx" ON "search_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_chunks_title_trgm_idx" ON "search_chunks" USING gin ("title_fold" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_chunks_channel_idx" ON "search_chunks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "search_chunks_embed_idx" ON "search_chunks" USING btree ("embed_state") WHERE embed_state in ('pending', 'working');--> statement-breakpoint
CREATE INDEX "gate_decisions_workspace_idx" ON "gate_decisions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "gate_decisions_approval_idx" ON "gate_decisions" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "gate_decisions_reviewer_idx" ON "gate_decisions" USING btree ("agent_id","created_at") WHERE by = 'reviewer';--> statement-breakpoint
CREATE INDEX "usage_lines_workspace_idx" ON "usage_lines" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "usage_lines_agent_idx" ON "usage_lines" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "usage_lines_run_idx" ON "usage_lines" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_lines_channel_idx" ON "usage_lines" USING btree ("channel_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_lines_reservation_uq" ON "usage_lines" USING btree ("reservation_id","seq") WHERE reservation_id is not null;--> statement-breakpoint
CREATE INDEX "usage_reservation_scopes_idx" ON "usage_reservation_scopes" USING btree ("scope","period");--> statement-breakpoint
CREATE INDEX "usage_reservations_open_idx" ON "usage_reservations" USING btree ("expires_at") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "board_columns_workspace_idx" ON "board_columns" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "calendar_entries_workspace_idx" ON "calendar_entries" USING btree ("workspace_id","start");--> statement-breakpoint
CREATE INDEX "calendar_proposals_workspace_idx" ON "calendar_proposals" USING btree ("workspace_id","start");--> statement-breakpoint
CREATE INDEX "issue_timeline_issue_idx" ON "issue_timeline" USING btree ("issue_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_number_uq" ON "issues" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "issues_column_idx" ON "issues" USING btree ("column_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_open_uq" ON "notification_deliveries" USING btree ("notification_id","channel") WHERE "notification_deliveries"."status" in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("due_at") WHERE "notification_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_settings_uq" ON "notification_settings" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_group_uq" ON "notifications" USING btree ("workspace_id","user_id","group_key");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("workspace_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "notifications_waiting_idx" ON "notifications" USING btree ("id") WHERE "notifications"."waiting";--> statement-breakpoint
CREATE INDEX "notifications_remind_idx" ON "notifications" USING btree ("remind_at") WHERE "notifications"."remind_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_uq" ON "push_subscriptions" USING btree ("user_id","endpoint");--> statement-breakpoint
CREATE INDEX "routine_executions_routine_idx" ON "routine_executions" USING btree ("routine_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_executions_slot_uq" ON "routine_executions" USING btree ("routine_id","scheduled_for") WHERE scheduled_for is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_executions_dedupe_uq" ON "routine_executions" USING btree ("routine_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_executions_queued_uq" ON "routine_executions" USING btree ("routine_id") WHERE status = 'queued' and trigger <> 'retry';--> statement-breakpoint
CREATE INDEX "routine_executions_queue_idx" ON "routine_executions" USING btree ("not_before") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "routines_workspace_idx" ON "routines" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "routines_due_idx" ON "routines" USING btree ("next_fire_at") WHERE active;--> statement-breakpoint
CREATE UNIQUE INDEX "routines_hook_uq" ON "routines" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "invitations_workspace_idx" ON "invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "members_handle_uq" ON "members" USING btree ("workspace_id","handle");--> statement-breakpoint
-- The browser log only grows: the database rejects UPDATE, DELETE and TRUNCATE on it. Retention
-- cleanup and removal requests set `app.browser_log_purge` to 'on' inside their own transaction.
CREATE FUNCTION "browser_log_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.browser_log_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'browser_log_entries is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "browser_log_entries_no_change" BEFORE UPDATE OR DELETE ON "browser_log_entries"
  FOR EACH ROW EXECUTE FUNCTION "browser_log_entries_append_only"();
--> statement-breakpoint
CREATE TRIGGER "browser_log_entries_no_truncate" BEFORE TRUNCATE ON "browser_log_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "browser_log_entries_append_only"();

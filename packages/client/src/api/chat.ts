// Channels, messages, direct messages, pins, threads and search.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { ThreadFollow, ThreadPage } from "./shapes.ts";

/** Who a direct message or a channel membership is about. */
export type MemberTarget = { userId: string } | { agentId: string };

export type ThreadAction = "archive" | "close" | "move" | "reopen" | "return" | "unarchive";

export interface ThreadsQuery {
  tab?: string;
  channelId?: string;
  agentId?: string;
  actionNeeded?: true;
  mine?: true;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface PostMessageBody {
  body: string;
  /** Chosen by the client so a retried post is stored once and the echo can be matched. */
  clientId: string;
  threadId?: string;
  replyTo?: string;
  /** File ids. */
  attachments?: string[];
  spawnsThread?: boolean;
}

const Reactions = s.field("reactions", s.array(C.ReactionCount));

export const chat = {
  listChannels: e("GET", "/api/v1/workspaces/:workspaceId/channels", s.field("channels", s.array(C.Channel))),
  createChannel: e("POST", "/api/v1/workspaces/:workspaceId/channels", C.Channel).body<{
    name: string;
    topic?: string;
    visibility: T.ChannelVisibility;
  }>(),
  updateChannel: e("PATCH", "/api/v1/workspaces/:workspaceId/channels/:channelId", C.Channel).body<{
    name?: string;
    topic?: string;
    budgetPerMonthUsd?: number | null;
  }>(),
  joinChannel: e("POST", "/api/v1/workspaces/:workspaceId/channels/:channelId/join", NOTHING),
  markChannelRead: e("POST", "/api/v1/workspaces/:workspaceId/channels/:channelId/read", NOTHING),
  getChannelDirectory: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/directory",
    s.field("members", s.array(C.DirectoryMember)),
  ),
  listChannelMembers: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/members",
    s.field("members", s.array(C.ChannelMember)),
  ),
  createChannelMember: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/members",
    NOTHING,
  ).body<MemberTarget>(),
  deleteChannelMemberAgent: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/members/agents/:agentId",
    NOTHING,
  ),
  deleteChannelMemberPerson: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/members/people/:personId",
    NOTHING,
  ),
  listChannelMessages: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/messages",
    s.field("messages", s.array(C.Message)),
  ).query<T.MessagesQuery>(),
  createChannelMessage: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/messages",
    C.Message,
  ).body<PostMessageBody>(),
  listMessageReactions: e("GET", "/api/v1/workspaces/:workspaceId/messages/:messageId/reactions", Reactions),
  createMessageReaction: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/messages/:messageId/reactions",
    Reactions,
  ).body<{ reaction: string }>(),
  clearMessageReactions: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/messages/:messageId/reactions",
    Reactions,
  ).query<{ reaction: string }>(),
  createMessageFeedback: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/messages/:messageId/feedback",
    C.Message,
  ).body<{ body: string }>(),

  getDms: e("GET", "/api/v1/workspaces/:workspaceId/dms", s.field("dms", s.array(C.DirectMessage))),
  createDm: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/dms",
    s.object({ channelId: s.string }),
  ).body<MemberTarget>(),

  listChannelPinnedMessages: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/pinned-messages",
    s.field("pins", s.array(C.MessagePin)),
  ),
  updateChannelPinnedMessage: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/pinned-messages/:messageId",
    C.MessagePin,
  ),
  deleteChannelPinnedMessage: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/pinned-messages/:messageId",
    NOTHING,
  ),

  listThreads: e("GET", "/api/v1/workspaces/:workspaceId/threads", ThreadPage).query<ThreadsQuery>(),
  listChannelThreads: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/threads",
    ThreadPage,
  ).query<ThreadsQuery>(),
  getThread: e("GET", "/api/v1/workspaces/:workspaceId/threads/:threadId", C.ThreadInfo),
  createThread: e("POST", "/api/v1/workspaces/:workspaceId/threads", C.ThreadInfo).body<{
    channelId: string;
    messageId: string;
    title?: string;
  }>(),
  updateThread: e("PATCH", "/api/v1/workspaces/:workspaceId/threads/:threadId", C.ThreadInfo).body<{
    title?: string;
    rootMessageId?: string;
    lastMessageId?: string;
    omittedMessageIds?: string[];
  }>(),
  deleteThread: e("DELETE", "/api/v1/workspaces/:workspaceId/threads/:threadId", NOTHING),
  /** `action` is a ThreadAction. */
  runActionOnThread: e("POST", "/api/v1/workspaces/:workspaceId/threads/:threadId/:action", C.ThreadInfo),
  followThread: e("PUT", "/api/v1/workspaces/:workspaceId/threads/:threadId/follow", ThreadFollow),
  unfollowThread: e("DELETE", "/api/v1/workspaces/:workspaceId/threads/:threadId/follow", ThreadFollow),

  getSearch: e("GET", "/api/v1/workspaces/:workspaceId/search", s.field("hits", s.array(C.SearchHit))).query<{
    q: string;
    kinds?: readonly T.SearchKind[];
    limit?: number;
  }>(),
  getSearchPalette: e("GET", "/api/v1/workspaces/:workspaceId/search/palette", C.PaletteResult).query<{
    q: string;
  }>(),
  askSearch: e("POST", "/api/v1/workspaces/:workspaceId/search/ask", C.AskAnswer).body<{ q: string }>(),
  listActiveRuns: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/active-runs",
    s.field("runs", s.array(C.WorkingRun)),
  ),
};

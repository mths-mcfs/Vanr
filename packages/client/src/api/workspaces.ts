// Workspaces, the people in them, invitations and settings.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";

/** An image sent inline, base64-encoded. */
export interface ImageBody {
  imageBase64: string;
  contentType: string;
}

const InviteLink = s.object({ url: s.string, expiresAt: s.string });

export const workspaces = {
  createWorkspace: e(
    "POST",
    "/api/v1/workspaces",
    s.object({ workspace: C.Workspace, defaultChannelId: s.string }),
  ).body<{ name: string; context?: string; timezone?: string }>(),
  getWorkspace: e("GET", "/api/v1/workspaces/:workspaceId", C.Workspace),
  updateWorkspace: e("PATCH", "/api/v1/workspaces/:workspaceId", NOTHING).body<{
    name?: string;
    context?: string;
  }>(),
  getOverview: e("GET", "/api/v1/workspaces/:workspaceId/overview", C.WorkspaceOverview),
  getSettings: e("GET", "/api/v1/workspaces/:workspaceId/settings", C.WorkspaceSettings),
  updateSettings: e("PATCH", "/api/v1/workspaces/:workspaceId/settings", C.WorkspaceSettings).body<
    Partial<T.WorkspaceSettings>
  >(),
  setLogo: e("PUT", "/api/v1/workspaces/:workspaceId/logo", s.object({ logo: s.string })).body<ImageBody>(),
  deleteLogo: e("DELETE", "/api/v1/workspaces/:workspaceId/logo", NOTHING),
  getUsageReport: e("GET", "/api/v1/workspaces/:workspaceId/usage/report", C.UsageReport).query<{
    since?: string;
  }>(),

  updateMe: e("PATCH", "/api/v1/workspaces/:workspaceId/me", C.Person).body<{
    name?: string;
    handle?: string;
    timezone?: string | null;
  }>(),
  setMeAvatar: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/me/avatar",
    s.object({ avatarUrl: s.string }),
  ).body<ImageBody>(),
  deleteMeAvatar: e("DELETE", "/api/v1/workspaces/:workspaceId/me/avatar", NOTHING),
  getPeople: e("GET", "/api/v1/workspaces/:workspaceId/people", s.field("people", s.array(C.Person))),
  listMembers: e("GET", "/api/v1/workspaces/:workspaceId/members", s.field("members", s.array(C.Member))),
  updateMember: e("PATCH", "/api/v1/workspaces/:workspaceId/members/:memberId", NOTHING).body<{
    role: T.Role;
  }>(),
  deleteMember: e("DELETE", "/api/v1/workspaces/:workspaceId/members/:memberId", NOTHING),

  listInvitations: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/invitations",
    s.field("invitations", s.array(C.Invitation)),
  ),
  listAllInvitations: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/invitations?scope=all",
    s.field("invitations", s.array(C.InvitationWithStatus)),
  ),
  createInvitation: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/invitations",
    s.object({ invitation: C.Invitation, url: s.string }),
  ).body<{ email: string; role: T.Role }>(),
  createInvitationBulk: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/invitations/bulk",
    s.field("results", s.array(C.BatchInviteResult)),
  ).body<{ emails: string[]; role: T.Role }>(),
  resendInvitation: e("POST", "/api/v1/workspaces/:workspaceId/invitations/:invitationId/resend", InviteLink),
  deleteInvitation: e("DELETE", "/api/v1/workspaces/:workspaceId/invitations/:invitationId", NOTHING),
  createInviteLink: e("POST", "/api/v1/workspaces/:workspaceId/invite-links", InviteLink),
  /** null when the invitation doesn't exist (or no longer does). */
  getInvitation: e("GET", "/api/v1/invitations/:invitationId", C.InvitationPreview).orNullOn(404),
  acceptInvitation: e(
    "POST",
    "/api/v1/invitations/:invitationId/accept",
    s.object({ workspaceId: s.string }),
  ),
  requestInvitationNew: e("POST", "/api/v1/invitations/:invitationId/request-new", NOTHING),
};

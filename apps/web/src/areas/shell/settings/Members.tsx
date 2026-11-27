// The people of the workspace and their roles. Whoever may manage members also invites by email,
// sees the invitations still open, changes roles and removes people; nobody changes their own role
// here, and only an owner touches another owner.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Member, Role } from "@vanr/contract";
import {
  Avatar,
  Button,
  Callout,
  Chip,
  ConfirmDialog,
  Field,
  Input,
  Select,
  SelectItem,
  Surface,
} from "@vanr/ui";
import { Copy, Mail, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useSession } from "../../../session/react.tsx";
import { SectionError, SectionLoading, useOutcome, useWorkspaceAccess } from "./shared.tsx";

export function MembersSection() {
  const { may } = useWorkspaceAccess();
  const manage = may("manage_members");
  return (
    <>
      {manage && <InviteForm />}
      <MemberList manage={manage} />
      {manage && <PendingInvitations />}
    </>
  );
}

/** The roles the caller may give: owner only by an owner. */
function useGivableRoles(): readonly Role[] {
  const { may } = useWorkspaceAccess();
  return may("manage_owners") ? ["member", "admin", "owner"] : ["member", "admin"];
}

function InviteForm() {
  const t = useMessages("settings");
  const { workspaceId } = useWorkspaceAccess();
  const roles = useGivableRoles();
  const outcome = useOutcome();
  const describe = useErrorMessage("settings");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const invite = useApiMutation("createInvitation", {
    invalidates: () => [{ method: "listInvitations", args: { workspaceId } }],
  });
  const address = email.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (address === "") return;
    invite.mutate(
      { workspaceId, body: { email: address, role } },
      {
        onSuccess: (result) => {
          setLink({ email: address, url: result.url });
          setEmail("");
          outcome.done(t("members.invited", { email: address }));
        },
      },
    );
  };

  return (
    <Surface variant="card" className="section-card">
      <h3 className="page__heading">{t("members.inviteTitle")}</h3>
      <form className="invite-form" onSubmit={submit} aria-label={t("members.inviteTitle")}>
        <Field label={t("members.email")}>
          <Input
            type="email"
            value={email}
            required
            autoComplete="off"
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label={t("members.role")}>
          <Select value={role} onValueChange={(next) => setRole(roleOf(next))}>
            {roles.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`role.${option}`)}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" loading={invite.isPending} disabled={address === ""}>
          {t("members.invite")}
        </Button>
      </form>
      {invite.isError && (
        <Callout tone="danger" role="alert" title={t("members.inviteFailed")}>
          {describe(invite.error)}
        </Callout>
      )}
      {link !== null && !invite.isError && (
        <Callout
          tone="success"
          title={t("members.linkTitle", { email: link.email })}
          actions={
            <Button
              size="sm"
              icon={<Copy aria-hidden="true" />}
              onClick={() =>
                void navigator.clipboard?.writeText(link.url).then(() => outcome.done(t("members.copied")))
              }
            >
              {t("members.copy")}
            </Button>
          }
        >
          <code className="invite-link">{link.url}</code>
        </Callout>
      )}
    </Surface>
  );
}

const ROLES: readonly Role[] = ["member", "admin", "owner"];
const roleOf = (value: string): Role => ROLES.find((role) => role === value) ?? "member";

function MemberList({ manage }: { manage: boolean }) {
  const t = useMessages("settings");
  const { workspaceId, may } = useWorkspaceAccess();
  const { me } = useSession();
  const roles = useGivableRoles();
  const outcome = useOutcome();
  const members = useApiQuery("listMembers", { workspaceId });
  const [removing, setRemoving] = useState<Member | null>(null);
  const changed = [
    { method: "listMembers", args: { workspaceId } },
    { method: "getPeople", args: { workspaceId } },
    { method: "getOverview", args: { workspaceId } },
  ] as const;
  const changeRole = useApiMutation("updateMember", { invalidates: () => [...changed] });
  const remove = useApiMutation("deleteMember", { invalidates: () => [...changed] });

  if (members.isPending) return <SectionLoading />;
  if (members.isError) {
    return (
      <SectionError
        title={t("members.failed")}
        error={members.error}
        onRetry={() => void members.refetch()}
      />
    );
  }
  const changeable = (member: Member) =>
    manage && member.userId !== me?.user.id && (member.role !== "owner" || may("manage_owners"));

  return (
    <section className="page__section" aria-labelledby="members-list">
      <h3 className="page__heading" id="members-list">
        {t("members.count", { count: members.data.length })}
      </h3>
      <ul className="listing listing--wide" aria-label={t("members.list")}>
        {members.data.map((member) => (
          <li key={member.userId} className="listing__row">
            <Avatar name={member.name} src={member.avatarUrl ?? member.image ?? undefined} size="sm" />
            <span className="member__who">
              <span className="listing__name">
                {member.name}
                {member.userId === me?.user.id && <span className="page__muted"> {t("members.you")}</span>}
              </span>
              <span className="listing__handle">
                @{member.handle} · {member.email}
              </span>
            </span>
            {changeable(member) ? (
              <span className="member__actions">
                <Select
                  size="sm"
                  aria-label={t("members.roleOf", { name: member.name })}
                  value={member.role}
                  disabled={changeRole.isPending && changeRole.variables?.memberId === member.userId}
                  onValueChange={(next) => {
                    const role = roleOf(next);
                    changeRole.mutate(
                      { workspaceId, memberId: member.userId, body: { role } },
                      {
                        onSuccess: () =>
                          outcome.done(
                            t("members.roleChanged", { name: member.name, role: t(`role.${role}`) }),
                          ),
                        onError: outcome.failed,
                      },
                    );
                  }}
                >
                  {roles.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`role.${option}`)}
                    </SelectItem>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  aria-label={t("members.remove", { name: member.name })}
                  onClick={() => setRemoving(member)}
                />
              </span>
            ) : (
              <Chip>{t(`role.${member.role}`)}</Chip>
            )}
          </li>
        ))}
      </ul>
      {removing !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={t("members.removeTitle", { name: removing.name })}
          description={t("members.removeBody")}
          confirmLabel={t("members.removeAction")}
          cancelLabel={t("members.keep")}
          tone="danger"
          confirming={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              { workspaceId, memberId: removing.userId },
              {
                onSuccess: () => {
                  outcome.done(t("members.removed", { name: removing.name }));
                  setRemoving(null);
                },
                onError: outcome.failed,
              },
            )
          }
        />
      )}
    </section>
  );
}

function PendingInvitations() {
  const t = useMessages("settings");
  const { workspaceId } = useWorkspaceAccess();
  const outcome = useOutcome();
  const invitations = useApiQuery("listInvitations", { workspaceId });
  const revoke = useApiMutation("deleteInvitation", {
    invalidates: () => [{ method: "listInvitations", args: { workspaceId } }],
  });

  if (invitations.isPending) return null;
  if (invitations.isError) {
    return (
      <SectionError
        title={t("members.pendingFailed")}
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
      />
    );
  }
  // The block appears only while some invitation is open.
  if (invitations.data.length === 0) return null;
  return (
    <section className="page__section" aria-labelledby="members-pending">
      <h3 className="page__heading" id="members-pending">
        {t("members.pending")}
      </h3>
      <ul className="listing listing--wide" aria-label={t("members.pending")}>
        {invitations.data.map((invitation) => {
          const who = invitation.email ?? t("members.byLink");
          return (
            <li key={invitation.id} className="listing__row">
              <Mail aria-hidden="true" className="member__icon" />
              <span className="member__who">
                <span className="listing__name">{who}</span>
              </span>
              <Chip>{t(`role.${invitation.role}`)}</Chip>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("members.revokeOf", { who })}
                loading={revoke.isPending && revoke.variables?.invitationId === invitation.id}
                onClick={() =>
                  revoke.mutate(
                    { workspaceId, invitationId: invitation.id },
                    { onSuccess: () => outcome.done(t("members.revoked", { who })), onError: outcome.failed },
                  )
                }
              >
                {t("members.revoke")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

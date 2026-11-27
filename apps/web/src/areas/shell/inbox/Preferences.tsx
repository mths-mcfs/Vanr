// The person's notification preferences in this workspace: push and the "waiting on you" email,
// quiet (do not disturb and daily quiet hours), push and email by kind, muted channels and the
// rules that send notices to a tab. "Do not disturb" saves at once; the rest waits for Save.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type {
  NotificationKind,
  NotificationRule,
  NotificationSettings,
  NotificationTab,
} from "@vanr/contract";
import { Button, Callout, Checkbox, Chip, Field, Input, Select, SelectItem, Surface, Switch } from "@vanr/ui";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useClock } from "../../../platform/clock.tsx";
import { useSession } from "../../../session/react.tsx";
import { useOutcome } from "../settings/shared.tsx";

/** Every kind of notice, in the order the table lists them. */
const KIND_ORDER = {
  approval: 1,
  question_for_you: 2,
  browser_intervention: 3,
  debate_turn: 4,
  debate_synthesis: 5,
  assignment_finished: 6,
  assignment_stopped: 7,
  dm: 8,
  mention: 9,
  thread_followup: 10,
  issue_ownership: 11,
  issue_discussion: 12,
  issue_progress: 13,
  routine_alert: 14,
  routine_report: 15,
  runner_connected: 16,
  reaction: 17,
} as const satisfies Record<NotificationKind, number>;
const KINDS = (Object.keys(KIND_ORDER) as NotificationKind[]).sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);

/** The kinds that usually wait for an answer: by default they are the only ones that send email. */
const WAITING_KINDS: ReadonlySet<NotificationKind> = new Set([
  "approval",
  "question_for_you",
  "browser_intervention",
  "debate_turn",
]);
const EMAIL_DELAYS = [0, 5, 15, 60] as const;
const MAX_RULES = 50;
const ANY = "*";
const TABS: readonly NotificationTab[] = ["action_needed", "fyi"];

export function PreferencesScreen() {
  const t = useMessages("inbox");
  const shell = useMessages("shell");
  const { workspaceId } = useRouteParams("notificationSettings");
  const saved = useApiQuery("getNotificationSettings", { workspaceId });
  useDocumentTitle(shell("route.notificationSettings"));
  if (saved.isPending) return <ScreenLoading />;
  if (saved.isError) {
    return (
      <ScreenError
        title={t("prefs.failed")}
        error={saved.error}
        onRetry={() => void saved.refetch()}
        namespace="inbox"
      />
    );
  }
  return <PreferencesForm workspaceId={workspaceId} saved={saved.data} />;
}

function PreferencesForm({ workspaceId, saved }: { workspaceId: string; saved: NotificationSettings }) {
  const t = useMessages("inbox");
  const shell = useMessages("shell");
  const common = useMessages("common");
  const { locale } = useLocale();
  const clock = useClock();
  const outcome = useOutcome("inbox");
  const describe = useErrorMessage("inbox");
  const { me } = useSession();
  const channels = useApiQuery("listChannels", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  const people = useApiQuery("getPeople", { workspaceId });
  const workspace = useApiQuery("getSettings", { workspaceId });
  const [draft, setDraft] = useState<NotificationSettings | null>(null);
  const invalidates = () => [{ method: "getNotificationSettings" as const, args: { workspaceId } }];
  const save = useApiMutation("setNotificationSettings", { invalidates });
  const quiet = useApiMutation("setNotificationSettings", { invalidates });

  // The last settings the server confirmed: a refetch, or the answer of this page's own save.
  // Do not disturb sends these with its one change, so it never writes back a field it did not touch.
  const confirmed = useRef(saved);
  useEffect(() => {
    confirmed.current = saved;
  }, [saved]);
  const busy = save.isPending || quiet.isPending;

  const s = draft ?? saved;
  const set = (patch: Partial<NotificationSettings>) => setDraft({ ...s, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  // The server reads quiet hours in the person's own time zone here, else the workspace's.
  const timezone =
    people.data?.find((person) => person.userId === me?.user.id)?.timezone ?? workspace.data?.timezone;
  const memberOf = (channels.data ?? []).filter((channel) => channel.isMember);
  const failedList = (title: string, retry: () => void) => (
    <Callout
      tone="danger"
      role="alert"
      title={title}
      actions={
        <Button size="sm" onClick={retry}>
          {common("action.retry")}
        </Button>
      }
    />
  );
  const channelsFailed =
    channels.isError && failedList(t("prefs.channelsFailed"), () => void channels.refetch());
  const channelName = (id: string) => {
    const found = channels.data?.find((channel) => channel.id === id);
    return found === undefined ? id : `#${found.name}`;
  };
  const muted = Object.entries(s.channels)
    .filter(([, toggle]) => toggle.push === false && toggle.email === false)
    .map(([id]) => id);
  const effective = (kind: NotificationKind, channel: "push" | "email") =>
    s.kinds[kind]?.[channel] ?? (channel === "push" ? true : WAITING_KINDS.has(kind));
  const setRule = (index: number, patch: Partial<NotificationRule>) =>
    set({ rules: s.rules.map((rule, at) => (at === index ? withRule(rule, patch) : rule)) });
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(
      new Date(iso),
    );
  const dndOn = s.dndUntil !== null && Date.parse(s.dndUntil) > clock.now();

  /** Do not disturb saves at once, alone: the rest of the draft stays a draft. */
  const setDnd = (until: Date | null) => {
    const dndUntil = until === null ? null : until.toISOString();
    quiet.mutate(
      { workspaceId, body: { ...confirmed.current, dndUntil } },
      {
        onSuccess: (next) => {
          confirmed.current = next;
          setDraft((current) => (current === null ? null : { ...current, dndUntil: next.dndUntil }));
          outcome.done(
            until === null ? t("prefs.dndOffDone") : t("prefs.dndOnDone", { time: time(dndUntil ?? "") }),
          );
        },
        onError: outcome.failed,
      },
    );
  };
  const morning = new Date(clock.now());
  morning.setDate(morning.getDate() + 1);
  morning.setHours(8, 0, 0, 0);

  return (
    <div className="page page--wide prefs">
      <header className="inbox__head">
        <div>
          <h1 className="page__title">{shell("route.notificationSettings")}</h1>
          <p className="page__muted">{t("prefs.lead")}</p>
        </div>
        <AppLink className="app-link" route="notifications" params={{ workspaceId }}>
          {t("prefs.back")}
        </AppLink>
      </header>

      <Surface variant="card" as="section" className="section-card" aria-labelledby="prefs-delivery">
        <h2 className="page__heading" id="prefs-delivery">
          {t("prefs.delivery")}
        </h2>
        <Switch
          label={t("prefs.push")}
          hint={t("prefs.pushHint")}
          checked={s.push}
          onCheckedChange={(push) => set({ push })}
        />
        <Switch
          label={t("prefs.email")}
          hint={t("prefs.emailHint")}
          checked={s.email}
          onCheckedChange={(email) => set({ email })}
        />
        <Field label={t("prefs.emailDelay")} disabled={!s.email}>
          <Select
            value={String(s.emailDelayMinutes)}
            onValueChange={(value) => set({ emailDelayMinutes: Number(value) })}
          >
            {[...new Set([...EMAIL_DELAYS, s.emailDelayMinutes])]
              .sort((a, b) => a - b)
              .map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {minutes === 0 ? t("prefs.emailNow") : t("prefs.emailAfter", { count: minutes })}
                </SelectItem>
              ))}
          </Select>
        </Field>
      </Surface>

      <Surface variant="card" as="section" className="section-card" aria-labelledby="prefs-quiet">
        <h2 className="page__heading" id="prefs-quiet">
          {t("prefs.quiet")}
        </h2>
        <fieldset className="prefs__row prefs__dnd">
          <legend className="prefs__label">{t("prefs.dnd")}</legend>
          <span className="page__muted" role="status">
            {dndOn && s.dndUntil !== null
              ? t("prefs.dndUntil", { time: time(s.dndUntil) })
              : t("prefs.dndOff")}
          </span>
          <Button
            size="sm"
            loading={quiet.isPending}
            disabled={save.isPending}
            onClick={() => setDnd(new Date(clock.now() + 3_600_000))}
          >
            {t("prefs.dndHour")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setDnd(morning)}>
            {t("prefs.dndMorning")}
          </Button>
          {dndOn && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDnd(null)}>
              {t("prefs.dndStop")}
            </Button>
          )}
        </fieldset>
        <Switch
          label={t("prefs.quietHours")}
          hint={timezone === undefined ? undefined : t("prefs.quietTimezone", { timezone })}
          checked={s.quietHours.enabled}
          onCheckedChange={(enabled) => set({ quietHours: { ...s.quietHours, enabled } })}
        />
        <div className="prefs__row">
          <Field label={t("prefs.quietFrom")} disabled={!s.quietHours.enabled}>
            <Input
              type="time"
              value={s.quietHours.start}
              onChange={(event) =>
                set({ quietHours: { ...s.quietHours, start: event.target.value || s.quietHours.start } })
              }
            />
          </Field>
          <Field label={t("prefs.quietTo")} disabled={!s.quietHours.enabled}>
            <Input
              type="time"
              value={s.quietHours.end}
              onChange={(event) =>
                set({ quietHours: { ...s.quietHours, end: event.target.value || s.quietHours.end } })
              }
            />
          </Field>
        </div>
        <p className="page__muted">{t("prefs.critical")}</p>
      </Surface>

      <Surface variant="card" as="section" className="section-card" aria-labelledby="prefs-kinds">
        <h2 className="page__heading" id="prefs-kinds">
          {t("prefs.kinds")}
        </h2>
        <p className="page__muted">{t("prefs.kindsHint")}</p>
        <div className="prefs__table-wrap">
          <table className="prefs__table">
            <thead>
              <tr>
                <th scope="col">{t("prefs.kind")}</th>
                <th scope="col">{t("prefs.byPush")}</th>
                <th scope="col">{t("prefs.byEmail")}</th>
              </tr>
            </thead>
            <tbody>
              {KINDS.map((kind) => (
                <tr key={kind}>
                  <th scope="row">{t(`kindName.${kind}`)}</th>
                  {(["push", "email"] as const).map((channel) => (
                    <td key={channel}>
                      <Checkbox
                        label={
                          <span className="vr-visually-hidden">
                            {t(`prefs.${channel}Of`, { kind: t(`kindName.${kind}`) })}
                          </span>
                        }
                        checked={effective(kind, channel)}
                        disabled={!s[channel]}
                        onCheckedChange={(checked) =>
                          set({
                            kinds: { ...s.kinds, [kind]: { ...s.kinds[kind], [channel]: checked === true } },
                          })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>

      <Surface variant="card" as="section" className="section-card" aria-labelledby="prefs-muted">
        <h2 className="page__heading" id="prefs-muted">
          {t("prefs.muted")}
        </h2>
        <p className="page__muted">{t("prefs.mutedHint")}</p>
        {muted.length === 0 ? (
          <p className="page__muted">{t("prefs.mutedNone")}</p>
        ) : (
          <ul className="prefs__chips" aria-label={t("prefs.muted")}>
            {muted.map((id) => (
              <li key={id}>
                <Chip
                  onRemove={() => {
                    const { [id]: _unmuted, ...rest } = s.channels;
                    set({ channels: rest });
                  }}
                  removeLabel={t("prefs.unmute", { channel: channelName(id) })}
                >
                  {channelName(id)}
                </Chip>
              </li>
            ))}
          </ul>
        )}
        {channelsFailed}
        <Field label={t("prefs.mute")}>
          <Select
            value=""
            placeholder={t("prefs.mutePick")}
            disabled={memberOf.every((channel) => muted.includes(channel.id))}
            onValueChange={(id) => set({ channels: { ...s.channels, [id]: { push: false, email: false } } })}
          >
            {memberOf
              .filter((channel) => !muted.includes(channel.id))
              .map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  #{channel.name}
                </SelectItem>
              ))}
          </Select>
        </Field>
      </Surface>

      <Surface variant="card" as="section" className="section-card" aria-labelledby="prefs-rules">
        <h2 className="page__heading" id="prefs-rules">
          {t("prefs.rules")}
        </h2>
        <p className="page__muted">{t("prefs.rulesHint")}</p>
        {channelsFailed}
        {agents.isError && failedList(t("prefs.agentsFailed"), () => void agents.refetch())}
        {s.rules.length === 0 ? (
          <p className="page__muted">{t("prefs.rulesNone")}</p>
        ) : (
          <ol className="prefs__rules" aria-label={t("prefs.rules")}>
            {s.rules.map((rule, index) => (
              <li key={rule.id} className="prefs__rule">
                <Select
                  size="sm"
                  aria-label={t("prefs.ruleKind", { n: index + 1 })}
                  value={rule.kind ?? ANY}
                  onValueChange={(value) => setRule(index, { kind: KINDS.find((kind) => kind === value) })}
                >
                  <SelectItem value={ANY}>{t("prefs.anyKind")}</SelectItem>
                  {KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`kindName.${kind}`)}
                    </SelectItem>
                  ))}
                </Select>
                <Select
                  size="sm"
                  aria-label={t("prefs.ruleChannel", { n: index + 1 })}
                  value={rule.channelId ?? ANY}
                  onValueChange={(value) => setRule(index, { channelId: value === ANY ? undefined : value })}
                >
                  <SelectItem value={ANY}>{t("prefs.anyChannel")}</SelectItem>
                  {memberOf.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </Select>
                <Select
                  size="sm"
                  aria-label={t("prefs.ruleAgent", { n: index + 1 })}
                  value={rule.agentId ?? ANY}
                  onValueChange={(value) => setRule(index, { agentId: value === ANY ? undefined : value })}
                >
                  <SelectItem value={ANY}>{t("prefs.anyAgent")}</SelectItem>
                  {(agents.data ?? [])
                    .filter((agent) => agent.archivedAt === null)
                    .map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                </Select>
                <span className="prefs__arrow">{t("prefs.goesTo")}</span>
                <Select
                  size="sm"
                  aria-label={t("prefs.ruleTab", { n: index + 1 })}
                  value={rule.tab}
                  onValueChange={(value) =>
                    setRule(index, { tab: TABS.find((tab) => tab === value) ?? rule.tab })
                  }
                >
                  {TABS.map((tab) => (
                    <SelectItem key={tab} value={tab}>
                      {t(`tab.${tab}`)}
                    </SelectItem>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  aria-label={t("prefs.ruleRemove", { n: index + 1 })}
                  onClick={() => set({ rules: s.rules.filter((_, at) => at !== index) })}
                />
              </li>
            ))}
          </ol>
        )}
        <div>
          <Button
            size="sm"
            icon={<Plus aria-hidden="true" />}
            disabled={s.rules.length >= MAX_RULES}
            onClick={() => set({ rules: [...s.rules, { id: crypto.randomUUID().slice(0, 12), tab: "fyi" }] })}
          >
            {t("prefs.ruleAdd")}
          </Button>
          {s.rules.length >= MAX_RULES && (
            <p className="page__muted">{t("prefs.rulesFull", { max: MAX_RULES })}</p>
          )}
        </div>
      </Surface>

      {save.isError && (
        <Callout tone="danger" role="alert" title={t("prefs.saveFailed")}>
          {describe(save.error)}
        </Callout>
      )}
      <div className="prefs__save">
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(null)}>
            {t("prefs.discard")}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!dirty || quiet.isPending}
          loading={save.isPending}
          onClick={() => {
            const sent = draft;
            save.mutate(
              // The emails follow the interface language.
              { workspaceId, body: { ...s, locale } },
              {
                onSuccess: (next) => {
                  confirmed.current = next;
                  // An edit made while this was saving stays a draft.
                  setDraft((current) => (current === sent ? null : current));
                  outcome.done(t("prefs.saved"));
                },
              },
            );
          }}
        >
          {t("prefs.save")}
        </Button>
      </div>
    </div>
  );
}

/** A rule with the patch applied; a field set back to "any" is dropped rather than kept undefined. */
function withRule(rule: NotificationRule, patch: Partial<NotificationRule>): NotificationRule {
  const next: NotificationRule = { ...rule, ...patch };
  for (const key of ["kind", "channelId", "agentId"] as const) if (next[key] === undefined) delete next[key];
  return next;
}

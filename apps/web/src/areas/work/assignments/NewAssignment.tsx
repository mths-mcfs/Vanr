// A new assignment: its goal, an optional title, the agent (only one that can take an assignment now),
// the channel it lives in, who does the work and how commands on the runner are approved. It opens on
// its own page, not started: the agent drafts a plan and the owner starts it.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AssignmentExecutor, Channel, CommandPolicy } from "@vanr/contract";
import { Button, Callout, Dialog, DialogContent, Field, Input, Select, SelectItem, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useGo } from "../../../app/navigation.tsx";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { type Actors, useOutcome } from "../issues/shared.tsx";
import { PartError, PartLoading } from "../parts.tsx";
import { ASSIGNMENT_TITLE_MAX, GOAL_MAX } from "./shared.tsx";

const POLICIES = ["when_safe", "always", "never"] as const satisfies readonly CommandPolicy[];

export function NewAssignmentDialog({
  workspaceId,
  actors,
  channels,
  onClose,
}: {
  workspaceId: string;
  actors: Actors;
  channels: Channel[];
  onClose: () => void;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const describe = useErrorMessage("work");
  const outcome = useOutcome();
  const go = useGo();
  const eligible = useApiQuery("listAssignmentEligibleAgents", { workspaceId });
  const qualified = (eligible.data ?? []).filter((agent) => agent.qualifies);
  const writable = channels.filter((channel) => channel.isMember);
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [chosenAgent, setAgentId] = useState("");
  const [channelId, setChannelId] = useState(
    writable.find((channel) => channel.isGeneral)?.id ?? writable[0]?.id ?? "",
  );
  const [chosenExecutor, setExecutor] = useState<AssignmentExecutor | "">("");
  const [policy, setPolicy] = useState<CommandPolicy>("when_safe");
  const agentId = chosenAgent === "" ? (qualified[0]?.agentId ?? "") : chosenAgent;
  const executors = qualified.find((agent) => agent.agentId === agentId)?.executors ?? [];
  const executor =
    chosenExecutor !== "" && executors.includes(chosenExecutor) ? chosenExecutor : executors[0];
  const create = useApiMutation("createAssignment", {
    invalidates: () => [{ method: "listAssignments", args: { workspaceId } }],
  });
  const ready = goal.trim() !== "" && agentId !== "" && channelId !== "" && !create.isPending;

  const submit = () => {
    if (!ready) return;
    create.mutate(
      {
        workspaceId,
        body: {
          goal: goal.trim(),
          agentId,
          channelId,
          commandPolicy: policy,
          ...(title.trim() !== "" && { title: title.trim() }),
          ...(executor !== undefined && { executor }),
        },
      },
      {
        onSuccess: (assignment) => {
          outcome.done(t("asg.form.created"));
          onClose();
          void go("assignment", { workspaceId, assignmentId: assignment.id });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="lg"
        title={t("asg.new")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="work-new-assignment"
              disabled={!ready}
              loading={create.isPending}
            >
              {t("asg.form.create")}
            </Button>
          </>
        }
      >
        {eligible.isPending ? (
          <PartLoading />
        ) : eligible.isError && eligible.data === undefined ? (
          <PartError
            title={t("asg.form.agentsFailed")}
            error={eligible.error}
            onRetry={() => void eligible.refetch()}
          />
        ) : qualified.length === 0 ? (
          <p className="work-note">{t("asg.form.noAgent")}</p>
        ) : (
          <form
            id="work-new-assignment"
            className="work-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Field label={t("asg.form.goal")} hint={t("asg.form.goalHint")} required>
              <Textarea
                rows={5}
                value={goal}
                maxLength={GOAL_MAX}
                autoFocus
                onChange={(event) => setGoal(event.target.value)}
              />
            </Field>
            <Field label={t("asg.form.title")} hint={t("asg.form.titleHint")}>
              <Input
                value={title}
                maxLength={ASSIGNMENT_TITLE_MAX}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <div className="work-form__row">
              <Field label={t("asg.form.agent")}>
                <Select value={agentId} onValueChange={setAgentId}>
                  {qualified.map((agent) => (
                    <SelectItem key={agent.agentId} value={agent.agentId}>
                      {actors.name({ type: "agent", id: agent.agentId })}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <Field label={t("asg.form.channel")}>
                <Select value={channelId} onValueChange={setChannelId}>
                  {writable.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="work-form__row">
              {executors.length > 1 && executor !== undefined && (
                <Field label={t("asg.form.executor")}>
                  <Select
                    value={executor}
                    onValueChange={(value) => setExecutor(executors.find((each) => each === value) ?? "")}
                  >
                    {executors.map((each) => (
                      <SelectItem key={each} value={each}>
                        {t(`asg.form.executor.${each}`)}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t("asg.form.policy")}>
                <Select
                  value={policy}
                  onValueChange={(value) => setPolicy(POLICIES.find((each) => each === value) ?? "when_safe")}
                >
                  {POLICIES.map((each) => (
                    <SelectItem key={each} value={each}>
                      {t(`asg.form.policy.${each}`)}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            </div>
            {create.isError && (
              <Callout tone="danger" role="alert">
                {describe(create.error)}
              </Callout>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

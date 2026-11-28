// The parts of an agent that both the creation and the profile's settings edit: its appearance and
// who may talk to it.
import type { AgentAppearance, AgentAudience, Member } from "@vanr/contract";
import { Button, Checkbox, Field, Radio, RadioGroup, Select, SelectItem } from "@vanr/ui";
import { Shuffle } from "lucide-react";
import { useLookup, useMessages } from "../../i18n/react.tsx";
import { ADORNMENTS, COLORS, EYES, randomAppearance } from "./shared.tsx";

export function AppearanceFields({
  value,
  onChange,
  disabled = false,
}: {
  value: AgentAppearance;
  onChange: (next: AgentAppearance) => void;
  disabled?: boolean;
}) {
  const t = useMessages("agents");
  const lookup = useLookup("agents");
  const part = (name: "color" | "eyes" | "adornment", options: readonly string[]) => (
    <Field label={t(`appearance.${name}`)}>
      <Select
        value={value[name]}
        disabled={disabled}
        onValueChange={(next) => onChange({ ...value, [name]: next })}
      >
        {/* A part saved elsewhere, outside these lists, stays choosable. */}
        {[...new Set([value[name], ...options])].map((option) => (
          <SelectItem key={option} value={option}>
            {lookup(`appearance.${name}.${option}`) ?? option}
          </SelectItem>
        ))}
      </Select>
    </Field>
  );
  return (
    <fieldset className="agent-fieldset">
      <legend className="page__heading">{t("appearance.title")}</legend>
      <div className="agent-appearance">
        {part("color", COLORS)}
        {part("eyes", EYES)}
        {part("adornment", ADORNMENTS)}
        <Button
          variant="secondary"
          icon={<Shuffle size={16} />}
          disabled={disabled}
          onClick={() => onChange({ ...value, ...randomAppearance() })}
        >
          {t("appearance.random")}
        </Button>
      </div>
    </fieldset>
  );
}

export function AudienceFields({
  value,
  onChange,
  people,
  disabled = false,
}: {
  value: AgentAudience;
  onChange: (next: AgentAudience) => void;
  people: readonly Member[];
  disabled?: boolean;
}) {
  const t = useMessages("agents");
  const missing = value.mode === "people" && value.userIds.length === 0;
  return (
    <fieldset className="agent-fieldset">
      <legend className="page__heading">{t("audience.title")}</legend>
      <RadioGroup
        value={value.mode}
        disabled={disabled}
        aria-label={t("audience.title")}
        onValueChange={(mode) =>
          onChange({
            mode: mode === "people" || mode === "owner" ? mode : "everyone",
            userIds: value.userIds,
          })
        }
      >
        <Radio value="everyone" label={t("audience.everyone")} />
        <Radio value="people" label={t("audience.people")} />
        <Radio value="owner" label={t("audience.owner")} />
      </RadioGroup>
      {value.mode === "people" && (
        <ul className="agent-picks" aria-label={t("audience.people")}>
          {people.map((person) => (
            <li key={person.userId}>
              <Checkbox
                label={person.name}
                disabled={disabled}
                checked={value.userIds.includes(person.userId)}
                onCheckedChange={(on) =>
                  onChange({
                    mode: "people",
                    userIds:
                      on === true
                        ? [...value.userIds, person.userId]
                        : value.userIds.filter((id) => id !== person.userId),
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
      {missing && (
        <p className="agent-error" role="alert">
          {t("audience.pickOne")}
        </p>
      )}
    </fieldset>
  );
}

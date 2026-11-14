import {
  AgentSigil,
  Avatar,
  Button,
  Callout,
  Checkbox,
  Chip,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Field,
  Icon,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Skeleton,
  Spinner,
  StatusBadge,
  Surface,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ToastProvider,
  type Tone,
  Tooltip,
  useToast,
  WORK_STATUSES,
  Wordmark,
} from "@vanr/ui";
import {
  Archive,
  Copy as CopyIcon,
  Ellipsis,
  Pencil,
  Pin,
  Plus,
  RotateCw,
  Search,
  Send,
  Trash,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type Copy, copy, type Locale } from "./copy/index.ts";

type Theme = "light" | "dark" | "system";
type Page = "components" | "states";

const TONES: Tone[] = ["info", "success", "warning", "danger"];

const AGENTS = [
  { id: "agt_01JD7Z3K9M", name: "Scout" },
  { id: "agt_01JD7Z4P2Q", name: "Ledger" },
  { id: "agt_01JD7Z5R8T", name: "Tally" },
  { id: "agt_01JD7Z6W1V", name: "Hearth" },
  { id: "agt_01JD7Z7B4X", name: "Fjell" },
];

const PEOPLE = ["Ana Beatriz Souza", "Jonas Lind", "Mei Okafor", "Íris Valença"];

function readPage(): Page {
  return window.location.hash === "#states" ? "states" : "components";
}

function readParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const value = readParam("theme");
    return value === "dark" || value === "system" ? value : "light";
  });
  const [locale, setLocale] = useState<Locale>(() => (readParam("lang") === "pt-BR" ? "pt-BR" : "en"));
  const [page, setPage] = useState<Page>(readPage);
  const t = copy[locale];

  // The theme lives on <html> so portalled overlays in <body> pick it up too.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const onHash = () => setPage(readPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <ToastProvider label={t.notifications.regionName} closeLabel={t.notifications.dismissButton}>
      <header className="g-bar">
        <div className="g-bar__brand">
          <Wordmark />
          <span className="g-bar__title">{t.chrome.kitName}</span>
        </div>
        <nav className="g-bar__nav" aria-label={t.chrome.kitName}>
          <a href="#components" aria-current={page === "components" ? "page" : undefined}>
            {t.chrome.pageNames.components}
          </a>
          <a href="#states" aria-current={page === "states" ? "page" : undefined}>
            {t.chrome.pageNames.states}
          </a>
        </nav>
        <div className="g-bar__controls">
          <Select
            size="sm"
            aria-label={t.chrome.themePicker.label}
            value={theme}
            onValueChange={(value) => setTheme(value as Theme)}
          >
            <SelectItem value="light">{t.chrome.themePicker.birch}</SelectItem>
            <SelectItem value="dark">{t.chrome.themePicker.tar}</SelectItem>
            <SelectItem value="system">{t.chrome.themePicker.followOs}</SelectItem>
          </Select>
          <Select
            size="sm"
            aria-label={t.chrome.languagePicker}
            value={locale}
            onValueChange={(value) => setLocale(value as Locale)}
          >
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="pt-BR">Português (Brasil)</SelectItem>
          </Select>
        </div>
      </header>
      <main className="g-main">
        {page === "components" ? <ComponentsPage t={t} /> : <StatesPage t={t} />}
      </main>
    </ToastProvider>
  );
}

function Section({ id, t, children }: { id: keyof Copy["sectionHeads"]; t: Copy; children: ReactNode }) {
  const section = t.sectionHeads[id];
  return (
    <section className="g-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="g-section__head">
        <h2 id={`${id}-title`}>{section.title}</h2>
        <p>{section.note}</p>
      </div>
      <div className="g-section__body">{children}</div>
    </section>
  );
}

function ComponentsPage({ t }: { t: Copy }) {
  return (
    <>
      <div className="g-intro">
        <h1>{t.chrome.pageNames.components}</h1>
        <p>{t.chrome.pageIntro}</p>
      </div>
      <TypeSection t={t} />
      <ButtonsSection t={t} />
      <FieldsSection t={t} />
      <ChoicesSection t={t} />
      <OverlaysSection t={t} />
      <TabsSection t={t} />
      <FeedbackSection t={t} />
      <IdentitySection t={t} />
      <StatusSection t={t} />
      <SurfacesSection t={t} />
      <LoadingSection t={t} />
      <EmptySection t={t} />
    </>
  );
}

function TypeSection({ t }: { t: Copy }) {
  return (
    <Section id="type" t={t}>
      <div className="g-type">
        <p className="g-type__title">{t.typeSpecimen.headline}</p>
        <p className="g-type__lead">{t.typeSpecimen.paragraph}</p>
        <p>{t.typeSpecimen.paragraph}</p>
        <p className="g-type__small">{t.typeSpecimen.paragraph}</p>
        <code className="g-type__mono">{t.typeSpecimen.logLine}</code>
      </div>
    </Section>
  );
}

function ButtonsSection({ t }: { t: Copy }) {
  return (
    <Section id="buttons" t={t}>
      <div className="g-row">
        <Button variant="primary" icon={<Icon icon={Send} />}>
          {t.buttonLabels.sendMessage}
        </Button>
        <Button>{t.buttonLabels.cancel}</Button>
        <Button variant="ghost" icon={<Icon icon={Archive} />}>
          {t.buttonLabels.archiveThread}
        </Button>
        <Button variant="danger" icon={<Icon icon={Trash} />}>
          {t.buttonLabels.deleteRoutine}
        </Button>
      </div>
      <div className="g-row">
        <Button variant="primary" size="sm">
          {t.buttonLabels.approveRequest}
        </Button>
        <Button variant="primary">{t.buttonLabels.approveRequest}</Button>
        <Button variant="primary" size="lg">
          {t.buttonLabels.approveRequest}
        </Button>
        <Button variant="secondary" loading>
          {t.buttonLabels.saveEdits}
        </Button>
        <Button variant="primary" disabled>
          {t.buttonLabels.saveEdits}
        </Button>
      </div>
      <div className="g-row">
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon icon={Ellipsis} />}
          aria-label={t.buttonLabels.overflowMenuName}
        />
        <Button icon={<Icon icon={Search} />} aria-label={t.buttonLabels.searchIconName} />
        <Button
          size="lg"
          variant="primary"
          icon={<Icon icon={Plus} />}
          aria-label={t.buttonLabels.createTask}
        />
        <span className="g-hint">
          <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
        </span>
      </div>
    </Section>
  );
}

function FieldsSection({ t }: { t: Copy }) {
  return (
    <Section id="fields" t={t}>
      <div className="g-grid">
        <Field
          label={t.agentForm.nameLabel}
          hint={t.agentForm.nameShownInChat}
          required
          requiredLabel={t.agentForm.requiredMark}
        >
          <Input placeholder={t.agentForm.nameExample} />
        </Field>
        <Field label={t.agentForm.modelPickerLabel}>
          <Select placeholder={t.agentForm.modelPrompt}>
            <SelectItem value="haiku">claude-haiku-5-5</SelectItem>
            <SelectItem value="opus">claude-opus-5-5</SelectItem>
            <SelectItem value="local" disabled>
              local-runner
            </SelectItem>
          </Select>
        </Field>
        <Field label={t.agentForm.promptLabel} error={t.agentForm.promptMissing}>
          <Textarea placeholder={t.agentForm.promptExample} />
        </Field>
        <Field label={t.agentForm.idLabel} disabled>
          <Input mono defaultValue="agt_01JD7Z3K9M" />
        </Field>
        <Field label={t.agentForm.digestChannelLabel} error={t.agentForm.digestChannelGone}>
          <Input defaultValue="#resumo-semanal-antigo" />
        </Field>
      </div>
    </Section>
  );
}

function ChoicesSection({ t }: { t: Copy }) {
  return (
    <Section id="choices" t={t}>
      <div className="g-grid">
        <div className="g-stack">
          <Checkbox
            label={t.agentSettings.notifyWhenDone}
            hint={t.agentSettings.notifyWhenDoneHelp}
            defaultChecked
          />
          <Checkbox label={t.agentSettings.shelvedRoutinesOption} checked="indeterminate" />
          <Checkbox label={t.agentSettings.shelvedRoutinesOption} disabled />
          <Switch
            label={t.agentSettings.approveEditsAlone}
            hint={t.agentSettings.approveEditsAloneHelp}
            defaultChecked
          />
          <Switch label={t.agentSettings.notifyWhenDone} />
          <Switch label={t.agentSettings.notifyWhenDone} disabled defaultChecked />
        </div>
        <Field label={t.agentSettings.runCadence}>
          <RadioGroup defaultValue="daily">
            <Radio value="hourly" label={t.agentSettings.everyHourOption} />
            <Radio value="daily" label={t.agentSettings.everyMorningOption} />
            <Radio value="manual" label={t.agentSettings.byHandOption} disabled />
          </RadioGroup>
        </Field>
      </div>
    </Section>
  );
}

function ThreadMenuItems({ t }: { t: Copy }) {
  return (
    <>
      <MenuLabel>{t.threadMenu.groupName}</MenuLabel>
      <MenuItem icon={<Icon icon={Pencil} />} shortcut={<Kbd>F2</Kbd>}>
        {t.threadMenu.renameThread}
      </MenuItem>
      <MenuItem icon={<Icon icon={CopyIcon} />}>{t.threadMenu.duplicateThread}</MenuItem>
      <MenuItem icon={<Icon icon={Pin} />} disabled>
        {t.threadMenu.pinThread}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Icon icon={Trash} />} tone="danger">
        {t.threadMenu.deleteThread}
      </MenuItem>
    </>
  );
}

function OverlaysSection({ t }: { t: Copy }) {
  const [all, setAll] = useState(() => readParam("overlays") === "open");
  const [confirming, setConfirming] = useState(false);
  return (
    <Section id="overlays" t={t}>
      <div className="g-row">
        <Dialog>
          <DialogTrigger asChild>
            <Button icon={<Icon icon={Pencil} />}>{t.renameDialog.trigger}</Button>
          </DialogTrigger>
          <DialogContent
            title={t.renameDialog.heading}
            description={t.renameDialog.explanation}
            closeLabel={t.renameDialog.closeButton}
            footer={
              <>
                <DialogClose asChild>
                  <Button>{t.buttonLabels.cancel}</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="primary">{t.buttonLabels.saveEdits}</Button>
                </DialogClose>
              </>
            }
          >
            <Field label={t.agentForm.nameLabel} hint={t.agentForm.nameShownInChat}>
              <Input defaultValue="Scout" />
            </Field>
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          trigger={
            <Button variant="danger" icon={<Icon icon={Trash} />}>
              {t.deleteDialog.trigger}
            </Button>
          }
          tone="danger"
          title={t.deleteDialog.question}
          description={t.deleteDialog.consequence}
          confirmLabel={t.deleteDialog.confirmButton}
          cancelLabel={t.buttonLabels.cancel}
          confirming={confirming}
          onConfirm={() => setConfirming(true)}
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
        />
        <Menu modal={!all} {...(all && { open: true })}>
          <MenuTrigger asChild>
            <Button icon={<Icon icon={Ellipsis} />}>{t.threadMenu.trigger}</Button>
          </MenuTrigger>
          <MenuContent>
            <ThreadMenuItems t={t} />
          </MenuContent>
        </Menu>
        <Tooltip content={t.copyIdTooltip.hint} {...(all && { open: true })} side="bottom">
          <Button variant="ghost" icon={<Icon icon={CopyIcon} />} aria-label={t.copyIdTooltip.buttonName} />
        </Tooltip>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="g-context">{t.threadMenu.rightClickTarget}</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon={<Icon icon={Pencil} />}>{t.threadMenu.renameThread}</ContextMenuItem>
          <ContextMenuItem icon={<Icon icon={CopyIcon} />}>{t.threadMenu.duplicateThread}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon={<Icon icon={Trash} />} tone="danger">
            {t.threadMenu.deleteThread}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Switch label={t.threadMenu.openEveryOverlay} checked={all} onCheckedChange={setAll} />
    </Section>
  );
}

function TabsSection({ t }: { t: Copy }) {
  const tabs = ["chat", "tasks", "schedules", "knowledgeBase"] as const;
  return (
    <Section id="tabs" t={t}>
      <Tabs defaultValue="chat">
        <TabsList aria-label={t.sectionHeads.tabs.title}>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab} disabled={tab === "knowledgeBase"}>
              {t.workspaceTabs.labels[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent key={tab} value={tab}>
            {t.workspaceTabs.panels[tab]}
          </TabsContent>
        ))}
      </Tabs>
    </Section>
  );
}

function FeedbackSection({ t }: { t: Copy }) {
  const toast = useToast();
  const show = (tone: Tone) =>
    toast.push({
      tone,
      ...t.notifications.samples[tone],
      ...(tone === "success" && {
        action: {
          label: t.notifications.undoButton,
          altText: t.notifications.undoExplanation,
          onAction: () => undefined,
        },
      }),
    });
  return (
    <Section id="feedback" t={t}>
      <div className="g-stack">
        {TONES.map((tone) => (
          <Callout
            key={tone}
            tone={tone}
            title={t.noticeSamples[tone].title}
            {...(tone === "danger" && {
              actions: (
                <Button size="sm" icon={<Icon icon={RotateCw} />}>
                  {t.buttonLabels.retryRun}
                </Button>
              ),
            })}
          >
            {t.noticeSamples[tone].body}
          </Callout>
        ))}
      </div>
      <div className="g-row">
        {TONES.map((tone) => (
          <Button key={tone} size="sm" onClick={() => show(tone)}>
            {t.notifications.showPrefix}: {t.notifications.samples[tone].title}
          </Button>
        ))}
        <Button size="sm" variant="primary" onClick={() => TONES.forEach(show)}>
          {t.notifications.queueFour}
        </Button>
      </div>
    </Section>
  );
}

function IdentitySection({ t }: { t: Copy }) {
  return (
    <Section id="identity" t={t}>
      <div className="g-row">
        {PEOPLE.map((name) => (
          <span key={name} className="g-identity">
            <Avatar name={name} />
            {name}
          </span>
        ))}
      </div>
      <div className="g-row">
        {AGENTS.map((agent) => (
          <span key={agent.id} className="g-identity">
            <AgentSigil agentId={agent.id} name={agent.name} />
            {agent.name}
            <code>{agent.id}</code>
          </span>
        ))}
      </div>
      <div className="g-row">
        <Avatar name={PEOPLE[0] ?? ""} size="sm" />
        <Avatar name={PEOPLE[0] ?? ""} />
        <Avatar name={PEOPLE[0] ?? ""} size="lg" />
        <AgentSigil agentId="agt_01JD7Z3K9M" name="Scout" size="sm" />
        <AgentSigil agentId="agt_01JD7Z3K9M" name="Scout" />
        <AgentSigil agentId="agt_01JD7Z3K9M" name="Scout" size="lg" />
      </div>
      <div className="g-row">
        <Wordmark size="sm" />
        <Wordmark />
        <Wordmark size="lg" />
        <Wordmark variant="mark" size="lg" />
      </div>
    </Section>
  );
}

function StatusSection({ t }: { t: Copy }) {
  const [selected, setSelected] = useState<Record<string, boolean>>({ assignedToMe: true });
  const [chips, setChips] = useState([
    t.filterTags.designTopic,
    t.filterTags.highPriority,
    t.filterTags.longCustomerTopic,
  ]);
  useEffect(
    () => setChips([t.filterTags.designTopic, t.filterTags.highPriority, t.filterTags.longCustomerTopic]),
    [t],
  );
  return (
    <Section id="status" t={t}>
      <div className="g-row">
        {WORK_STATUSES.map((status) => (
          <StatusBadge key={status} status={status} label={t.statusLabels[status]} />
        ))}
      </div>
      <div className="g-row">
        {(["assignedToMe", "highPriority"] as const).map((key) => (
          <Chip
            key={key}
            selected={selected[key] ?? false}
            onSelectedChange={(value) => setSelected((s) => ({ ...s, [key]: value }))}
          >
            {t.filterTags[key]}
          </Chip>
        ))}
        {chips.map((label) => (
          <Chip
            key={label}
            icon={<Icon icon={Workflow} size="sm" />}
            onRemove={() => setChips((c) => c.filter((x) => x !== label))}
            removeLabel={t.filterTags.removeButtonName(label)}
          >
            {label}
          </Chip>
        ))}
      </div>
    </Section>
  );
}

function SurfacesSection({ t }: { t: Copy }) {
  return (
    <Section id="surfaces" t={t}>
      <div className="g-grid">
        <Surface variant="card" as="article">
          <div className="g-card-head">
            <AgentSigil agentId="agt_01JD7Z5R8T" name="Tally" size="sm" />
            <strong>{t.surfaceSamples.digestName}</strong>
            <StatusBadge status="running" label={t.statusLabels.running} />
          </div>
          <p className="g-muted">{t.surfaceSamples.digestCadence}</p>
        </Surface>
        <Surface variant="panel">
          <p className="g-panel-title">{t.surfaceSamples.runLogHeading}</p>
          <pre className="g-log">
            {
              "09:14:02  fetch  github.com/vanr/issues\n09:14:03  parse  38 issues\n09:14:04  write  tasks 12 new"
            }
          </pre>
        </Surface>
      </div>
      <ul className="g-list">
        {t.surfaceSamples.taskTitles.map((row, index) => (
          <Surface key={row} variant="row" as="li" interactive selected={index === 1}>
            <AgentSigil agentId={AGENTS[index]?.id ?? "agt"} name={AGENTS[index]?.name ?? ""} size="sm" />
            <span className="g-grow">{row}</span>
            <StatusBadge
              status={(["done", "awaiting-approval", "paused"] as const)[index] ?? "done"}
              label={t.statusLabels[(["done", "awaiting-approval", "paused"] as const)[index] ?? "done"]}
            />
          </Surface>
        ))}
      </ul>
    </Section>
  );
}

function LoadingSection({ t }: { t: Copy }) {
  return (
    <Section id="loading" t={t}>
      <div className="g-row">
        <Spinner size="sm" />
        <Spinner />
        <Spinner size="lg" label={t.loadingSample.threadsLoading} />
      </div>
      <div className="g-skeleton" aria-busy="true">
        <span className="vr-visually-hidden">{t.loadingSample.threadsLoading}</span>
        <Skeleton shape="circle" />
        <div className="g-stack g-grow">
          <Skeleton style={{ width: "40%" }} />
          <Skeleton />
          <Skeleton style={{ width: "75%" }} />
        </div>
      </div>
    </Section>
  );
}

function EmptySection({ t }: { t: Copy }) {
  return (
    <Section id="empty" t={t}>
      <EmptyState
        icon={<Icon icon={Workflow} size="lg" />}
        title={t.emptyRoutines.heading}
        description={t.emptyRoutines.explanation}
        action={
          <Button variant="primary" icon={<Icon icon={Plus} />}>
            {t.emptyRoutines.createButton}
          </Button>
        }
      />
    </Section>
  );
}

/* States page: one row per control, one column per state, all drawn by the package's own CSS. */

type Column = keyof Copy["stateMatrix"]["columnNames"];
const COLUMNS: Column[] = ["default", "hover", "focus", "active", "disabled", "loading", "error"];

type Row = { name: string; render: (state: Column) => ReactNode | null };

function pointer(state: Column): { "data-gallery-state"?: string } {
  return state === "hover" || state === "focus" || state === "active" ? { "data-gallery-state": state } : {};
}

function StatesPage({ t }: { t: Copy }) {
  const buttonRow = (variant: "primary" | "secondary" | "ghost" | "danger"): Row => ({
    name: `Button ${variant}`,
    render: (state) =>
      state === "error" ? null : (
        <Button
          variant={variant}
          {...pointer(state)}
          disabled={state === "disabled"}
          loading={state === "loading"}
        >
          {t.buttonLabels.saveEdits}
        </Button>
      ),
  });

  const rows: Row[] = [
    buttonRow("primary"),
    buttonRow("secondary"),
    buttonRow("ghost"),
    buttonRow("danger"),
    {
      name: "Button icon",
      render: (state) =>
        state === "error" ? null : (
          <Button
            icon={<Icon icon={Search} />}
            aria-label={t.buttonLabels.searchIconName}
            {...pointer(state)}
            disabled={state === "disabled"}
            loading={state === "loading"}
          />
        ),
    },
    {
      name: "Input",
      render: (state) =>
        state === "loading" || state === "active" ? null : (
          <Input
            aria-label={t.agentForm.nameLabel}
            placeholder={t.agentForm.nameExample}
            {...pointer(state)}
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          />
        ),
    },
    {
      name: "Textarea",
      render: (state) =>
        state === "loading" || state === "active" ? null : (
          <Textarea
            aria-label={t.agentForm.promptLabel}
            rows={2}
            defaultValue={t.typeSpecimen.paragraph}
            {...pointer(state)}
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          />
        ),
    },
    {
      name: "Select",
      render: (state) =>
        state === "loading" || state === "active" ? null : (
          <Select
            aria-label={t.agentForm.modelPickerLabel}
            placeholder={t.agentForm.modelPrompt}
            {...pointer(state)}
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          >
            <SelectItem value="haiku">claude-haiku-5-5</SelectItem>
          </Select>
        ),
    },
    ...([false, true] as const).map(
      (checked): Row => ({
        name: checked ? "Checkbox checked" : "Checkbox unchecked",
        render: (state) =>
          state === "loading" || state === "active" ? null : (
            <Checkbox
              label={t.agentSettings.notifyWhenDone}
              defaultChecked={checked}
              {...pointer(state)}
              disabled={state === "disabled"}
              aria-invalid={state === "error" || undefined}
            />
          ),
      }),
    ),
    ...([false, true] as const).map(
      (checked): Row => ({
        name: checked ? "Switch on" : "Switch off",
        render: (state) =>
          state === "loading" || state === "active" || state === "error" ? null : (
            <Switch
              label={t.agentSettings.notifyWhenDone}
              defaultChecked={checked}
              {...pointer(state)}
              disabled={state === "disabled"}
            />
          ),
      }),
    ),
    {
      name: "Radio",
      render: (state) =>
        state === "loading" || state === "active" ? null : (
          <RadioGroup
            aria-label={t.agentSettings.runCadence}
            defaultValue="daily"
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          >
            <Radio value="daily" label={t.agentSettings.everyMorningOption} {...pointer(state)} />
          </RadioGroup>
        ),
    },
    {
      name: "Chip",
      render: (state) =>
        state === "loading" || state === "error" ? null : (
          <Chip
            selected={false}
            onSelectedChange={() => undefined}
            {...pointer(state)}
            disabled={state === "disabled"}
          >
            {t.filterTags.assignedToMe}
          </Chip>
        ),
    },
    {
      name: "Chip selected",
      render: (state) =>
        state === "loading" || state === "error" ? null : (
          <Chip
            selected
            onSelectedChange={() => undefined}
            {...pointer(state)}
            disabled={state === "disabled"}
          >
            {t.filterTags.assignedToMe}
          </Chip>
        ),
    },
    {
      name: "Chip removable",
      render: (state) =>
        state === "loading" || state === "error" || state === "active" ? null : (
          <Chip
            onRemove={() => undefined}
            removeLabel={t.filterTags.removeButtonName(t.filterTags.designTopic)}
            disabled={state === "disabled"}
            {...pointer(state)}
          >
            {t.filterTags.designTopic}
          </Chip>
        ),
    },
    {
      name: "List row",
      render: (state) =>
        state === "default" || state === "hover" ? (
          <Surface variant="row" interactive {...pointer(state)}>
            {t.surfaceSamples.taskTitles[0]}
          </Surface>
        ) : null,
    },
    {
      name: "List row selected",
      render: (state) =>
        state === "default" || state === "hover" ? (
          <Surface variant="row" interactive selected {...pointer(state)}>
            {t.surfaceSamples.taskTitles[0]}
          </Surface>
        ) : null,
    },
    {
      name: "Tab",
      render: (state) =>
        state === "loading" || state === "error" || state === "active" ? null : (
          <Tabs defaultValue={state === "default" ? "chat" : "other"}>
            <TabsList aria-label={t.sectionHeads.tabs.title}>
              <TabsTrigger value="chat" {...pointer(state)} disabled={state === "disabled"}>
                {t.workspaceTabs.labels.chat}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ),
    },
  ];

  return (
    <>
      <div className="g-intro">
        <h1>{t.chrome.pageNames.states}</h1>
        <p>{t.chrome.pageIntro}</p>
      </div>
      <div className="g-matrix-wrap">
        <table className="g-matrix">
          <thead>
            <tr>
              <th scope="col">
                <span className="vr-visually-hidden">{t.chrome.pageNames.components}</span>
              </th>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">
                  {t.stateMatrix.columnNames[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <th scope="row">
                  <code>{row.name}</code>
                </th>
                {COLUMNS.map((column) => {
                  const cell = row.render(column);
                  return (
                    <td key={column}>
                      {cell ?? <span className="g-none">{t.stateMatrix.notApplicable}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="g-section" aria-labelledby="long-title">
        <div className="g-section__head">
          <h2 id="long-title">{t.stateMatrix.longTextHeading}</h2>
        </div>
        <div className="g-section__body">
          <div className="g-narrow">
            <Button variant="primary">{t.stateMatrix.longSampleText}</Button>
            <Chip
              onRemove={() => undefined}
              removeLabel={t.filterTags.removeButtonName(t.stateMatrix.longSampleText)}
            >
              {t.stateMatrix.longSampleText}
            </Chip>
            <StatusBadge status="awaiting-approval" label={t.statusLabels["awaiting-approval"]} />
            <Field
              label={t.agentForm.digestChannelLabel}
              hint={t.stateMatrix.longSampleText}
              error={t.agentForm.digestChannelGone}
            >
              <Input defaultValue={t.stateMatrix.longSampleText} />
            </Field>
            <Callout tone="warning" title={t.stateMatrix.longSampleText}>
              {t.agentForm.digestChannelGone}
            </Callout>
            <Surface variant="row" interactive>
              <Avatar name={PEOPLE[3] ?? ""} size="sm" />
              <span className="g-grow g-ellipsis">{t.stateMatrix.longSampleText}</span>
              <StatusBadge status="failed" label={t.statusLabels.failed} />
            </Surface>
          </div>
        </div>
      </section>

      <section className="g-section" aria-labelledby="tones-title">
        <div className="g-section__head">
          <h2 id="tones-title">{t.sectionHeads.status.title}</h2>
          <p>{t.sectionHeads.status.note}</p>
        </div>
        <div className="g-section__body">
          <div className="g-row">
            {WORK_STATUSES.map((status) => (
              <StatusBadge key={status} status={status} label={t.statusLabels[status]} />
            ))}
          </div>
          <div className="g-grid">
            {TONES.map((tone) => (
              <Callout key={tone} tone={tone} title={t.noticeSamples[tone].title}>
                {t.noticeSamples[tone].body}
              </Callout>
            ))}
          </div>
          <EmptyState title={t.emptyRoutines.heading} description={t.emptyRoutines.explanation} />
        </div>
      </section>
    </>
  );
}

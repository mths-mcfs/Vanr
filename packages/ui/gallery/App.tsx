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
    <ToastProvider label={t.toast.region} closeLabel={t.toast.close}>
      <header className="g-bar">
        <div className="g-bar__brand">
          <Wordmark />
          <span className="g-bar__title">{t.galleryTitle}</span>
        </div>
        <nav className="g-bar__nav" aria-label={t.galleryTitle}>
          <a href="#components" aria-current={page === "components" ? "page" : undefined}>
            {t.pages.components}
          </a>
          <a href="#states" aria-current={page === "states" ? "page" : undefined}>
            {t.pages.states}
          </a>
        </nav>
        <div className="g-bar__controls">
          <Select
            size="sm"
            aria-label={t.theme.label}
            value={theme}
            onValueChange={(value) => setTheme(value as Theme)}
          >
            <SelectItem value="light">{t.theme.light}</SelectItem>
            <SelectItem value="dark">{t.theme.dark}</SelectItem>
            <SelectItem value="system">{t.theme.system}</SelectItem>
          </Select>
          <Select
            size="sm"
            aria-label={t.language}
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

function Section({ id, t, children }: { id: keyof Copy["sections"]; t: Copy; children: ReactNode }) {
  const section = t.sections[id];
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
        <h1>{t.pages.components}</h1>
        <p>{t.intro}</p>
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
        <p className="g-type__title">{t.typeSamples.title}</p>
        <p className="g-type__lead">{t.typeSamples.body}</p>
        <p>{t.typeSamples.body}</p>
        <p className="g-type__small">{t.typeSamples.body}</p>
        <code className="g-type__mono">{t.typeSamples.mono}</code>
      </div>
    </Section>
  );
}

function ButtonsSection({ t }: { t: Copy }) {
  return (
    <Section id="buttons" t={t}>
      <div className="g-row">
        <Button variant="primary" icon={<Icon icon={Send} />}>
          {t.actions.send}
        </Button>
        <Button>{t.actions.cancel}</Button>
        <Button variant="ghost" icon={<Icon icon={Archive} />}>
          {t.actions.archive}
        </Button>
        <Button variant="danger" icon={<Icon icon={Trash} />}>
          {t.actions.delete}
        </Button>
      </div>
      <div className="g-row">
        <Button variant="primary" size="sm">
          {t.actions.approve}
        </Button>
        <Button variant="primary">{t.actions.approve}</Button>
        <Button variant="primary" size="lg">
          {t.actions.approve}
        </Button>
        <Button variant="secondary" loading>
          {t.actions.save}
        </Button>
        <Button variant="primary" disabled>
          {t.actions.save}
        </Button>
      </div>
      <div className="g-row">
        <Button size="sm" variant="ghost" icon={<Icon icon={Ellipsis} />} aria-label={t.actions.more} />
        <Button icon={<Icon icon={Search} />} aria-label={t.actions.search} />
        <Button size="lg" variant="primary" icon={<Icon icon={Plus} />} aria-label={t.actions.newTask} />
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
        <Field label={t.fields.name} hint={t.fields.nameHint} required requiredLabel={t.fields.required}>
          <Input placeholder={t.fields.namePlaceholder} />
        </Field>
        <Field label={t.fields.model}>
          <Select placeholder={t.fields.modelPlaceholder}>
            <SelectItem value="haiku">claude-haiku-5-5</SelectItem>
            <SelectItem value="opus">claude-opus-5-5</SelectItem>
            <SelectItem value="local" disabled>
              local-runner
            </SelectItem>
          </Select>
        </Field>
        <Field label={t.fields.instructions} error={t.fields.instructionsError}>
          <Textarea placeholder={t.fields.instructionsPlaceholder} />
        </Field>
        <Field label={t.fields.agentId} disabled>
          <Input mono defaultValue="agt_01JD7Z3K9M" />
        </Field>
        <Field label={t.fields.long} error={t.fields.longError}>
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
          <Checkbox label={t.choices.notify} hint={t.choices.notifyHint} defaultChecked />
          <Checkbox label={t.choices.archived} checked="indeterminate" />
          <Checkbox label={t.choices.archived} disabled />
          <Switch label={t.choices.autoApprove} hint={t.choices.autoApproveHint} defaultChecked />
          <Switch label={t.choices.notify} />
          <Switch label={t.choices.notify} disabled defaultChecked />
        </div>
        <Field label={t.choices.schedule}>
          <RadioGroup defaultValue="daily">
            <Radio value="hourly" label={t.choices.hourly} />
            <Radio value="daily" label={t.choices.daily} />
            <Radio value="manual" label={t.choices.manual} disabled />
          </RadioGroup>
        </Field>
      </div>
    </Section>
  );
}

function ThreadMenuItems({ t }: { t: Copy }) {
  return (
    <>
      <MenuLabel>{t.menu.label}</MenuLabel>
      <MenuItem icon={<Icon icon={Pencil} />} shortcut={<Kbd>F2</Kbd>}>
        {t.menu.rename}
      </MenuItem>
      <MenuItem icon={<Icon icon={CopyIcon} />}>{t.menu.duplicate}</MenuItem>
      <MenuItem icon={<Icon icon={Pin} />} disabled>
        {t.menu.pin}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Icon icon={Trash} />} tone="danger">
        {t.menu.delete}
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
            <Button icon={<Icon icon={Pencil} />}>{t.dialog.open}</Button>
          </DialogTrigger>
          <DialogContent
            title={t.dialog.title}
            description={t.dialog.description}
            closeLabel={t.dialog.close}
            footer={
              <>
                <DialogClose asChild>
                  <Button>{t.actions.cancel}</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="primary">{t.actions.save}</Button>
                </DialogClose>
              </>
            }
          >
            <Field label={t.fields.name} hint={t.fields.nameHint}>
              <Input defaultValue="Scout" />
            </Field>
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          trigger={
            <Button variant="danger" icon={<Icon icon={Trash} />}>
              {t.dialog.confirmOpen}
            </Button>
          }
          tone="danger"
          title={t.dialog.confirmTitle}
          description={t.dialog.confirmDescription}
          confirmLabel={t.dialog.confirm}
          cancelLabel={t.actions.cancel}
          confirming={confirming}
          onConfirm={() => setConfirming(true)}
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
        />
        <Menu modal={!all} {...(all && { open: true })}>
          <MenuTrigger asChild>
            <Button icon={<Icon icon={Ellipsis} />}>{t.menu.open}</Button>
          </MenuTrigger>
          <MenuContent>
            <ThreadMenuItems t={t} />
          </MenuContent>
        </Menu>
        <Tooltip content={t.tooltip.text} {...(all && { open: true })} side="bottom">
          <Button variant="ghost" icon={<Icon icon={CopyIcon} />} aria-label={t.tooltip.trigger} />
        </Tooltip>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="g-context">{t.menu.contextArea}</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon={<Icon icon={Pencil} />}>{t.menu.rename}</ContextMenuItem>
          <ContextMenuItem icon={<Icon icon={CopyIcon} />}>{t.menu.duplicate}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon={<Icon icon={Trash} />} tone="danger">
            {t.menu.delete}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Switch label={t.menu.showAll} checked={all} onCheckedChange={setAll} />
    </Section>
  );
}

function TabsSection({ t }: { t: Copy }) {
  const tabs = ["chat", "tasks", "routines", "wiki"] as const;
  return (
    <Section id="tabs" t={t}>
      <Tabs defaultValue="chat">
        <TabsList aria-label={t.sections.tabs.title}>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab} disabled={tab === "wiki"}>
              {t.tabs[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent key={tab} value={tab}>
            {t.tabs.body[tab]}
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
      ...t.toast.items[tone],
      ...(tone === "success" && {
        action: { label: t.toast.undo, altText: t.toast.undoAlt, onAction: () => undefined },
      }),
    });
  return (
    <Section id="feedback" t={t}>
      <div className="g-stack">
        {TONES.map((tone) => (
          <Callout
            key={tone}
            tone={tone}
            title={t.callouts[tone].title}
            {...(tone === "danger" && {
              actions: (
                <Button size="sm" icon={<Icon icon={RotateCw} />}>
                  {t.actions.retry}
                </Button>
              ),
            })}
          >
            {t.callouts[tone].body}
          </Callout>
        ))}
      </div>
      <div className="g-row">
        {TONES.map((tone) => (
          <Button key={tone} size="sm" onClick={() => show(tone)}>
            {t.toast.push}: {t.toast.items[tone].title}
          </Button>
        ))}
        <Button size="sm" variant="primary" onClick={() => TONES.forEach(show)}>
          {t.toast.queue}
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
  const [selected, setSelected] = useState<Record<string, boolean>>({ mine: true });
  const [chips, setChips] = useState([t.chips.design, t.chips.urgent, t.chips.long]);
  useEffect(() => setChips([t.chips.design, t.chips.urgent, t.chips.long]), [t]);
  return (
    <Section id="status" t={t}>
      <div className="g-row">
        {WORK_STATUSES.map((status) => (
          <StatusBadge key={status} status={status} label={t.status[status]} />
        ))}
      </div>
      <div className="g-row">
        {(["mine", "urgent"] as const).map((key) => (
          <Chip
            key={key}
            selected={selected[key] ?? false}
            onSelectedChange={(value) => setSelected((s) => ({ ...s, [key]: value }))}
          >
            {t.chips[key]}
          </Chip>
        ))}
        {chips.map((label) => (
          <Chip
            key={label}
            icon={<Icon icon={Workflow} size="sm" />}
            onRemove={() => setChips((c) => c.filter((x) => x !== label))}
            removeLabel={t.chips.remove(label)}
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
            <strong>{t.surfaces.card}</strong>
            <StatusBadge status="running" label={t.status.running} />
          </div>
          <p className="g-muted">{t.surfaces.cardBody}</p>
        </Surface>
        <Surface variant="panel">
          <p className="g-panel-title">{t.surfaces.panel}</p>
          <pre className="g-log">
            {
              "09:14:02  fetch  github.com/vanr/issues\n09:14:03  parse  38 issues\n09:14:04  write  tasks 12 new"
            }
          </pre>
        </Surface>
      </div>
      <ul className="g-list">
        {t.surfaces.rows.map((row, index) => (
          <Surface key={row} variant="row" as="li" interactive selected={index === 1}>
            <AgentSigil agentId={AGENTS[index]?.id ?? "agt"} name={AGENTS[index]?.name ?? ""} size="sm" />
            <span className="g-grow">{row}</span>
            <StatusBadge
              status={(["done", "awaiting-approval", "paused"] as const)[index] ?? "done"}
              label={t.status[(["done", "awaiting-approval", "paused"] as const)[index] ?? "done"]}
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
        <Spinner size="lg" label={t.loading.label} />
      </div>
      <div className="g-skeleton" aria-busy="true">
        <span className="vr-visually-hidden">{t.loading.label}</span>
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
        title={t.empty.title}
        description={t.empty.description}
        action={
          <Button variant="primary" icon={<Icon icon={Plus} />}>
            {t.empty.action}
          </Button>
        }
      />
    </Section>
  );
}

/* States page: one row per control, one column per state, all drawn by the package's own CSS. */

type Column = keyof Copy["states"]["columns"];
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
          {t.actions.save}
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
            aria-label={t.actions.search}
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
            aria-label={t.fields.name}
            placeholder={t.fields.namePlaceholder}
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
            aria-label={t.fields.instructions}
            rows={2}
            defaultValue={t.typeSamples.body}
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
            aria-label={t.fields.model}
            placeholder={t.fields.modelPlaceholder}
            {...pointer(state)}
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          >
            <SelectItem value="haiku">claude-haiku-5-5</SelectItem>
          </Select>
        ),
    },
    {
      name: "Checkbox",
      render: (state) =>
        state === "loading" || state === "active" ? null : (
          <Checkbox
            label={t.choices.notify}
            defaultChecked={state !== "default"}
            {...pointer(state)}
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          />
        ),
    },
    {
      name: "Switch",
      render: (state) =>
        state === "loading" || state === "active" || state === "error" ? null : (
          <Switch
            label={t.choices.notify}
            defaultChecked={state !== "default"}
            {...pointer(state)}
            disabled={state === "disabled"}
          />
        ),
    },
    {
      name: "Radio",
      render: (state) =>
        state === "loading" || state === "active" ? null : (
          <RadioGroup
            aria-label={t.choices.schedule}
            defaultValue="daily"
            disabled={state === "disabled"}
            aria-invalid={state === "error" || undefined}
          >
            <Radio value="daily" label={t.choices.daily} {...pointer(state)} />
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
            {t.chips.mine}
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
            {t.chips.mine}
          </Chip>
        ),
    },
    {
      name: "Chip removable",
      render: (state) =>
        state === "loading" || state === "error" || state === "active" ? null : (
          <Chip
            onRemove={() => undefined}
            removeLabel={t.chips.remove(t.chips.design)}
            disabled={state === "disabled"}
            {...pointer(state)}
          >
            {t.chips.design}
          </Chip>
        ),
    },
    {
      name: "List row",
      render: (state) =>
        state === "default" || state === "hover" ? (
          <Surface variant="row" interactive {...pointer(state)}>
            {t.surfaces.rows[0]}
          </Surface>
        ) : null,
    },
    {
      name: "List row selected",
      render: (state) =>
        state === "default" || state === "hover" ? (
          <Surface variant="row" interactive selected {...pointer(state)}>
            {t.surfaces.rows[0]}
          </Surface>
        ) : null,
    },
    {
      name: "Tab",
      render: (state) =>
        state === "loading" || state === "error" || state === "active" ? null : (
          <Tabs defaultValue={state === "default" ? "chat" : "other"}>
            <TabsList aria-label={t.sections.tabs.title}>
              <TabsTrigger value="chat" {...pointer(state)} disabled={state === "disabled"}>
                {t.tabs.chat}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ),
    },
  ];

  return (
    <>
      <div className="g-intro">
        <h1>{t.pages.states}</h1>
        <p>{t.intro}</p>
      </div>
      <div className="g-matrix-wrap">
        <table className="g-matrix">
          <thead>
            <tr>
              <th scope="col">
                <span className="vr-visually-hidden">{t.pages.components}</span>
              </th>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">
                  {t.states.columns[column]}
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
                  return <td key={column}>{cell ?? <span className="g-none">{t.states.none}</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="g-section" aria-labelledby="long-title">
        <div className="g-section__head">
          <h2 id="long-title">{t.states.longTitle}</h2>
        </div>
        <div className="g-section__body">
          <div className="g-narrow">
            <Button variant="primary">{t.states.longBody}</Button>
            <Chip onRemove={() => undefined} removeLabel={t.chips.remove(t.states.longBody)}>
              {t.states.longBody}
            </Chip>
            <StatusBadge status="awaiting-approval" label={t.status["awaiting-approval"]} />
            <Field label={t.fields.long} hint={t.states.longBody} error={t.fields.longError}>
              <Input defaultValue={t.states.longBody} />
            </Field>
            <Callout tone="warning" title={t.states.longBody}>
              {t.fields.longError}
            </Callout>
            <Surface variant="row" interactive>
              <Avatar name={PEOPLE[3] ?? ""} size="sm" />
              <span className="g-grow g-ellipsis">{t.states.longBody}</span>
              <StatusBadge status="failed" label={t.status.failed} />
            </Surface>
          </div>
        </div>
      </section>

      <section className="g-section" aria-labelledby="tones-title">
        <div className="g-section__head">
          <h2 id="tones-title">{t.sections.status.title}</h2>
          <p>{t.sections.status.note}</p>
        </div>
        <div className="g-section__body">
          <div className="g-row">
            {WORK_STATUSES.map((status) => (
              <StatusBadge key={status} status={status} label={t.status[status]} />
            ))}
          </div>
          <div className="g-grid">
            {TONES.map((tone) => (
              <Callout key={tone} tone={tone} title={t.callouts[tone].title}>
                {t.callouts[tone].body}
              </Callout>
            ))}
          </div>
          <EmptyState title={t.empty.title} description={t.empty.description} />
        </div>
      </section>
    </>
  );
}

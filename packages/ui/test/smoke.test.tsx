import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Plus } from "lucide-react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
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
  ContextMenuTrigger,
  Dialog,
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
  Tooltip,
  WORK_STATUSES,
  Wordmark,
} from "../src/index.ts";

// Every React warning (bad prop, missing key, invalid nesting) goes through console.error or
// console.warn. A render that logs anything fails.
let logged: string[] = [];
const original = { error: console.error, warn: console.warn };

beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
});

afterEach(() => {
  console.error = original.error;
  console.warn = original.warn;
});

function render(element: ReactElement): string {
  const html = renderToString(element);
  expect(logged).toEqual([]);
  return html;
}

const cases: Array<[name: string, element: ReactElement]> = [];
const add = (name: string, element: ReactElement) => cases.push([name, element]);

for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
  for (const size of ["sm", "md", "lg"] as const) {
    add(
      `Button ${variant} ${size}`,
      <Button variant={variant} size={size}>
        Save
      </Button>,
    );
  }
  add(
    `Button ${variant} loading`,
    <Button variant={variant} loading>
      Save
    </Button>,
  );
  add(
    `Button ${variant} disabled`,
    <Button variant={variant} disabled>
      Save
    </Button>,
  );
  add(
    `Button ${variant} icon only`,
    <Button variant={variant} icon={<Icon icon={Plus} />} aria-label="Add" />,
  );
}
add("Button with icon", <Button icon={<Icon icon={Plus} />}>Add</Button>);

for (const size of ["sm", "md", "lg"] as const) {
  add(`Input ${size}`, <Input size={size} aria-label="Name" />);
  add(
    `Select ${size}`,
    <Select size={size} aria-label="Model" placeholder="Pick">
      <SelectItem value="a">A</SelectItem>
    </Select>,
  );
  add(`Icon ${size}`, <Icon icon={Plus} size={size} />);
  add(`Icon ${size} labelled`, <Icon icon={Plus} size={size} label="Add" />);
  add(`Spinner ${size}`, <Spinner size={size} />);
  add(`Avatar ${size}`, <Avatar name="Ana Beatriz Souza" size={size} />);
  add(`AgentSigil ${size}`, <AgentSigil agentId="agt_1" name="Scout" size={size} />);
  add(`Wordmark ${size}`, <Wordmark size={size} />);
}
add("Input mono disabled", <Input mono disabled aria-label="Id" />);
add("Textarea", <Textarea aria-label="Notes" />);
add("Textarea invalid", <Textarea aria-label="Notes" aria-invalid />);
add(
  "Select with value",
  <Select aria-label="Model" defaultValue="a" disabled>
    <SelectItem value="a">A</SelectItem>
    <SelectItem value="b" disabled>
      B
    </SelectItem>
  </Select>,
);
add(
  "Field with hint and error",
  <Field label="Name" hint="Shown in chat" error="Required" required requiredLabel="required">
    <Input />
  </Field>,
);
add(
  "Field disabled",
  <Field label="Name" disabled>
    <Input />
  </Field>,
);
add("Checkbox", <Checkbox label="Notify me" hint="In the thread" />);
add("Checkbox checked", <Checkbox label="Notify me" defaultChecked />);
add("Checkbox indeterminate", <Checkbox label="All" checked="indeterminate" />);
add("Checkbox disabled", <Checkbox label="Notify me" disabled />);
add("Switch", <Switch label="Auto approve" />);
add("Switch checked disabled", <Switch label="Auto approve" defaultChecked disabled />);
add(
  "RadioGroup in Field",
  <Field label="Schedule" error="Pick one">
    <RadioGroup defaultValue="a">
      <Radio value="a" label="Hourly" />
      <Radio value="b" label="Daily" hint="At 9:00" disabled />
    </RadioGroup>
  </Field>,
);
add(
  "Dialog",
  <Dialog defaultOpen>
    <DialogTrigger>Open</DialogTrigger>
    <DialogContent
      title="Rename"
      description="Shown everywhere"
      closeLabel="Close"
      footer={<Button>Ok</Button>}
    >
      body
    </DialogContent>
  </Dialog>,
);
for (const tone of ["default", "danger"] as const) {
  add(
    `ConfirmDialog ${tone}`,
    <ConfirmDialog
      trigger={<Button>Delete</Button>}
      title="Delete?"
      description="Gone for good."
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onConfirm={() => undefined}
      tone={tone}
    />,
  );
}
add(
  "Menu",
  <Menu>
    <MenuTrigger>More</MenuTrigger>
    <MenuContent>
      <MenuLabel>Thread</MenuLabel>
      <MenuItem icon={<Icon icon={Plus} />} shortcut={<Kbd>F2</Kbd>}>
        Rename
      </MenuItem>
      <MenuSeparator />
      <MenuItem tone="danger">Delete</MenuItem>
    </MenuContent>
  </Menu>,
);
add(
  "ContextMenu",
  <ContextMenu>
    <ContextMenuTrigger>Area</ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem>Rename</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>,
);
add(
  "Tabs",
  <Tabs defaultValue="a">
    <TabsList aria-label="Sections">
      <TabsTrigger value="a">A</TabsTrigger>
      <TabsTrigger value="b" disabled>
        B
      </TabsTrigger>
    </TabsList>
    <TabsContent value="a">A body</TabsContent>
    <TabsContent value="b">B body</TabsContent>
  </Tabs>,
);
add(
  "Tooltip",
  <Tooltip content="Copies the id">
    <Button>Copy</Button>
  </Tooltip>,
);
add(
  "ToastProvider",
  <ToastProvider label="Notifications" closeLabel="Dismiss">
    <p>app</p>
  </ToastProvider>,
);
for (const tone of ["info", "success", "warning", "danger"] as const) {
  add(
    `Callout ${tone}`,
    <Callout tone={tone} title="Title" actions={<Button size="sm">Retry</Button>}>
      Body
    </Callout>,
  );
}
for (const status of WORK_STATUSES)
  add(`StatusBadge ${status}`, <StatusBadge status={status} label={status} />);
add("Chip", <Chip>Design</Chip>);
add(
  "Chip selectable",
  <Chip selected={false} onSelectedChange={() => undefined}>
    Mine
  </Chip>,
);
add(
  "Chip selected",
  <Chip selected onSelectedChange={() => undefined}>
    Mine
  </Chip>,
);
add(
  "Chip removable",
  <Chip onRemove={() => undefined} removeLabel="Remove Design">
    Design
  </Chip>,
);
add(
  "Chip removable disabled",
  <Chip onRemove={() => undefined} removeLabel="Remove" disabled>
    Design
  </Chip>,
);
for (const variant of ["card", "panel", "row"] as const) {
  add(`Surface ${variant}`, <Surface variant={variant}>content</Surface>);
}
add(
  "Surface row as li, interactive, selected",
  <ul>
    <Surface variant="row" as="li" interactive selected>
      row
    </Surface>
  </ul>,
);
add("Avatar with photo", <Avatar name="Jonas Lind" src="/jonas.png" />);
add("Spinner labelled", <Spinner label="Loading threads" />);
for (const shape of ["line", "block", "circle"] as const)
  add(`Skeleton ${shape}`, <Skeleton shape={shape} />);
add(
  "EmptyState",
  <EmptyState
    title="No routines"
    description="Add one"
    icon={<Icon icon={Plus} />}
    action={<Button>New</Button>}
  />,
);
add("Kbd", <Kbd>K</Kbd>);
add("Wordmark mark", <Wordmark variant="mark" />);

describe("server render without React warnings", () => {
  for (const [name, element] of cases) {
    test(name, () => {
      expect(render(element).length).toBeGreaterThan(0);
    });
  }
});

describe("accessible wiring", () => {
  test("Field ties label, hint and error to the control", () => {
    const html = render(
      <Field label="Name" hint="Shown in chat" error="Required">
        <Input aria-describedby="extra" />
      </Field>,
    );
    const id = html.match(/<input[^>]* id="([^"]+)"/)?.[1];
    const describedBy = html.match(/<input[^>]* aria-describedby="([^"]+)"/)?.[1]?.split(" ") ?? [];
    expect(id).toBeDefined();
    expect(html).toContain(`for="${id}"`);
    expect(html).toMatch(/<input[^>]* aria-invalid="true"/);
    const hintId = html.match(/<p class="vr-field__hint" id="([^"]+)"/)?.[1] ?? "missing hint id";
    const errorId = html.match(/<p class="vr-field__error" id="([^"]+)"/)?.[1] ?? "missing error id";
    expect(describedBy).toEqual([hintId, errorId, "extra"]);
  });

  test("a Field without an error leaves the control valid", () => {
    const html = render(
      <Field label="Name">
        <Textarea />
      </Field>,
    );
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });

  test("a Field label names a radio group", () => {
    const html = render(
      <Field label="Schedule">
        <RadioGroup>
          <Radio value="a" label="Hourly" />
        </RadioGroup>
      </Field>,
    );
    const labelId = html.match(/<label class="vr-field__label" id="([^"]+)"/)?.[1];
    expect(html).toMatch(new RegExp(`role="radiogroup"[^>]* aria-labelledby="${labelId}"`));
  });

  test("Select trigger takes the Field wiring", () => {
    const html = render(
      <Field label="Model" error="Pick a model">
        <Select>
          <SelectItem value="a">A</SelectItem>
        </Select>
      </Field>,
    );
    expect(html).toMatch(/<button[^>]* role="combobox"[^>]* aria-invalid="true"/);
    expect(html).toMatch(/<button[^>]* aria-describedby="[^"]+-error"/);
  });

  test("names come from props, not from hard-coded English", () => {
    const html = render(
      <>
        <Chip onRemove={() => undefined} removeLabel="Remover Design">
          Design
        </Chip>
        <Avatar name="Íris Valença" />
        <AgentSigil agentId="agt_9" name="Fjell" />
        <Spinner label="Carregando" />
      </>,
    );
    expect(html).toContain('aria-label="Remover Design"');
    expect(html).toContain('aria-label="Íris Valença"');
    expect(html).toContain('aria-label="Fjell"');
    expect(html).toContain("Carregando");
  });

  test("a loading button stays named and focusable but reports busy", () => {
    const html = render(<Button loading>Save</Button>);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain("Save");
  });

  test("an icon is hidden from assistive tech unless it has a label", () => {
    expect(render(<Icon icon={Plus} />)).toContain('aria-hidden="true"');
    expect(render(<Icon icon={Plus} label="Add" />)).toContain('aria-label="Add"');
  });
});

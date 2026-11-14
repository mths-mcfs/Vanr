// The Field case table, shared by the server-render test and the hydration test.
import type { expect as bunExpect } from "bun:test";
import type { ReactElement } from "react";
import {
  Checkbox,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Switch,
  Textarea,
} from "../src/index.ts";

export type Facts = {
  /** Every id attribute, in document order. */
  ids: string[];
  /** The Field's own label: its `for`, or null when it names a group instead. */
  fieldFor: string | null;
  fieldLabelId: string;
  /** Ids of the form controls (input, textarea, select, role=checkbox|switch|combobox button). */
  controls: string[];
  /** `for` of every inline choice label. */
  choiceFors: string[];
  html: string;
};

export function facts(html: string): Facts {
  const attr = (tag: string, name: string) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
  const tags = [...html.matchAll(/<([a-z]+)\b[^>]*>/g)].map((m) => ({ name: m[1] ?? "", tag: m[0] }));
  const fieldLabel = tags.find((t) => t.tag.includes('class="vr-field__label"'));
  const isControl = (t: { name: string; tag: string }) =>
    !t.tag.includes('aria-hidden="true"') &&
    (t.name === "input" ||
      t.name === "textarea" ||
      t.name === "select" ||
      (t.name === "button" && /role="(checkbox|switch|combobox|radio)"/.test(t.tag)));
  return {
    ids: tags.map((t) => attr(t.tag, "id")).filter((id): id is string => id !== undefined),
    fieldFor: fieldLabel === undefined ? null : (attr(fieldLabel.tag, "for") ?? null),
    fieldLabelId: fieldLabel === undefined ? "" : (attr(fieldLabel.tag, "id") ?? ""),
    controls: tags
      .filter(isControl)
      .map((t) => attr(t.tag, "id"))
      .filter((id): id is string => id !== undefined),
    choiceFors: tags
      .filter((t) => t.tag.includes('class="vr-choice__label"'))
      .map((t) => attr(t.tag, "for") ?? ""),
    html,
  };
}

export type Case = { name: string; element: ReactElement; expect: (f: Facts) => void };

type Expect = typeof bunExpect;

export function fieldCases(expect: Expect): Case[] {
  const groupOf = (f: Facts) => f.html.match(/<fieldset[^>]*>/)?.[0] ?? "";
  return [
    {
      name: "one control: generated id, label points at it",
      element: (
        <Field label="Email">
          <Input />
        </Field>
      ),
      expect: (f) => {
        expect(f.controls.length).toBe(1);
        expect(f.fieldFor).toBe(f.controls[0] ?? "no control");
      },
    },
    {
      name: "control with its own id: label points at that id",
      element: (
        <Field label="Email">
          <Input id="email" />
        </Field>
      ),
      expect: (f) => {
        expect(f.controls).toContain("email");
        expect(f.fieldFor).toBe("email");
      },
    },
    {
      name: "explicit controlId: control and label use it",
      element: (
        <Field label="Email" controlId="email">
          <Input />
        </Field>
      ),
      expect: (f) => {
        expect(f.controls[0]).toBe("email");
        expect(f.fieldFor).toBe("email");
      },
    },
    {
      name: "explicit controlId beats the control's own id",
      element: (
        <Field label="Email" controlId="email">
          <Input id="other" />
        </Field>
      ),
      expect: (f) => {
        expect(f.controls[0]).toBe("email");
        expect(f.fieldFor).toBe("email");
      },
    },
    {
      name: "wrapper with an id never lends it",
      element: (
        <Field label="Email">
          <div id="wrapper">
            <Input />
          </div>
        </Field>
      ),
      expect: (f) => {
        expect(f.fieldFor).toBe(f.controls[0] ?? "no control");
        expect(f.controls[0] === "wrapper").toBe(false);
      },
    },
    {
      name: "wrapper with an id and explicit controlId",
      element: (
        <Field label="Email" controlId="email">
          <div id="wrapper">
            <Input />
          </div>
        </Field>
      ),
      expect: (f) => {
        expect(f.controls[0]).toBe("email");
        expect(f.fieldFor).toBe("email");
      },
    },
    {
      name: "wrapper with an id around a control with its own id",
      element: (
        <Field label="Email">
          <div id="wrapper">
            <Input id="email" />
          </div>
        </Field>
      ),
      expect: (f) => {
        expect(f.controls[0]).toBe("email");
        expect(f.fieldFor).toBe("email");
      },
    },
    {
      name: "Textarea and Select take the Field id like Input",
      element: (
        <>
          <Field label="Notes">
            <Textarea />
          </Field>
          <Field label="Model">
            <Select>
              <SelectItem value="a">A</SelectItem>
            </Select>
          </Field>
        </>
      ),
      expect: (f) => {
        expect(f.controls.length).toBe(2);
        for (const id of f.controls) expect(f.html).toContain(`for="${id}"`);
      },
    },
    {
      name: "one checkbox: the Field id, both labels point at it",
      element: (
        <Field label="Alerts">
          <Checkbox label="Email" />
        </Field>
      ),
      expect: (f) => {
        expect(f.controls.length).toBe(1);
        expect(f.fieldFor).toBe(f.controls[0] ?? "no control");
        expect(f.choiceFors[0]).toBe(f.controls[0] ?? "no control");
      },
    },
    {
      name: "two checkboxes: a named group, each keeps its own id and label",
      element: (
        <Field label="Alerts">
          <Checkbox label="Email" />
          <Checkbox label="SMS" />
        </Field>
      ),
      expect: (f) => {
        expect(f.fieldFor).toBe(null);
        expect(groupOf(f)).toContain(`aria-labelledby="${f.fieldLabelId}"`);
        expect(f.controls.length).toBe(2);
        expect(f.controls[0] === f.controls[1]).toBe(false);
        expect(f.choiceFors.join(" ")).toBe(f.controls.join(" "));
      },
    },
    {
      name: "two switches: a named group, each keeps its own id and label",
      element: (
        <Field label="Alerts" hint="Pick any">
          <Switch label="Email" />
          <Switch label="SMS" />
        </Field>
      ),
      expect: (f) => {
        expect(f.fieldFor).toBe(null);
        expect(groupOf(f)).toContain(`aria-labelledby="${f.fieldLabelId}"`);
        expect(groupOf(f)).toMatch(/aria-describedby="[^"]+-hint"/);
        expect(f.choiceFors.join(" ")).toBe(f.controls.join(" "));
        expect(f.controls[0] === f.controls[1]).toBe(false);
      },
    },
    {
      name: "two inputs: a named group, each input named by the Field label",
      element: (
        <Field label="Full name">
          <Input aria-label="First" />
          <Input aria-label="Last" />
        </Field>
      ),
      expect: (f) => {
        expect(f.fieldFor).toBe(null);
        expect(groupOf(f)).toContain(`aria-labelledby="${f.fieldLabelId}"`);
        const inputs = [...f.html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
        expect(inputs.length).toBe(2);
        for (const input of inputs) {
          expect(input).toContain(`aria-labelledby="${f.fieldLabelId}"`);
          expect(input.includes(" id=")).toBe(false);
        }
      },
    },
    {
      name: "radio group: the Field label names the group, no for",
      element: (
        <Field label="Schedule">
          <RadioGroup>
            <Radio value="a" label="Hourly" />
            <Radio value="b" label="Daily" />
          </RadioGroup>
        </Field>
      ),
      expect: (f) => {
        expect(f.fieldFor).toBe(null);
        expect(f.html).toMatch(new RegExp(`role="radiogroup"[^>]* aria-labelledby="${f.fieldLabelId}"`));
        expect(f.choiceFors.join(" ")).toBe(f.controls.join(" "));
      },
    },
    {
      name: "a control from outside the package: no borrowed id, for only with controlId",
      element: (
        <>
          <Field label="Color">
            <input id="color" type="color" />
          </Field>
          <Field label="Size" controlId="size">
            <input id="size" type="range" />
          </Field>
        </>
      ),
      expect: (f) => {
        const fors = [...f.html.matchAll(/class="vr-field__label"[^>]*?(?: for="([^"]+)")?>/g)].map(
          (m) => m[1],
        );
        expect(fors[0]).toBe(undefined);
        expect(fors[1]).toBe("size");
      },
    },
    {
      name: "no Field: the control adds no id of its own",
      element: <Input aria-label="Search" />,
      expect: (f) => {
        expect(f.ids.length).toBe(0);
      },
    },
  ];
}

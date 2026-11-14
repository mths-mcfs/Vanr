// Example copy for the gallery. The pt-BR strings run longer on purpose: they are the stress
// test for wrapping and truncation.
import type { WorkStatus } from "@vanr/ui";

export type Locale = "en" | "pt-BR";

export type Copy = {
  galleryTitle: string;
  pages: { components: string; states: string };
  theme: { label: string; light: string; dark: string; system: string };
  language: string;
  intro: string;
  sections: Record<
    | "type"
    | "buttons"
    | "fields"
    | "choices"
    | "overlays"
    | "tabs"
    | "feedback"
    | "identity"
    | "status"
    | "surfaces"
    | "loading"
    | "empty",
    { title: string; note: string }
  >;
  typeSamples: { title: string; body: string; mono: string };
  actions: {
    send: string;
    save: string;
    cancel: string;
    archive: string;
    delete: string;
    retry: string;
    approve: string;
    newTask: string;
    more: string;
    search: string;
    saving: string;
  };
  fields: {
    name: string;
    namePlaceholder: string;
    nameHint: string;
    instructions: string;
    instructionsPlaceholder: string;
    instructionsError: string;
    model: string;
    modelPlaceholder: string;
    agentId: string;
    required: string;
    long: string;
    longError: string;
  };
  choices: {
    notify: string;
    notifyHint: string;
    autoApprove: string;
    autoApproveHint: string;
    schedule: string;
    hourly: string;
    daily: string;
    manual: string;
    archived: string;
  };
  dialog: {
    open: string;
    title: string;
    description: string;
    close: string;
    confirmOpen: string;
    confirmTitle: string;
    confirmDescription: string;
    confirm: string;
  };
  menu: {
    open: string;
    label: string;
    rename: string;
    duplicate: string;
    pin: string;
    delete: string;
    contextArea: string;
    showAll: string;
  };
  tooltip: { trigger: string; text: string };
  tabs: { chat: string; tasks: string; routines: string; wiki: string; body: Record<string, string> };
  toast: {
    region: string;
    close: string;
    push: string;
    queue: string;
    undo: string;
    undoAlt: string;
    items: Record<"info" | "success" | "warning" | "danger", { title: string; description: string }>;
  };
  callouts: Record<"info" | "success" | "warning" | "danger", { title: string; body: string }>;
  status: Record<WorkStatus, string>;
  chips: { design: string; urgent: string; mine: string; remove: (label: string) => string; long: string };
  surfaces: { card: string; cardBody: string; panel: string; rows: string[] };
  empty: { title: string; description: string; action: string };
  loading: { label: string };
  states: {
    columns: Record<"default" | "hover" | "focus" | "active" | "disabled" | "loading" | "error", string>;
    none: string;
    longTitle: string;
    longBody: string;
  };
};

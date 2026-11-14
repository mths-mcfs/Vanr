// Example copy for the gallery, grouped by the gallery section that shows it. Keys name what the
// text illustrates. The pt-BR strings run longer on purpose: they are the stress test for
// wrapping and truncation.
import type { Tone, WorkStatus } from "@vanr/ui";

export type Locale = "en" | "pt-BR";

export type SectionId =
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
  | "empty";

export type WorkspaceTab = "chat" | "tasks" | "schedules" | "knowledgeBase";

export type MatrixColumn = "default" | "hover" | "focus" | "active" | "disabled" | "loading" | "error";

/** A sample notice: the toast samples are passed straight to useToast().push. */
type Sample = { title: string; description: string };

export type Copy = {
  /** The gallery's own header and page names. */
  chrome: {
    kitName: string;
    pageNames: { components: string; states: string };
    themePicker: { label: string; birch: string; tar: string; followOs: string };
    languagePicker: string;
    pageIntro: string;
  };
  sectionHeads: Record<SectionId, { title: string; note: string }>;
  /** Type section. */
  typeSpecimen: { headline: string; paragraph: string; logLine: string };
  /** Buttons section, also reused as dialog and state-matrix actions. */
  buttonLabels: {
    sendMessage: string;
    saveEdits: string;
    cancel: string;
    archiveThread: string;
    deleteRoutine: string;
    retryRun: string;
    approveRequest: string;
    createTask: string;
    overflowMenuName: string;
    searchIconName: string;
  };
  /** Fields section: an agent's settings form. */
  agentForm: {
    nameLabel: string;
    nameExample: string;
    nameShownInChat: string;
    promptLabel: string;
    promptExample: string;
    promptMissing: string;
    modelPickerLabel: string;
    modelPrompt: string;
    idLabel: string;
    requiredMark: string;
    digestChannelLabel: string;
    digestChannelGone: string;
  };
  /** Choices section: toggles and the run cadence of an agent. */
  agentSettings: {
    notifyWhenDone: string;
    notifyWhenDoneHelp: string;
    approveEditsAlone: string;
    approveEditsAloneHelp: string;
    runCadence: string;
    everyHourOption: string;
    everyMorningOption: string;
    byHandOption: string;
    shelvedRoutinesOption: string;
  };
  /** Overlays section. */
  renameDialog: { trigger: string; heading: string; explanation: string; closeButton: string };
  deleteDialog: { trigger: string; question: string; consequence: string; confirmButton: string };
  threadMenu: {
    trigger: string;
    groupName: string;
    renameThread: string;
    duplicateThread: string;
    pinThread: string;
    deleteThread: string;
    rightClickTarget: string;
    openEveryOverlay: string;
  };
  copyIdTooltip: { buttonName: string; hint: string };
  /** Tabs section. */
  workspaceTabs: { labels: Record<WorkspaceTab, string>; panels: Record<WorkspaceTab, string> };
  /** Feedback section. */
  notifications: {
    regionName: string;
    dismissButton: string;
    showPrefix: string;
    queueFour: string;
    undoButton: string;
    undoExplanation: string;
    samples: Record<Tone, Sample>;
  };
  noticeSamples: Record<Tone, { title: string; body: string }>;
  /** Work status section. */
  statusLabels: Record<WorkStatus, string>;
  filterTags: {
    designTopic: string;
    highPriority: string;
    assignedToMe: string;
    removeButtonName: (tag: string) => string;
    longCustomerTopic: string;
  };
  /** Surfaces section. */
  surfaceSamples: { digestName: string; digestCadence: string; runLogHeading: string; taskTitles: string[] };
  /** Empty state section. */
  emptyRoutines: { heading: string; explanation: string; createButton: string };
  /** Loading section. */
  loadingSample: { threadsLoading: string };
  /** States page. */
  stateMatrix: {
    columnNames: Record<MatrixColumn, string>;
    notApplicable: string;
    longTextHeading: string;
    longSampleText: string;
  };
};

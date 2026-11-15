import type { Copy } from "./types.ts";

export const en: Copy = {
  chrome: {
    kitName: "Interface kit",
    pageNames: {
      components: "Components",
      states: "States",
    },
    themePicker: {
      label: "Theme",
      birch: "Birch",
      tar: "Tar",
      followOs: "System",
    },
    languagePicker: "Language",
    pageIntro: "Every primitive Vanr screens are built from, in both themes. Nothing here talks to a server.",
  },
  sectionHeads: {
    type: {
      title: "Type",
      note: "Interface sans for work, mono for ids and logs, the serif only for titles.",
    },
    buttons: {
      title: "Buttons",
      note: "One primary action per view. Danger is for what cannot be undone.",
    },
    fields: {
      title: "Fields",
      note: "Label, hint and error are wired to the control.",
    },
    choices: {
      title: "Choices",
      note: "Checkbox, switch and radio, each with its label beside it.",
    },
    overlays: {
      title: "Overlays",
      note: "Dialogs, menus, tooltips and select lists open over the page.",
    },
    tabs: {
      title: "Tabs",
      note: "Arrow keys move between tabs.",
    },
    feedback: {
      title: "Feedback",
      note: "Callouts stay on the page; toasts come and go.",
    },
    identity: {
      title: "People and agents",
      note: "People are round. Agents carry a sigil drawn from their id.",
    },
    status: {
      title: "Work status",
      note: "Each status has its own glyph, so color is never the only cue.",
    },
    surfaces: {
      title: "Surfaces",
      note: "Cards, panels and list rows, separated by lines, not shadows.",
    },
    loading: {
      title: "Loading",
      note: "A spinner for actions, skeletons for content on its way.",
    },
    empty: {
      title: "Empty state",
      note: "An empty view says what goes here and how to add it.",
    },
  },
  typeSpecimen: {
    headline: "Quarterly planning",
    paragraph:
      "Scout drafted the release notes from the merged pull requests and is waiting for your review.",
    logLine: "09:14:02  run_01JD8Q2W4X  exit 0 in 2.4 s",
  },
  buttonLabels: {
    sendMessage: "Send",
    saveEdits: "Save changes",
    cancel: "Cancel",
    archiveThread: "Archive",
    deleteRoutine: "Delete routine",
    retryRun: "Retry",
    approveRequest: "Approve",
    createTask: "New task",
    overflowMenuName: "More actions",
    searchIconName: "Search",
  },
  agentForm: {
    nameLabel: "Agent name",
    nameExample: "e.g. Release scout",
    nameShownInChat: "Shown in chat next to the agent's sigil.",
    promptLabel: "Instructions",
    promptExample: "What should this agent do?",
    promptMissing: "Add at least one instruction before saving.",
    modelPickerLabel: "Model",
    modelPrompt: "Choose a model",
    idLabel: "Agent id",
    requiredMark: "required",
    digestChannelLabel: "Where should the weekly summary go",
    digestChannelGone: "This channel no longer exists. Pick another one.",
  },
  agentSettings: {
    notifyWhenDone: "Notify me when it finishes",
    notifyWhenDoneHelp: "Sends a message in the thread.",
    approveEditsAlone: "Approve file edits automatically",
    approveEditsAloneHelp: "Shell commands still ask first.",
    runCadence: "Run schedule",
    everyHourOption: "Every hour",
    everyMorningOption: "Every day at 9:00",
    byHandOption: "Only when started by hand",
    shelvedRoutinesOption: "Archived routines",
  },
  renameDialog: {
    trigger: "Rename agent",
    heading: "Rename agent",
    explanation: "The new name shows up everywhere the agent appears.",
    closeButton: "Close",
  },
  deleteDialog: {
    trigger: "Delete routine",
    question: "Delete the routine “Weekly digest”?",
    consequence: "Its run history goes with it. This cannot be undone.",
    confirmButton: "Delete routine",
  },
  threadMenu: {
    trigger: "Thread actions",
    groupName: "Thread",
    renameThread: "Rename",
    duplicateThread: "Duplicate",
    pinThread: "Pin to sidebar",
    deleteThread: "Delete thread",
    rightClickTarget: "Right-click this message for its menu",
    openEveryOverlay: "Open every overlay at once",
  },
  copyIdTooltip: {
    buttonName: "Copy run id",
    hint: "Copies run_01JD8Q2W4X",
  },
  workspaceTabs: {
    labels: {
      chat: "Chat",
      tasks: "Tasks",
      schedules: "Routines",
      knowledgeBase: "Wiki",
    },
    panels: {
      chat: "Threads with people and agents.",
      tasks: "Work assigned to you or to an agent.",
      schedules: "Jobs that run on a schedule.",
      knowledgeBase: "Pages the whole workspace can edit.",
    },
  },
  notifications: {
    regionName: "Notifications",
    dismissButton: "Dismiss",
    showPrefix: "Show",
    queueFour: "Queue four",
    undoButton: "Undo",
    undoExplanation: "Undo archiving the thread",
    samples: {
      info: {
        title: "Scout picked up the task",
        description: "It usually takes a few minutes.",
      },
      success: {
        title: "Changes saved",
        description: "Everyone in the workspace sees the new name.",
      },
      warning: {
        title: "Ledger is waiting for approval",
        description: "It wants to run a shell command.",
      },
      danger: {
        title: "Run failed",
        description: "The connector returned 401. Reconnect it and retry.",
      },
    },
  },
  noticeSamples: {
    info: {
      title: "Agents can read this page",
      body: "Anything written here is available to every agent in the workspace.",
    },
    success: {
      title: "Connector ready",
      body: "GitHub is connected. New issues show up in Tasks.",
    },
    warning: {
      title: "Approval needed",
      body: "Ledger wants to delete 14 files in /reports. Review the list first.",
    },
    danger: {
      title: "Routine stopped",
      body: "Three runs in a row failed. Fix the credentials, then resume it.",
    },
  },
  statusLabels: {
    running: "Running",
    "awaiting-approval": "Needs approval",
    "awaiting-reply": "Waiting for reply",
    failed: "Failed",
    done: "Done",
    paused: "Paused",
  },
  filterTags: {
    designTopic: "Design",
    highPriority: "Urgent",
    assignedToMe: "Assigned to me",
    removeButtonName: (label) => `Remove ${label}`,
    longCustomerTopic: "Customer onboarding and migration",
  },
  surfaceSamples: {
    digestName: "Weekly digest",
    digestCadence: "Runs every Monday at 9:00 and posts to #team.",
    runLogHeading: "Run log",
    taskTitles: ["Draft release notes", "Triage new issues", "Reconcile invoices"],
  },
  emptyRoutines: {
    heading: "No routines yet",
    explanation: "Routines run an agent on a schedule, like a daily summary of open tasks.",
    createButton: "New routine",
  },
  frameParts: {
    workingName: (agent) => `${agent}, working`,
    workingCaption: "A lit sigil is an agent in the middle of a run.",
    failedHeading: "The agents could not be loaded",
    failedExplanation: "Vanr could not be reached. Check your connection and try again.",
    retryButton: "Try again",
    bannerText: "Connection lost. Reconnecting.",
    bannerButton: "Reconnect now",
    drawerTrigger: "Open navigation",
    drawerName: "Workspace navigation",
    drawerLinks: ["Home", "Inbox", "Approvals", "Threads"],
    themeTrigger: "Theme",
    themeChoices: { system: "Same as the system", light: "Light", dark: "Dark" },
  },
  loadingSample: {
    threadsLoading: "Loading threads",
  },
  stateMatrix: {
    columnNames: {
      default: "Default",
      hover: "Hover",
      focus: "Focus",
      active: "Pressed",
      disabled: "Disabled",
      loading: "Loading",
      error: "Error",
    },
    notApplicable: "n/a",
    longTextHeading: "Long text",
    longSampleText:
      "Responsibilities, settings and follow-up for the automatic intercompany reconciliation notices",
  },
};

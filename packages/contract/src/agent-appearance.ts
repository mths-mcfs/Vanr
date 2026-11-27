// The closed option lists of an agent's appearance: body shape, mouth, and what goes on the face and neck.
// The server checks an appearance against them at the edge and clients offer them in the editor. Each list
// starts with the value an agent without that part is drawn with.

export type AgentBody = "box" | "bubble" | "cloud" | "round";
export type AgentMouth = "cat" | "grin" | "none" | "open" | "smile";
/** On the face and neck, next to the head's adornment. */
export type AgentExtra = "bowtie" | "glasses" | "monocle" | "mustache" | "none" | "scarf" | "shades" | "tie";

/** Speech-bubble shapes: speech, message box, thought, round. */
export const AGENT_BODIES = ["bubble", "box", "cloud", "round"] as const satisfies readonly AgentBody[];
export const AGENT_MOUTHS = ["none", "smile", "grin", "open", "cat"] as const satisfies readonly AgentMouth[];
export const AGENT_EXTRAS = [
  "none",
  "glasses",
  "shades",
  "monocle",
  "mustache",
  "bowtie",
  "tie",
  "scarf",
] as const satisfies readonly AgentExtra[];

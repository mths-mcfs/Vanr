// Types shared across areas.

export type ActorType = "agent" | "person";

/** A person (the member's userId) or an agent. Author of a message, assignee of an issue, author of a file. */
export interface ActorRef {
  id: string;
  type: ActorType;
}

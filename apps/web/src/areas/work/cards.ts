// The work area's pieces that live inside a conversation, for the chat area to mount: an assignment's panel
// beside its thread, and the cards an assignment puts under the messages that carry them. Each takes the
// workspace and the assignment; the cards also take what the person may do (`CardRights`, from the
// assignment's `actionable` and `role`).

export { AssignmentPanel } from "./assignments/Panel.tsx";
export {
  type CardRights,
  CommandCard,
  DecisionCard,
  ReviewCard,
  SubmissionCard,
  SuggestionActions,
} from "./cards/AssignmentCards.tsx";

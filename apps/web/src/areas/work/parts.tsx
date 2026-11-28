// The small states a part of a work screen draws while its own data loads or after it failed, so the
// rest of the screen stays usable.
import { Button, ErrorState, Skeleton } from "@vanr/ui";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";

/** A part of a screen whose data is on its way. */
export function PartLoading() {
  const common = useMessages("common");
  return (
    <div className="page__loading" aria-busy="true">
      <span className="vr-visually-hidden" role="status">
        {common("state.loading")}
      </span>
      <Skeleton shape="block" />
      <Skeleton />
    </div>
  );
}

/** A part of a screen that did not load: what, why, and a retry. */
export function PartError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const common = useMessages("common");
  const describe = useErrorMessage("work");
  return (
    <ErrorState
      title={title}
      description={describe(error)}
      action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
    />
  );
}

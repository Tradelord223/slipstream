import { useSortingDialog } from "../store/sorting.ts";
import { MoveMailDialog } from "./MoveMailDialog.tsx";
import { NewSplitDialog } from "./NewSplitDialog.tsx";

/** Whichever of the two conversation dialogs is open: move this sender's mail, or make a split from it. */
export function SortingDialogHost() {
  const open = useSortingDialog();
  if (!open) return null;
  return open.kind === "move" ? <MoveMailDialog key={open.threadId} threadId={open.threadId} /> : <NewSplitDialog key={open.threadId} threadId={open.threadId} />;
}

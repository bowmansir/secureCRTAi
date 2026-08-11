export type DialogKind = "prompt" | "confirm" | "approval";

export function shouldDismissDialogFromBackdrop(kind: DialogKind): boolean {
  return kind !== "approval";
}

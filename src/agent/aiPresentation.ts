export type AiPresentationWorkspaceKind =
  | "ssh"
  | "local"
  | "sftp"
  | "sftp-cli"
  | undefined;

export type AiPresentationState = {
  legacyPanelMounted: boolean;
  legacyPanelVisible: boolean;
  legacyPanelSuppressed: boolean;
  inlineTerminalEnabled: boolean;
};

export function resolveAiPresentation(
  legacyModeEnabled: boolean,
  activeKind: AiPresentationWorkspaceKind,
  legacyPanelMounted = legacyModeEnabled
): AiPresentationState {
  const legacyPanelSuppressed =
    activeKind === "sftp" || activeKind === "sftp-cli";
  return {
    legacyPanelMounted,
    legacyPanelVisible:
      legacyModeEnabled && legacyPanelMounted && !legacyPanelSuppressed,
    legacyPanelSuppressed,
    inlineTerminalEnabled: !legacyModeEnabled,
  };
}

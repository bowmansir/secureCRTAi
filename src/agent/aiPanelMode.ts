export function isAiPanelAgentModeEnabled(
  sessionId: string | undefined,
  override: boolean | undefined
): boolean {
  return Boolean(sessionId && override !== false);
}

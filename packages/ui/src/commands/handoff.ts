import { buildHandoffCommand, type SessionContext } from "@itz4blitz/ai-tools-sessions";
import { extractHandoffContext, previewHandoff } from "../widgets/handoff-panel.js";

export type HandoffResult = {
  context: SessionContext;
  preview: string;
  launchCommand: string | null;
  launchArgs: string[];
};

/**
 * Perform a full handoff: find session, extract context, format preview,
 * and optionally build a launch command for the target tool.
 */
export async function performHandoff(
  sessionId: string,
  targetTool?: string,
): Promise<HandoffResult | null> {
  const context = await extractHandoffContext(sessionId);
  if (!context) return null;

  const preview = previewHandoff(context);

  let launchCommand: string | null = null;
  let launchArgs: string[] = [];

  if (targetTool) {
    const built = buildHandoffCommand(targetTool, context.handoffMarkdown);
    if (built) {
      launchCommand = built.command;
      launchArgs = built.args;
    }
  }

  return {
    context,
    preview,
    launchCommand,
    launchArgs,
  };
}

import { createMarkdownAdapter } from "./markdown-adapter.js";

/**
 * Cline agent/workflow adapter.
 *
 * Cline's native markdown automation surface is `.clinerules/workflows/*.md`
 * (invoked via `/workflow-name` slash commands in Cline).
 */
const { Adapter: ClineAgentAdapter, adapter } = createMarkdownAdapter({
  id: "cline",
  name: "Cline",
  configDir: ".clinerules/workflows",
  command: "cline",
});

export { ClineAgentAdapter };
export default adapter;

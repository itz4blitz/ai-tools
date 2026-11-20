import { createMarkdownAdapter } from "./markdown-adapter.js";

const { Adapter: WindsurfAgentAdapter, adapter } = createMarkdownAdapter({
  id: "windsurf",
  name: "Windsurf",
  configDir: ".windsurf/agents",
  command: "windsurf",
});

export { WindsurfAgentAdapter };
export default adapter;

import { createMarkdownAdapter } from "./markdown-adapter.js";

const { Adapter: ContinueAgentAdapter, adapter } = createMarkdownAdapter({
  id: "continue",
  name: "Continue",
  configDir: ".continue/agents",
  command: "cn",
});

export { ContinueAgentAdapter };
export default adapter;

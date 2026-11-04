import { defineConfig, acceptanceHooks, builtinHooks } from "@itz4blitz/ai-tools-hooks";

export default defineConfig({
  // Start with built-in security hooks
  extends: [{ hooks: builtinHooks }],

  hooks: [...acceptanceHooks],

  settings: {
    logLevel: "warn",
    hookTimeout: 5000,
    failMode: "open",
  },
});

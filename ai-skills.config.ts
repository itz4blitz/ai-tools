import { defineConfig } from "@itz4blitz/ai-tools-skills";

export default defineConfig({
  skills: [
    {
      id: "add-adapter",
      name: "Add a new adapter",
      content: `Create a new tool adapter for the specified package and tool. Follow these steps exactly.

## 1. Determine the target

Ask which **package** (hooks, mcp, agents, skills, or rules) and which **AI tool** to add.

## 2. Study the reference adapter

Read the Claude Code adapter for the target package — it's always the most complete:
- \`packages/{package}/src/adapters/claude-code.ts\`
- \`packages/{package}/src/adapters/claude-code.test.ts\`

Also read \`packages/{package}/src/adapters/base.ts\` for the base class interface.

## 3. Create the adapter file

Create \`packages/{package}/src/adapters/{tool-name}.ts\`:

**For hooks adapters** (complex — event mapping required):
- Define \`EVENT_MAP: Record<string, string[]>\` mapping all 15 universal events to tool-native events (empty array for unsupported)
- Define \`REVERSE_MAP: Record<string, HookEventType[]>\` as the inverse
- Extend \`BaseAdapter\`, implement: \`id\`, \`name\`, \`version\`, \`capabilities\`, \`detect()\`, \`generate()\`, \`mapEvent()\`, \`mapNativeEvent()\`, \`uninstall()\`
- Use \`this.commandExists()\` and \`this.existsSync()\` from base class in \`detect()\`

**For mcp/agents/skills/rules adapters** (simpler — no event mapping):
- Extend the package's \`BaseAdapter\`
- Implement: \`id\`, \`name\`, \`version\`, \`detect()\`, \`generate()\`, \`install()\`
- For agents: consider using \`createMarkdownAdapter()\` factory from \`markdown-adapter.ts\`

End the file with self-registration:
\`\`\`typescript
const adapter = new MyToolAdapter();
registry.register(adapter);
export { MyToolAdapter };
export default adapter;
\`\`\`

## 4. Register in all.ts

Add \`import "./{tool-name}.js";\` to \`packages/{package}/src/adapters/all.ts\`.

## 5. Write tests

Create \`packages/{package}/src/adapters/{tool-name}.test.ts\` covering:
- Metadata: \`id\`, \`name\`, \`version\`
- Capabilities (hooks only): all flags, \`supportedEvents\`, \`blockableEvents\`
- \`mapEvent()\` / \`mapNativeEvent()\` (hooks only): every map entry + unknown events returning \`[]\`
- \`generate()\`: file paths, content format, deduplication, empty input, multi-event
- \`detect()\`: both found and not-found paths

Target 100% coverage. Use the Claude Code adapter test as template.

## 6. Verify

Run \`npm run check\` — must pass with 0 errors and 0 warnings.`,
    },
    {
      id: "release-prep",
      name: "Prepare for release",
      content: `Verify the codebase is ready for semantic-release on merge to master.

## Steps

1. Run \`npm run check\` — all four stages must pass (lint, format, typecheck, test)

2. Check recent commits follow conventional commit format (Angular preset):
   - \`feat:\` → minor release
   - \`fix:\`, \`perf:\`, \`refactor:\`, \`revert:\` → patch release
   - \`docs:\`, \`chore:\`, \`style:\`, \`test:\`, \`ci:\` → no release
   - \`BREAKING CHANGE:\` in footer → major release

3. Run \`npm run release:publish:dry\` to preview the \`@itz4blitz/ai-tools\` publish

4. Verify all internal workspace package.json files stay version-aligned with \`packages/cli/package.json\`

5. Check that \`scripts/sync-versions.js\`, \`scripts/vendor-cli-bundle.js\`, \`scripts/clean-cli-bundle.js\`, and \`scripts/run-semantic-release.js\` are intact and unmodified

Report the results: whether \`@itz4blitz/ai-tools\` is ready to publish, what version bump is expected, and any repo-side or npm-side blockers.`,
    },
    {
      id: "run-check",
      name: "Run full check pipeline",
      content: `Run \`npm run check\` which executes lint, format check, typecheck, and test in sequence.

If any stage fails:
1. Read the error output carefully
2. Fix the issue
3. Re-run only the failing stage to verify the fix
4. Run the full \`npm run check\` again to confirm everything passes

Do not stop until all four stages pass with zero errors and zero warnings.`,
    },
    {
      id: "acceptance-list",
      name: "Finish the whole feature",
      content: `Before editing, write \`.ai-tools/acceptance.json\` with \`version: 1\` and one item for each class: \`requested\`, \`empty\`, \`error\`, \`shared-state\`, \`regression\`. If you will touch UI, also add class \`ui\`.

Each item is \`{ "id", "class", "behavior", "passes": false }\`. \`behavior\` is an observable outcome, not a task name. Replace the \`REPLACE:\` placeholder. Do not set \`passes\` to true. Do not remove an item later. Do not write \`.ai-tools/acceptance-commands.json\`; the user owns the command prefix for each class.

A command proves an item only when it matches that prefix, exits 0, and its stdout contains \`acceptance:<id>\`. Put that id on the assertion that checks the behavior, not on a log line by itself. Do not stop while any item is open.`,
    },
  ],
});

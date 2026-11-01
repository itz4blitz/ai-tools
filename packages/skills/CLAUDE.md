# packages/skills

Skills/prompts configuration. The simplest content package — no metadata beyond name.

## Key Types (`types/definition.ts`)

`SkillDefinition`: `id`, `name`, `description?`, `content` (raw prompt text), `tags?`, `enabled?`, `sourceDir?`

Skills are just name + content. No model, tools, scope, or priority fields (contrast with agents and rules).

`sourceDir` points at a skill folder (SKILL.md plus scripts, references, prompts). Folder-based adapters (`BaseSkillAdapter.skillFolders`: Claude Code, Codex, Cursor, Grok, OpenCode, ZCode, Antigravity CLI) copy it verbatim; prompt-file adapters still use `content`. `loadSkillDirs(root)` turns a cloned skills repo into definitions.

## Markdown Format

Folder adapters write Agent Skills: `<dir>/<id>/SKILL.md` with `name`/`description` frontmatter. Prompt-file adapters write `<dir>/<id>.md`.

## Layers

`--layer=project` (default) resolves paths under cwd. `--layer=user` resolves under the home directory and uses `userConfigDir` when an adapter's user path differs (Codex: `.agents/skills`, OpenCode: `.config/opencode/skills`).

## CLI Commands

`detect`, `generate`, `install`, `import`, `sync`, `export`, `help` (no `init`).

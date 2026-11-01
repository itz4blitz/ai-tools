# [1.3.0](https://github.com/itz4blitz/ai-tools/compare/v1.2.3...v1.3.0) (2026-11-01)


### Features

* **skills:** user-layer skill install, skill folder copies, and Gemini CLI MCP fixes ([ba0e372](https://github.com/itz4blitz/ai-tools/commit/ba0e372d25bbbdc1e88e92988cbed79d6ecdad50))

## [1.2.3](https://github.com/itz4blitz/ai-tools/compare/v1.2.2...v1.2.3) (2026-09-06)


### Bug Fixes

* **ci:** stamp the release commit so GitHub does not show pending ([d58f253](https://github.com/itz4blitz/ai-tools/commit/d58f253eafb4efbacc9aca471c9c2aef9f58e3ab))

## [1.2.2](https://github.com/itz4blitz/ai-tools/compare/v1.2.1...v1.2.2) (2026-09-06)


### Bug Fixes

* **ci:** keep master HEAD green and write a usable README ([a906749](https://github.com/itz4blitz/ai-tools/commit/a9067491dcccf17c1f1d657ff4cb69eff0163dde))

## [1.2.1](https://github.com/itz4blitz/ai-tools/compare/v1.2.0...v1.2.1) (2026-09-06)


### Bug Fixes

* **ci:** harden published npm smoke and rewrite the README ([657a17d](https://github.com/itz4blitz/ai-tools/commit/657a17db93bf1d73b56e01037e43097ab6e3dba7))

# [1.2.0](https://github.com/itz4blitz/ai-tools/compare/v1.1.10...v1.2.0) (2026-09-06)


### Features

* **mcp:** native harness formats, scoped install, and PalamHealth leak guards ([dd53a13](https://github.com/itz4blitz/ai-tools/commit/dd53a138a9911750cd28b10ef3b12ad4785825f6))

## [Unreleased]

### Features

* **mcp:** Grok and ZCode adapters with native formats (`.grok/config.toml`, `.zcode/mcp.json`, `~/.zcode/cli/config.json`)
* **mcp:** `layer` and `whenPathContains` so PalamHealth servers stay project-local
* **mcp:** `audit` finds PalamHealth / interactive-1Password leaks in user-global configs
* **mcp:** `sync` installs from `mcp.config.ts` only and no longer union-copies imported servers between tools

### Bug Fixes

* **plugins:** host capability flags match actual adapters (zcode hooks true after the ZCode hook adapter landed; antigravity no longer claims missing MCP/hooks; add cline, droid, amp, continue, gemini-cli, roo-code)
* **plugins:** install honors `layer`/`whenPathContains` instead of copying every MCP server onto a host
* **cli:** canonical `install` records tool-directory targets instead of `targets: []`
* add an MIT `LICENSE` file to match the published badge

## [1.1.10](https://github.com/itz4blitz/ai-tools/compare/v1.1.9...v1.1.10) (2026-08-26)


### Bug Fixes

* **ci:** skip formatting the copied CLI README ([1aa5ded](https://github.com/itz4blitz/ai-tools/commit/1aa5ded2655a901fa9ed6ae0024af235133825c6))
* pin internal workspace deps to the release version ([54702ae](https://github.com/itz4blitz/ai-tools/commit/54702ae53d9785218cc6b7b040b1ec280b7b78d6))
* track CLI README so npmjs can render it ([3545712](https://github.com/itz4blitz/ai-tools/commit/354571215b1405c94d3209a2639a533260e0f1fe))

## [1.1.9](https://github.com/itz4blitz/ai-tools/compare/v1.1.8...v1.1.9) (2026-08-26)


### Bug Fixes

* **ci:** skip workspace reify during npm version ([196b350](https://github.com/itz4blitz/ai-tools/commit/196b35046373c518213fc401144ab277f4fe7a11))
* include README in the published npm package ([ef4637d](https://github.com/itz4blitz/ai-tools/commit/ef4637df4935a0b10d5c5c33034d68e93a473e5e))

## [1.1.8](https://github.com/itz4blitz/ai-tools/compare/v1.1.7...v1.1.8) (2026-02-14)


### Bug Fixes

* pin internal workspace deps to release version during publish ([9429701](https://github.com/itz4blitz/ai-tools/commit/942970183c940b80c623a0edfb0792fadb784df6))

## [1.1.7](https://github.com/itz4blitz/ai-tools/compare/v1.1.6...v1.1.7) (2026-02-14)


### Bug Fixes

* use globalThis singleton for adapter registry to survive module duplication ([48d3ae7](https://github.com/itz4blitz/ai-tools/commit/48d3ae70f75b0ea0e1a8a4b22849b9300e6fea1a))

## [1.1.6](https://github.com/itz4blitz/ai-tools/compare/v1.1.5...v1.1.6) (2026-02-14)


### Bug Fixes

* correct README tool table and remove staging URLs ([69b2c14](https://github.com/itz4blitz/ai-tools/commit/69b2c1458f4f0ee84762e0eb5af53bfc05bc77a8))

## [1.1.5](https://github.com/itz4blitz/ai-tools/compare/v1.1.4...v1.1.5) (2026-02-14)


### Bug Fixes

* read version at runtime instead of build-time define ([6a94951](https://github.com/itz4blitz/ai-tools/commit/6a9495150d97408b65ada407155ef5caf15123ce))

## [1.1.4](https://github.com/itz4blitz/ai-tools/compare/v1.1.3...v1.1.4) (2026-02-14)


### Bug Fixes

* resolve adapter registry singleton duplication and add dynamic versioning ([1c0941b](https://github.com/itz4blitz/ai-tools/commit/1c0941b39fd6b3f37ca92bf0164d6ca6c098c7b9))

## [1.1.3](https://github.com/itz4blitz/ai-tools/compare/v1.1.2...v1.1.3) (2026-02-14)


### Bug Fixes

* use OIDC trusted publisher for workspace publish auth ([3120dc8](https://github.com/itz4blitz/ai-tools/commit/3120dc8609d402e874c0db48ced568bca89cdf66))

## [1.1.2](https://github.com/itz4blitz/ai-tools/compare/v1.1.1...v1.1.2) (2026-02-14)


### Bug Fixes

* write npmrc at workspace root for publish auth ([2205d45](https://github.com/itz4blitz/ai-tools/commit/2205d45ee59c3b756cbf61c8705830795b547b04))

## [1.1.1](https://github.com/itz4blitz/ai-tools/compare/v1.1.0...v1.1.1) (2026-02-14)


### Bug Fixes

* write npmrc in package directory for workspace publish auth ([75b9f11](https://github.com/itz4blitz/ai-tools/commit/75b9f11dd89b028e3bd7b85418db98acd8aca305))

# [1.1.0](https://github.com/itz4blitz/ai-tools/compare/v1.0.7...v1.1.0) (2026-02-14)


### Features

* consolidate all adapters and CLI into single package ([91afad6](https://github.com/itz4blitz/ai-tools/commit/91afad6abf0dc399319f59f6c520ec15571ab202))

## [1.0.6](https://github.com/itz4blitz/ai-tools/compare/v1.0.5...v1.0.6) (2026-02-13)


### Bug Fixes

* remove --provenance from workspace publish script ([7bff7c8](https://github.com/itz4blitz/ai-tools/commit/7bff7c8e708fe58e7f2e88f637798b851b9b647e))

## [1.0.5](https://github.com/itz4blitz/ai-tools/compare/v1.0.4...v1.0.5) (2026-02-13)


### Bug Fixes

* add repository field to all packages for npm provenance ([020c3a2](https://github.com/itz4blitz/ai-tools/commit/020c3a28d6c8778af416a68930a72a7d4e510c77))

## [1.0.4](https://github.com/itz4blitz/ai-tools/compare/v1.0.3...v1.0.4) (2026-02-13)


### Bug Fixes

* add publishConfig access public to all scoped packages ([db9517b](https://github.com/itz4blitz/ai-tools/commit/db9517b308db6ceb51dc020532825be9f7e339bd))

## [1.0.3](https://github.com/itz4blitz/ai-tools/compare/v1.0.2...v1.0.3) (2026-02-13)


### Bug Fixes

* add public access for scoped npm package publishing ([0eff601](https://github.com/itz4blitz/ai-tools/commit/0eff6015988ad2b404d2e1ca3732764b1aef7040))

## [1.0.2](https://github.com/itz4blitz/ai-tools/compare/v1.0.1...v1.0.2) (2026-02-13)


### Bug Fixes

* update npm automation token for CI publishing ([91d0c76](https://github.com/itz4blitz/ai-tools/commit/91d0c76bde10c58422fc826fca6cc688452af6d6))

## [1.0.1](https://github.com/itz4blitz/ai-tools/compare/v1.0.0...v1.0.1) (2026-02-13)


### Bug Fixes

* clean up duplicate changelog entries from failed publish runs ([d4a96ae](https://github.com/itz4blitz/ai-tools/commit/d4a96aed4c144b6a9a860278328bc93bd87a4e39))

# 1.0.0 (2026-02-13)

### Features

* ai-hooks framework v1.0.0 ([17cf1af](https://github.com/itz4blitz/ai-tools/commit/17cf1af98e653183a98abe5ba7d07c051b66a7eb))
* add Cline adapter, remove adapters for tools without native hooks ([b18f45e](https://github.com/itz4blitz/ai-tools/commit/b18f45ed80d29f65235c3ff8dc4dff4eb8abd75e))

### Bug Fixes

* fetch full git history in publish job for semantic-release ([0df474a](https://github.com/itz4blitz/ai-tools/commit/0df474a817a5b155b8c9d5899ed1050fdaad05b5))

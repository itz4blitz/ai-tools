import type { SkillDefinition } from "./definition.js";

export type SkillsConfig = {
  skills: SkillDefinition[];
};

/** "project" writes under the working directory; "user" writes under the home directory. */
export type SkillLayer = "project" | "user";

export type GeneratedFile = {
  path: string;
  content: string;
  format: "md" | "json" | "yaml";
  /** When set, install copies this file instead of writing `content`. */
  sourcePath?: string;
};

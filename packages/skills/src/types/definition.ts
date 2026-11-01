export type SkillDefinition = {
  id: string;
  name: string;
  description?: string;
  content: string;
  tags?: string[];
  enabled?: boolean;
  /** Skill folder (SKILL.md plus supporting files). Folder-based adapters copy it verbatim. */
  sourceDir?: string;
};

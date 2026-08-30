export type SkillSource = 'builtin' | 'project' | 'user' | 'imported';

export type SkillTrigger = 'implicit' | 'explicit';

export type SkillAction = 'listed' | 'read' | 'activated' | 'deactivated';

export type SkillFrontmatter = {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  allowImplicitInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  paths?: string[];
  tags?: string[];
};

export type SkillDefinition = {
  name: string;
  description: string;
  source: SkillSource;
  rootPath: string;
  skillFilePath: string;
  content: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  tags: string[];
  filePatterns: string[];
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  missingCapabilities: string[];
  shadowed: boolean;
  usage: {
    readCount: number;
    activationCount: number;
    lastUsedAt: string | null;
  };
};

export type SkillSummary = Omit<SkillDefinition, 'content'>;

export type SkillConfig = {
  disabledSkills?: string[];
};

export type ExplicitSkillInvocation = {
  name: string;
  raw: string;
  argumentsText: string;
};

export type SkillUsage = {
  name: string;
  trigger: SkillTrigger;
  action: SkillAction;
  reason?: string;
  at: string;
};

export type SkillReadResult =
  | {
      ok: true;
      skill: {
        name: string;
        description: string;
        source: SkillSource;
        content: string;
        rootPath: string;
        skillFilePath: string;
      };
    }
  | { ok: false; error: string };

export type SkillActivationResult =
  | { ok: true; skill: string; trigger: SkillTrigger; reason?: string }
  | { ok: false; error: string };

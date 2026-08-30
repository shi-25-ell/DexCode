export type TemplateFile = {
  path: string;
  content: string;
};

export type TemplateOption = {
  name: string;
  value: string;
  type: string;
};

export type TemplateDefinition = {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "backend" | "fullstack" | "api" | "cli";
  language: "javascript" | "typescript" | "python" | "java" | "go" | "rust";
  framework?: string;
  version?: string;
  files: TemplateFile[];
  options?: {
    name?: TemplateOption[];
    framework?: TemplateOption[];
    styling?: TemplateOption[];
    testing?: TemplateOption[];
    [key: string]: TemplateOption[] | undefined;
  };
};

export type TemplateParams = {
  projectName: string;
  templateId: string;
  author?: string;
  description?: string;
  [key: string]: string | undefined;
};

export type GeneratedProject = {
  files: TemplateFile[];
  summary: string;
  scaffoldInfo: {
    projectName: string;
    templateId: string;
    templateName: string;
    fileCount: number;
  };
};

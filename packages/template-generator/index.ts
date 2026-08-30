import type {
  TemplateDefinition,
  TemplateFile,
  TemplateParams,
  GeneratedProject,
} from "./types.ts";
import {
  getTemplate,
  listTemplates,
  listTemplatesByCategory,
} from "./templates.ts";

/**
 * 模板生成器 - 负责渲染模板和生成项目文件
 */
export function createTemplateGenerator() {
  /**
   * 替换文件内容中的占位符
   */
  function renderContent(content: string, params: TemplateParams): string {
    let rendered = content;

    // 替换基础占位符
    rendered = rendered.replace(/{{projectName}}/g, params.projectName);

    if (params.author) {
      rendered = rendered.replace(/{{author}}/g, params.author);
    }

    if (params.description) {
      rendered = rendered.replace(/{{description}}/g, params.description);
    }

    // 替换自定义参数
    Object.entries(params).forEach(([key, value]) => {
      if (
        value !== undefined &&
        !["projectName", "templateId", "author", "description"].includes(key)
      ) {
        const placeholder = `{{${key}}}`;
        rendered = rendered.replace(new RegExp(placeholder, "g"), value);
      }
    });

    return rendered;
  }

  /**
   * 渲染模板文件路径中的占位符
   */
  function renderPath(path: string, params: TemplateParams): string {
    let rendered = path;
    rendered = rendered.replace(/{{projectName}}/g, params.projectName);

    Object.entries(params).forEach(([key, value]) => {
      if (
        value !== undefined &&
        !["projectName", "templateId", "author", "description"].includes(key)
      ) {
        const placeholder = `{{${key}}}`;
        rendered = rendered.replace(new RegExp(placeholder, "g"), value);
      }
    });

    return rendered;
  }

  /**
   * 生成项目文件
   */
  function generateProject(
    templateId: string,
    params: TemplateParams,
  ): GeneratedProject {
    const template = getTemplate(templateId);
    if (!template) {
      throw new Error(`模板 "${templateId}" 不存在`);
    }

    const files: TemplateFile[] = template.files.map((file) => ({
      path: renderPath(file.path, params),
      content: renderContent(file.content, params),
    }));

    return {
      files,
      summary: `已生成 ${files.length} 个文件的 ${template.name} 项目骨架`,
      scaffoldInfo: {
        projectName: params.projectName,
        templateId: templateId,
        templateName: template.name,
        fileCount: files.length,
      },
    };
  }

  /**
   * 获取模板列表
   */
  function getTemplateList() {
    return listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      language: t.language,
      framework: t.framework,
      version: t.version,
    }));
  }

  /**
   * 获取指定类别的模板
   */
  function getTemplatesByCategory(category: string) {
    return listTemplatesByCategory(category).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      language: t.language,
      framework: t.framework,
      version: t.version,
    }));
  }

  /**
   * 获取单个模板详情
   */
  function getTemplateDetail(templateId: string) {
    const template = getTemplate(templateId);
    if (!template) {
      return null;
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      language: template.language,
      framework: template.framework,
      version: template.version,
      fileCount: template.files.length,
      options: template.options,
    };
  }

  return {
    generateProject,
    getTemplateList,
    getTemplatesByCategory,
    getTemplateDetail,
  };
}

export type TemplateGenerator = ReturnType<typeof createTemplateGenerator>;

import type { ApprovalEffect } from '../shared/types.ts';
import { validateJsonSchema, type JsonSchema } from '../shared/json-schema.ts';
import { DIRECTORY_LIMITS, GREP_LIMITS, READ_FILE_LIMITS } from './tool-limits.ts';

export type CodingToolName =
  | 'find'
  | 'ls'
  | 'list_workspace'
  | 'read_file'
  | 'grep'
  | 'run_command'
  | 'patch_file'
  | 'write_file'
  | 'read_command_output'
  | 'stop_command';

export type CodingToolSpec = {
  name: CodingToolName;
  description: string;
  inputSchema: JsonSchema;
  effect: ApprovalEffect;
  presentation: {
    category: 'read' | 'search' | 'file' | 'command';
    label: string;
    batch: 'inspection' | 'modification' | 'command';
  };
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const pathProperty = { type: 'string', minLength: 1, description: '相对工作区根目录的路径' };

const PATCH_INPUT_SCHEMA = {
  type: 'object',
  oneOf: [
    objectSchema({
      path: pathProperty,
      mode: { type: 'string', const: 'targeted' },
      edits: {
        type: 'array',
        minItems: 1,
        items: objectSchema({
          old_text: { type: 'string', minLength: 1 },
          new_text: { type: 'string' },
        }, ['old_text', 'new_text']),
      },
    }, ['path', 'mode', 'edits']),
    objectSchema({
      path: pathProperty,
      mode: { type: 'string', const: 'replace_all' },
      old_text: { type: 'string', minLength: 1 },
      new_text: { type: 'string' },
      expected_occurrences: { type: 'integer', minimum: 1 },
    }, ['path', 'mode', 'old_text', 'new_text', 'expected_occurrences']),
  ],
} satisfies Record<string, unknown>;

export function codingToolSpecs(options: { shellDescription?: string } = {}): CodingToolSpec[] {
  const shellDescription = options.shellDescription ?? '当前 Runtime 选择的 PowerShell';
  return [
    {
      name: 'find',
      description: `按 glob 递归查找工作区路径。返回稳定排序的相对路径，不读取文件正文，并遵守 ignore 规则。默认最多 ${DIRECTORY_LIMITS.findDefaultResults} 项，调用上限 ${DIRECTORY_LIMITS.findMaxResults} 项，总输出上限 ${DIRECTORY_LIMITS.maxBytes / 1024}KB。`,
      inputSchema: objectSchema({
        pattern: { type: 'string', minLength: 1 },
        path: pathProperty,
        limit: { type: 'integer', minimum: 1, maximum: DIRECTORY_LIMITS.findMaxResults, description: `结果上限，默认 ${DIRECTORY_LIMITS.findDefaultResults}` },
      }, ['pattern']),
      effect: 'read',
      presentation: { category: 'search', label: '查找路径', batch: 'inspection' },
    },
    {
      name: 'ls',
      description: `列出工作区内一个目录的直接子项，不递归、不读取文件正文，并包含普通隐藏项。默认最多 ${DIRECTORY_LIMITS.lsDefaultEntries} 项，调用上限 ${DIRECTORY_LIMITS.lsMaxEntries} 项，总输出上限 ${DIRECTORY_LIMITS.maxBytes / 1024}KB。`,
      inputSchema: objectSchema({
        path: pathProperty,
        limit: { type: 'integer', minimum: 1, maximum: DIRECTORY_LIMITS.lsMaxEntries, description: `结果上限，默认 ${DIRECTORY_LIMITS.lsDefaultEntries}` },
      }),
      effect: 'read',
      presentation: { category: 'read', label: '浏览目录', batch: 'inspection' },
    },
    {
      name: 'list_workspace',
      description: `返回工作区递归树形结构概览，不包含文件正文。默认及最大深度 ${DIRECTORY_LIMITS.maxDepth}，最多 ${DIRECTORY_LIMITS.maxNodes} 个节点、${DIRECTORY_LIMITS.maxBytes / 1024}KB；可用 depth 缩小输出。`,
      inputSchema: objectSchema({ depth: { type: 'integer', minimum: 1, maximum: DIRECTORY_LIMITS.maxDepth, description: `递归深度，默认 ${DIRECTORY_LIMITS.maxDepth}` } }),
      effect: 'read',
      presentation: { category: 'read', label: '浏览项目结构', batch: 'inspection' },
    },
    {
      name: 'read_file',
      description: `按行读取工作区文本文件的最新磁盘内容。offset 是从 1 开始的起始行，limit 是最多读取行数；默认和单次最多 ${READ_FILE_LIMITS.maxLines} 行，同时受 ${READ_FILE_LIMITS.maxBytes / 1024}KB 上限约束。结果截断时使用 next_offset 继续。修改已有文件前先读取。`,
      inputSchema: objectSchema({
        path: pathProperty,
        offset: { type: 'integer', minimum: 1, description: '从 1 开始的起始行，默认 1' },
        limit: { type: 'integer', minimum: 1, maximum: READ_FILE_LIMITS.maxLines, description: `最多读取行数，默认且最大 ${READ_FILE_LIMITS.defaultLines}` },
      }, ['path']),
      effect: 'read',
      presentation: { category: 'read', label: '读取文件', batch: 'inspection' },
    },
    {
      name: 'grep',
      description: '使用 ripgrep 搜索当前磁盘文件内容。pattern 默认是正则；可选字面量、大小写、glob、上下文和结果上限。',
      inputSchema: objectSchema({
        pattern: { type: 'string', minLength: 1 },
        path: pathProperty,
        glob: { type: 'string', minLength: 1 },
        ignoreCase: { type: 'boolean' },
        literal: { type: 'boolean' },
        context: { type: 'integer', maximum: GREP_LIMITS.maxContextLines, description: `匹配前后上下文行数，默认 0；负数按 0 处理，最大 ${GREP_LIMITS.maxContextLines}` },
        limit: { type: 'integer', maximum: GREP_LIMITS.maxMatches, description: `最大匹配数，默认 ${GREP_LIMITS.defaultMatches}；小于 1 按 1 处理，最大 ${GREP_LIMITS.maxMatches}` },
      }, ['pattern']),
      effect: 'read',
      presentation: { category: 'search', label: '搜索代码', batch: 'inspection' },
    },
    {
      name: 'run_command',
      description: `在工作区中使用 ${shellDescription} 执行完整脚本，支持其原生管道、变量、复合语句和重定向。不会猜测或静默切换 shell；可前台等待或转入后台。`,
      inputSchema: objectSchema({
        command: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'integer', minimum: 1_000, maximum: 600_000 },
        run_in_background: { type: 'boolean' },
      }, ['command']),
      effect: 'execute',
      presentation: { category: 'command', label: '执行命令', batch: 'command' },
    },
    {
      name: 'patch_file',
      description: '严格、原子化地修改已有文件。targeted 要求每个 old_text 精确命中一次；replace_all 要求实际命中数等于 expected_occurrences。',
      inputSchema: PATCH_INPUT_SCHEMA,
      effect: 'write',
      presentation: { category: 'file', label: '修改文件', batch: 'modification' },
    },
    {
      name: 'write_file',
      description: '新建文件或有意识地整体覆盖文件。局部修改已有文件优先使用 patch_file。',
      inputSchema: objectSchema({ path: pathProperty, content: { type: 'string' } }, ['path', 'content']),
      effect: 'write',
      presentation: { category: 'file', label: '写入文件', batch: 'modification' },
    },
    {
      name: 'read_command_output',
      description: '读取后台命令的增量或最终输出，可短暂等待其完成。',
      inputSchema: objectSchema({
        task_id: { type: 'string', minLength: 1 },
        wait_ms: { type: 'integer', minimum: 0, maximum: 60_000 },
      }, ['task_id']),
      effect: 'read',
      presentation: { category: 'command', label: '读取命令输出', batch: 'command' },
    },
    {
      name: 'stop_command',
      description: '停止一个仍在运行的后台命令及其进程树。',
      inputSchema: objectSchema({ task_id: { type: 'string', minLength: 1 } }, ['task_id']),
      effect: 'execute',
      presentation: { category: 'command', label: '停止命令', batch: 'command' },
    },
  ];
}

export const ACTIVE_CODING_TOOL_NAMES = codingToolSpecs().map((spec) => spec.name);
const DEFAULT_SPECS = new Map(codingToolSpecs().map((spec) => [spec.name, spec] as const));

export function isCodingToolName(value: string): value is CodingToolName {
  return DEFAULT_SPECS.has(value as CodingToolName);
}

export function codingToolSpec(name: string): CodingToolSpec | undefined {
  return DEFAULT_SPECS.get(name as CodingToolName);
}

export function validateCodingToolInput(name: string, input: unknown): string | null {
  const spec = codingToolSpec(name);
  return spec ? validateJsonSchema(input, spec.inputSchema) : `unknown or disabled tool: ${name}`;
}

export function agentCodingToolDefinitions(options: { shellDescription?: string } = {}) {
  return codingToolSpecs(options).map((spec) => ({
    type: 'function' as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  }));
}

import { DEFAULT_AGENT_DEFINITION_NAME } from '../agent-manager/contracts.ts';
import { agentCodingToolDefinitions } from '../tool-gateway/tool-registry.ts';

/** Agent 可见的第一方编程工具全部由权威 registry 投影。 */
export const LOCAL_TOOL_DEFINITIONS = agentCodingToolDefinitions();

export const SKILL_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_skills',
      description: '列出当前可用 Skill 摘要，包括名称、描述、来源和启用状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_skill',
      description: '在使用某个 Skill 前读取完整 SKILL.md 指南。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'activate_skill',
      description: '确认本任务使用某个 Skill，并记录触发方式和原因。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          trigger: { type: 'string', enum: ['implicit', 'explicit'] },
          reason: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'deactivate_skill',
      description: '停止在当前任务中使用某个 Skill。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
];

export const CONTEXT_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_artifact',
      description: '按不透明引用分页读取已安全保存的上下文内容。只可读取当前会话中的引用。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number', description: '单次最多 32000 字符' },
        },
        required: ['ref'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'compact_context',
      description: '阶段结束且后续只需要状态摘要时，请求整理较早对话。当前工具批次完成后生效。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

const SPAWN_AGENT_DESCRIPTION = `Start a persistent child agent asynchronously for a bounded task. After spawning, choose the coordination mode that fits the task: use wait_agent with block=true for a foreground synchronization barrier when the current user request depends on the child result, or continue independent work and finish the current Main Run for background delivery. Foreground waits yield when a user Steer arrives; background completions are delivered automatically in a later Main Run. Do not tight-poll. Use context_mode=fresh for self-contained work that does not need the current conversation; use context_mode=fork when the child needs a bounded snapshot of the main agent's current context. A fork is copied once and parent and child continue independently. Omit context_mode to use the selected agent definition's default. Omit agent to use ${DEFAULT_AGENT_DEFINITION_NAME}.`;
const CONTEXT_MODE_DESCRIPTION = "Optional context strategy. fresh starts from the child agent's own system, workspace, memory, and task context without the main conversation. fork additionally copies a bounded snapshot of the main agent's current context; use it when prior discussion or findings are needed. The snapshot is copied once, so parent and child continue independently. Omit to use the selected agent definition's default.";

export const AGENT_ORCHESTRATION_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'spawn_agent',
      description: SPAWN_AGENT_DESCRIPTION,
      parameters: {
        type: 'object', additionalProperties: false, required: ['task'],
        properties: {
          task: { type: 'string', minLength: 1 },
          agent: { type: 'string', minLength: 1, default: DEFAULT_AGENT_DEFINITION_NAME, description: `Optional specialized agent type. Omit to use ${DEFAULT_AGENT_DEFINITION_NAME}.` },
          context_mode: { type: 'string', enum: ['fresh', 'fork'], description: CONTEXT_MODE_DESCRIPTION }, name: { type: 'string' },
          isolation: { type: 'string', enum: ['shared', 'worktree'] },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wait_agent',
      description: 'Inspect current child-agent Run status or explicitly wait in the foreground. block defaults to false and returns immediately. Use block=true for a synchronization barrier when this Main Run needs the result. A foreground wait yields early when a user Steer arrives: only the wait is cancelled, while the Main Run and Child Runs remain active; handle the Steer, then decide whether to wait again. A timeout is normal. Do not tight-poll. If the Main Run ends instead, Child completion is delivered automatically in a later Main Run.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['agent_ids'],
        properties: {
          agent_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          mode: { type: 'string', enum: ['any', 'all'] },
          block: { type: 'boolean', default: false },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'followup_agent',
      description: 'Start a new asynchronous Run for an existing idle child agent using its retained conversation and policy snapshot. Then choose foreground wait_agent(block=true) or background delivery using the same task-dependent coordination rule as spawn_agent.',
      parameters: { type: 'object', additionalProperties: false, required: ['agent_id', 'task'], properties: { agent_id: { type: 'string' }, task: { type: 'string', minLength: 1 } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'stop_agent',
      description: 'Interrupt the current Run of a child agent without deleting its identity or conversation.',
      parameters: { type: 'object', additionalProperties: false, required: ['agent_id'], properties: { agent_id: { type: 'string' }, reason: { type: 'string' } } },
    },
  },
] as const;

export function agentOrchestrationToolDefinitions(agents: Array<{ name: string; description: string }>) {
  if (agents.length === 0) return [...AGENT_ORCHESTRATION_TOOL_DEFINITIONS];
  const names = agents.map((agent) => agent.name);
  const descriptions = agents.map((agent) => `${agent.name}: ${agent.description}`).join('; ');
  return AGENT_ORCHESTRATION_TOOL_DEFINITIONS.map((tool) => tool.function.name !== 'spawn_agent' ? tool : ({
    ...tool,
    function: {
      ...tool.function,
      description: `${SPAWN_AGENT_DESCRIPTION} Available agent definitions: ${descriptions}`,
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          agent: { type: 'string', enum: names, default: DEFAULT_AGENT_DEFINITION_NAME, description: `Optional specialized agent type. Omit to use ${DEFAULT_AGENT_DEFINITION_NAME}. Available agent definitions: ${descriptions}` },
        },
      },
    },
  }));
}

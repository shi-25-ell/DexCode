export type CapabilityId = 'mcp' | 'tools' | 'skills' | 'approval' | 'project-knowledge' | 'memory' | 'subagents';

export type CapabilityDefinition = {
  id: CapabilityId;
  label: string;
  route: string;
  icon: 'network' | 'wrench' | 'sparkles' | 'shield' | 'book' | 'brain' | 'bot';
  workspaceRequired: boolean;
};

const DEFAULT_CAPABILITIES: readonly CapabilityDefinition[] = [
  { id: 'mcp', label: 'MCP', route: '/settings/mcp', icon: 'network', workspaceRequired: false },
  { id: 'skills', label: 'Skill', route: '/settings/skills', icon: 'sparkles', workspaceRequired: true },
  { id: 'approval', label: '批准模式', route: '/settings/approval', icon: 'shield', workspaceRequired: false },
  { id: 'project-knowledge', label: '项目知识', route: '/settings/project-knowledge', icon: 'book', workspaceRequired: true },
  { id: 'memory', label: '记忆', route: '/settings/memory', icon: 'brain', workspaceRequired: true },
  { id: 'subagents', label: '子智能体', route: '/settings/subagents', icon: 'bot', workspaceRequired: false },
];

export function createCapabilityRegistry(options: { disabled?: Iterable<string> } = {}) {
  const disabled = new Set(options.disabled ?? []);
  const definitions = DEFAULT_CAPABILITIES.filter((item) => !disabled.has(item.id));
  return {
    list(): CapabilityDefinition[] {
      return definitions.map((item) => ({ ...item }));
    },
    has(id: string): id is CapabilityId {
      return definitions.some((item) => item.id === id);
    },
  };
}

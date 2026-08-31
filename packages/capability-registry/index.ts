export type CapabilityId = 'mcp' | 'tools' | 'skills' | 'approval' | 'snapshots' | 'project-knowledge';

export type CapabilityDefinition = {
  id: CapabilityId;
  label: string;
  route: string;
  icon: 'network' | 'wrench' | 'sparkles' | 'shield' | 'camera' | 'book';
  workspaceRequired: boolean;
};

const DEFAULT_CAPABILITIES: readonly CapabilityDefinition[] = [
  { id: 'mcp', label: 'MCP', route: '/settings/mcp', icon: 'network', workspaceRequired: false },
  { id: 'tools', label: '工具', route: '/settings/tools', icon: 'wrench', workspaceRequired: true },
  { id: 'skills', label: 'Skill', route: '/settings/skills', icon: 'sparkles', workspaceRequired: true },
  { id: 'approval', label: '批准模式', route: '/settings/approval', icon: 'shield', workspaceRequired: false },
  { id: 'snapshots', label: '快照', route: '/settings/snapshots', icon: 'camera', workspaceRequired: true },
  { id: 'project-knowledge', label: '项目知识', route: '/settings/project-knowledge', icon: 'book', workspaceRequired: true },
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

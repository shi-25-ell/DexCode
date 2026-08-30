const SUPPORTED_CAPABILITIES = new Set([
  'read_file',
  'write_file',
  'patch_file',
  'search_in_workspace',
  'run_command',
  'ask_user',
  'mcp',
]);

export function inferCapabilities(content: string, allowedTools: string[] = []) {
  const text = `${content}\n${allowedTools.join(' ')}`.toLowerCase();
  const required = new Set<string>();
  const optional = new Set<string>();

  if (/\bread\b|read_file|file access/.test(text)) required.add('read_file');
  if (/write_file|\bwrite\b|\bedit\b|patch_file/.test(text)) optional.add('patch_file');
  if (/search|grep|rg|find/.test(text)) optional.add('search_in_workspace');
  if (/shell|bash|powershell|command|run_command|npm|git /.test(text)) optional.add('run_command');
  if (/mcp/.test(text)) optional.add('mcp');

  const requiredCapabilities = [...required];
  const optionalCapabilities = [...optional].filter((item) => !required.has(item));
  const missingCapabilities = [...required, ...optional].filter((item) => !SUPPORTED_CAPABILITIES.has(item));

  return {
    requiredCapabilities,
    optionalCapabilities,
    missingCapabilities,
  };
}

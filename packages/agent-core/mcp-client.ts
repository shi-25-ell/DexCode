import type { McpServer } from '../mcp-server/index.ts';

export type McpToolClient = {
  callTool: McpServer['callTool'];
};

export function createMcpClient(mcp: McpServer): McpToolClient {
  return {
    callTool: mcp.callTool,
  };
}

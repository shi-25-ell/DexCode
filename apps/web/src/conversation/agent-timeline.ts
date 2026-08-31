import type { AgentRunView, AgentTreeSnapshot } from '../types';

export type AgentTimelineGroup = {
  key: string;
  agentRunIds: string[];
  sourceRunId: string;
  sourceTurn?: number;
};

function legacyDelegationGroupId(tree: AgentTreeSnapshot, run: AgentRunView): string | undefined {
  if (run.trigger !== 'spawn') return undefined;
  return (tree.agents.find((agent) => agent.agentId === run.agentId) as (typeof tree.agents)[number] & { delegationGroupId?: string } | undefined)?.delegationGroupId;
}

function sourceTurn(run: AgentRunView, groupId?: string): number | undefined {
  if (Number.isInteger(run.invokedByTurn) && run.invokedByTurn! > 0) return run.invokedByTurn;
  const legacy = groupId?.match(/-(\d+)$/)?.[1];
  return legacy ? Number(legacy) : undefined;
}

export function groupAgentTimeline(tree: AgentTreeSnapshot | null): AgentTimelineGroup[] {
  if (!tree) return [];
  const groups = new Map<string, AgentRunView[]>();
  for (const run of tree.runs) {
    const key = run.delegationGroupId ?? legacyDelegationGroupId(tree, run) ?? `agent-run:${run.agentRunId}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups].map(([key, runs]) => {
    const turn = sourceTurn(runs[0]!, key.startsWith('agent-run:') ? undefined : key);
    return {
      key,
      agentRunIds: runs.map((run) => run.agentRunId),
      sourceRunId: runs[0]!.invokedByRunId,
      ...(turn !== undefined ? { sourceTurn: turn } : {}),
    };
  });
}

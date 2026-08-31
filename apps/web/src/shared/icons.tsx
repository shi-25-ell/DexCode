import type { ComponentType } from 'react';
import {
  BookOpen,
  Camera,
  CircleAlert,
  CircleCheck,
  CircleStop,
  FileCode2,
  FolderSearch2,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import type { Capability, ToolPresentation } from '../types';

export const capabilityIcons: Record<Capability['icon'], ComponentType<{ size?: number; strokeWidth?: number }>> = {
  network: Network,
  wrench: Wrench,
  sparkles: Sparkles,
  shield: ShieldCheck,
  book: BookOpen,
};

export const toolIcons: Record<ToolPresentation['category'], ComponentType<{ size?: number; strokeWidth?: number }>> = {
  read: FileCode2,
  file: FileCode2,
  command: TerminalSquare,
  search: Search,
  skill: Sparkles,
  mcp: Network,
  snapshot: Camera,
  other: Wrench,
};

export const statusIcons = {
  succeeded: CircleCheck,
  queued: FolderSearch2,
  running: FolderSearch2,
  failed: CircleAlert,
  denied: CircleStop,
  cancelled: CircleStop,
};

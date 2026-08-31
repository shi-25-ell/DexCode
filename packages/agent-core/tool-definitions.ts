/** Agent 可见的本地工具定义（含详细描述，减少 LLM 误用） */

export const LOCAL_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        '读取工作区文件全文。修改前务必先 read_file 获取最新内容。示例：{"path":"src/app.ts"}',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区根目录的路径' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        '整文件写入或新建。仅用于新文件或大范围重写；修改已有文件优先 patch_file。示例：{"path":"a.ts","content":"..."}',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'patch_file',
      description:
        '局部替换。格式：1) before\\n---\\nafter；2) before => after；3) unified diff；4) @@ line 42 行号锚点+替换块。失败时 read_file 核对原文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'string' },
        },
        required: ['path', 'patch'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_in_workspace',
      description:
        '正则/文本搜索，返回路径、行号、片段。定位符号或配置时优先使用。示例：{"query":"createServer","path":"apps"}',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: '可选，限定子目录' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description:
        '在工作区执行 shell 命令。可设置前台等待超时，超时后任务继续在后台运行；也可立即后台运行。非白名单会等待用户确认。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', minimum: 1000, maximum: 600000, description: '前台等待时间；到期后返回 task_id，命令继续在后台运行' },
          run_in_background: { type: 'boolean', description: '为 true 时立即返回后台 task_id' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_command_output',
      description: '读取后台命令的当前输出和状态；可短暂等待其完成。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          wait_ms: { type: 'number', minimum: 0, maximum: 60000 },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'stop_command',
      description: '停止一个仍在运行的后台命令。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_lints',
      description:
        '只读 lint/tsc 检查，无需用户确认。示例：{"path":"src/app.ts"} 或 {} 检查全项目。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'diff_file',
      description:
        '对比文件与版本快照差异（+/- 行）。需先 create_snapshot。示例：{"path":"src/app.ts","snapshotId":"v001"}',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          snapshotId: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_workspace',
      description: '列出工作区文件树结构，不确定路径时先调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_user',
      description: '暂停并询问用户（破坏性操作或不确定决策）。不要用于普通命令确认（run_command 会自动确认）。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_versions',
      description: '列出工作区版本快照，供 diff_file / restore_snapshot 使用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_snapshot',
      description: '创建可回滚快照。大改前建议先快照。示例：{"name":"before-refactor","description":"..."}',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'restore_snapshot',
      description: '从快照恢复整个工作区（破坏性）。恢复前应用 create_snapshot 备份。',
      parameters: {
        type: 'object',
        properties: { snapshotId: { type: 'string' } },
        required: ['snapshotId'],
        additionalProperties: false,
      },
    },
  },
];

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

export const AGENT_ORCHESTRATION_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'spawn_agent',
      description: 'Start a persistent child agent asynchronously for a bounded task.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['task', 'agent'],
        properties: {
          task: { type: 'string', minLength: 1 }, agent: { type: 'string', minLength: 1 },
          context_mode: { type: 'string', enum: ['fresh', 'fork'] }, name: { type: 'string' },
          isolation: { type: 'string', enum: ['shared', 'worktree'] },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wait_agent',
      description: 'Wait for the current Runs of one or more child agents. A timeout is a normal result.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['agent_ids'],
        properties: {
          agent_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          mode: { type: 'string', enum: ['any', 'all'] },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 60000 },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'followup_agent',
      description: 'Start a new Run for an existing idle child agent using its retained conversation and policy snapshot.',
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

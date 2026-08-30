import { createInterface } from 'node:readline';

let initialized = false;
let ready = false;

function respond(id, payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    if (initialized) {
      respond(message.id, { error: { code: -32002, message: 'duplicate initialize' } });
      return;
    }
    initialized = true;
    respond(message.id, {
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') {
    ready = initialized;
    return;
  }

  if (message.method === 'tools/list') {
    if (!ready) {
      respond(message.id, { error: { code: -32002, message: 'tools/list before initialization' } });
      return;
    }
    respond(message.id, {
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes input',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }

  if (message.method === 'tools/call') {
    if (!ready) {
      respond(message.id, { error: { code: -32002, message: 'tools/call before initialization' } });
      return;
    }
    respond(message.id, {
      result: {
        content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }],
      },
    });
  }
});

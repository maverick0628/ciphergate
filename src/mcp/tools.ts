export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export function createMcpTools(): McpToolDefinition[] {
  return [
    {
      name: 'get_secret',
      description: 'Retrieve a secret value by name from the secrets gateway',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The secret name (e.g., OPENAI_API_KEY)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'list_secrets',
      description: 'List all secrets accessible to this consumer, with optional tag filter',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Optional tag to filter secrets' },
        },
      },
    },
    {
      name: 'get_env',
      description: 'Generate environment variable block for a set of secrets',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          names: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'rotation_report',
      description: 'Show which secrets are due or overdue for rotation',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

export async function handleToolCall(
  toolName: string,
  args: Record<string, any>,
  gatewayUrl: string,
  consumerKey: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${consumerKey}`,
    'Content-Type': 'application/json',
  };

  switch (toolName) {
    case 'get_secret': {
      const res = await fetch(`${gatewayUrl}/v1/secret/${encodeURIComponent(args.name as string)}`, { headers });
      const data = await res.json() as Record<string, any>;
      if (!res.ok) return JSON.stringify(data);
      return JSON.stringify({ name: data.name, value: data.value, masked: data.masked, version: data.version });
    }
    case 'list_secrets': {
      const url = args.tag
        ? `${gatewayUrl}/v1/secrets?tag=${encodeURIComponent(args.tag as string)}`
        : `${gatewayUrl}/v1/secrets`;
      const res = await fetch(url, { headers });
      return await res.text();
    }
    case 'get_env': {
      const params = new URLSearchParams();
      if (args.tag) params.set('tag', args.tag as string);
      if (Array.isArray(args.names) && args.names.length > 0) {
        params.set('names', (args.names as string[]).join(','));
      }
      const res = await fetch(`${gatewayUrl}/v1/env?${params.toString()}`, { headers });
      return await res.text();
    }
    case 'rotation_report': {
      const res = await fetch(`${gatewayUrl}/v1/rotation-report`, { headers });
      return await res.text();
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

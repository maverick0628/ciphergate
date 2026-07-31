import { describe, it, expect } from 'vitest';
import { createMcpTools } from '../src/mcp/tools.js';

describe('MCP Tools', () => {
  it('registers all 4 tools with correct schemas', () => {
    const tools = createMcpTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_secret');
    expect(names).toContain('list_secrets');
    expect(names).toContain('get_env');
    expect(names).toContain('rotation_report');
  });

  it('get_secret requires name parameter', () => {
    const tools = createMcpTools();
    const getTool = tools.find((t) => t.name === 'get_secret')!;
    expect(getTool.inputSchema.required).toContain('name');
  });

  it('list_secrets has optional tag parameter', () => {
    const tools = createMcpTools();
    const listTool = tools.find((t) => t.name === 'list_secrets')!;
    expect(listTool.inputSchema.properties).toHaveProperty('tag');
    expect(listTool.inputSchema.required).toBeUndefined();
  });

  it('get_env accepts tag and names parameters', () => {
    const tools = createMcpTools();
    const envTool = tools.find((t) => t.name === 'get_env')!;
    expect(envTool.inputSchema.properties).toHaveProperty('tag');
    expect(envTool.inputSchema.properties).toHaveProperty('names');
  });

  it('rotation_report has no required parameters', () => {
    const tools = createMcpTools();
    const rotTool = tools.find((t) => t.name === 'rotation_report')!;
    expect(Object.keys(rotTool.inputSchema.properties)).toHaveLength(0);
  });
});

#!/usr/bin/env node

/**
 * OpenAI MCP Server
 * Exposes OpenAI models (o3-pro, o3, GPT-5.2-pro, GPT-5.2-codex) as a tool for Claude Code.
 * Uses OpenAI Responses API for all models.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  process.stderr.write('ERROR: OPENAI_API_KEY env var is required\n');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'o3-pro';

// Models that support reasoning effort parameter
const REASONING_MODELS = new Set(['o3', 'o3-pro', 'o3-mini', 'o4-mini', 'o1', 'o1-pro']);

const server = new Server(
  { name: 'openai', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'openai',
      description:
        'Ask OpenAI a question. Use this for second opinions, alternative approaches, ' +
        'or when you want a different perspective from GPT/o-series models. ' +
        'o3-pro (deep reasoning) is the default. Also available: o3 (reasoning), ' +
        'gpt-5.2-pro (deep general), gpt-5.2-codex (coding).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt to send to OpenAI'
          },
          model: {
            type: 'string',
            description:
              'Model: o3-pro (default, deep reasoning), o3 (reasoning), ' +
              'gpt-5.2-pro (deep general), gpt-5.2-codex (coding), gpt-5.2 (general), o4-mini (fast reasoning)',
            enum: [
              'o3-pro', 'o3',
              'gpt-5.2-pro', 'gpt-5.2-codex', 'gpt-5.2',
              'o4-mini'
            ],
            default: 'o3-pro'
          },
          context: {
            type: 'string',
            description: 'Optional file contents or code context to include with the prompt'
          },
          reasoningEffort: {
            type: 'string',
            description: 'Reasoning effort for o-series models: low, medium, high (default: high). Ignored for GPT models.',
            enum: ['low', 'medium', 'high'],
            default: 'high'
          }
        },
        required: ['prompt']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'openai') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true
    };
  }

  const {
    prompt,
    model,
    context,
    reasoningEffort = 'high'
  } = request.params.arguments;

  const selectedModel = model || DEFAULT_MODEL;
  const isReasoning = REASONING_MODELS.has(selectedModel);

  let fullPrompt = prompt;
  if (context) {
    fullPrompt = `Context:\n${context}\n\n${prompt}`;
  }

  try {
    const params = {
      model: selectedModel,
      input: fullPrompt,
    };

    // o-series models support reasoning effort
    if (isReasoning) {
      params.reasoning = { effort: reasoningEffort };
    }

    const response = await openai.responses.create(params);

    const responseText = response.output_text || '';
    const usage = response.usage;

    let usageInfo = '';
    if (usage) {
      const parts = [`${usage.total_tokens} tokens`];
      if (usage.output_tokens_details?.reasoning_tokens) {
        parts.push(`${usage.output_tokens_details.reasoning_tokens} reasoning`);
      }
      usageInfo = ` | ${parts.join(', ')}`;
    }

    const text = `[OpenAI ${selectedModel}${usageInfo}]\n${responseText}`;

    return { content: [{ type: 'text', text }] };

  } catch (err) {
    const msg = err.message || String(err);
    return {
      content: [{ type: 'text', text: `OpenAI error (${selectedModel}): ${msg}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

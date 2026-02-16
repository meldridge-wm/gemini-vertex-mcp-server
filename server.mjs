#!/usr/bin/env node

/**
 * Gemini MCP Server — Vertex AI Edition
 * Exposes Gemini 3 (via Vertex AI) as a tool for Claude Code.
 * Uses Application Default Credentials (gcloud auth) — no API key needed.
 * Region: global (preview models require global).
 * When models go GA, switch GEMINI_LOCATION to nearest region:
 *   us-east4 (N. Virginia), us-central1 (Iowa), us-west1 (Oregon)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI } from '@google/genai';

const PROJECT = process.env.GEMINI_PROJECT || 'gcp-virtual-production-lab';
const LOCATION = process.env.GEMINI_LOCATION || 'global';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-preview';

const ai = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: LOCATION,
});

const server = new Server(
  { name: 'gemini', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'gemini',
      description:
        'Ask Gemini (Google\'s AI) a question. Use this for creative brainstorming, ' +
        'second opinions on architecture, generating alternative implementations, ' +
        'or when you want a different perspective. Gemini 3 Pro is used by default. ' +
        'Also available: gemini-3-flash-preview (faster), gemini-robotics-er-1.5-preview (robotics/embodied reasoning).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt to send to Gemini'
          },
          model: {
            type: 'string',
            description:
              'Model: gemini-3-pro-preview (default), gemini-3-flash-preview (faster), gemini-robotics-er-1.5-preview (robotics/embodied reasoning)',
            enum: ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-robotics-er-1.5-preview'],
            default: 'gemini-3-pro-preview'
          },
          context: {
            type: 'string',
            description: 'Optional file contents or code context to include with the prompt'
          },
          googleSearch: {
            type: 'boolean',
            description: 'Enable Google Search grounding (default: true)',
            default: true
          },
          thinkingLevel: {
            type: 'string',
            description: 'Thinking depth: NONE, LOW, MEDIUM, HIGH (default: HIGH)',
            enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'],
            default: 'HIGH'
          }
        },
        required: ['prompt']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'gemini') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true
    };
  }

  const {
    prompt,
    model,
    context,
    googleSearch = true,
    thinkingLevel = 'HIGH'
  } = request.params.arguments;

  const selectedModel = model || DEFAULT_MODEL;

  let fullPrompt = prompt;
  if (context) {
    fullPrompt = `Context:\n${context}\n\n${prompt}`;
  }

  try {
    const config = {};

    // Thinking config (robotics model doesn't support thinking)
    const isRobotics = selectedModel.includes('robotics');
    if (thinkingLevel !== 'NONE' && !isRobotics) {
      config.thinkingConfig = { thinkingLevel };
    }

    // Google Search grounding
    if (googleSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents: [
        {
          role: 'user',
          parts: [{ text: fullPrompt }]
        }
      ],
      config,
    });

    // Extract the text response
    const responseText = response.text || '';

    // Check for grounding metadata
    let groundingInfo = '';
    const candidate = response.candidates?.[0];
    const grounding = candidate?.groundingMetadata;
    if (grounding?.searchEntryPoint?.renderedContent) {
      groundingInfo = '\n\n[Search grounding was used]';
    }

    const text = `[Gemini ${selectedModel} | Vertex AI | ${LOCATION}]\n${responseText}${groundingInfo}`;

    return { content: [{ type: 'text', text }] };

  } catch (err) {
    const msg = err.message || String(err);
    return {
      content: [{ type: 'text', text: `Gemini error (${selectedModel}): ${msg}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

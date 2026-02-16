#!/usr/bin/env node

/**
 * Gemini MCP Server — Multi-Region, Dual Backend
 * - Gemini 2.5 Pro/Flash → Vertex AI, regional (low latency)
 * - Gemini 3 Pro/Flash → Vertex AI, global (preview)
 * - Gemini Robotics ER → AI Studio, API key (not on Vertex AI yet)
 *
 * When Gemini 3 goes GA and gets regional support, move it to REGIONAL_LOCATION.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI } from '@google/genai';

const PROJECT = process.env.GEMINI_PROJECT || 'gcp-virtual-production-lab';
const GLOBAL_LOCATION = 'global';
const REGIONAL_LOCATION = process.env.GEMINI_REGION || 'us-central1';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-preview';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Vertex AI client — regional (Gemini 2.5 GA models, lower latency)
const vertexRegional = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: REGIONAL_LOCATION,
});

// Vertex AI client — global (Gemini 3 preview models, computer-use)
const vertexGlobal = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: GLOBAL_LOCATION,
});

// AI Studio client for models not yet on Vertex AI (robotics, etc.)
const aiStudio = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

// Routing table: model → { client, backend label }
const AI_STUDIO_MODELS = new Set(['gemini-robotics-er-1.5-preview']);
const GLOBAL_MODELS = new Set([
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
]);
// Everything else goes to regional

// Models that don't support thinking config
const NO_THINKING_MODELS = new Set(['gemini-robotics-er-1.5-preview']);

function getClientAndBackend(model) {
  if (AI_STUDIO_MODELS.has(model)) {
    return { client: aiStudio, backend: 'AI Studio', needsKey: true };
  }
  if (GLOBAL_MODELS.has(model)) {
    return { client: vertexGlobal, backend: `Vertex AI | ${GLOBAL_LOCATION}` };
  }
  // GA models → regional for lower latency
  return { client: vertexRegional, backend: `Vertex AI | ${REGIONAL_LOCATION}` };
}

const server = new Server(
  { name: 'gemini', version: '3.0.0' },
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
              'Model: gemini-3-pro-preview (default), gemini-3-flash-preview (faster), ' +
              'gemini-robotics-er-1.5-preview (robotics/embodied reasoning)',
            enum: [
              'gemini-3-pro-preview', 'gemini-3-flash-preview',
              'gemini-2.5-pro', 'gemini-2.5-flash',
              'gemini-robotics-er-1.5-preview'
            ],
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

    // Thinking config (some models don't support it)
    if (thinkingLevel !== 'NONE' && !NO_THINKING_MODELS.has(selectedModel)) {
      config.thinkingConfig = { thinkingLevel };
    }

    // Google Search grounding
    if (googleSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    // Route to the right backend
    const { client, backend, needsKey } = getClientAndBackend(selectedModel);
    if (needsKey && !client) {
      return {
        content: [{ type: 'text', text: `${selectedModel} requires GEMINI_API_KEY (not available on Vertex AI yet)` }],
        isError: true
      };
    }

    const response = await client.models.generateContent({
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

    const text = `[Gemini ${selectedModel} | ${backend}]\n${responseText}${groundingInfo}`;

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

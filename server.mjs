#!/usr/bin/env node

/**
 * Gemini MCP Server — Dual Backend (Vertex AI + AI Studio)
 * Exposes Gemini models as a tool for Claude Code.
 *
 * Routing:
 *   - GEMINI_BACKEND=vertex  → Vertex AI (service account / ADC)
 *   - GEMINI_BACKEND=apikey  → AI Studio (API key)
 *   - GEMINI_BACKEND=auto    → Vertex AI for models that support it,
 *                               API key fallback for the rest (default)
 *
 * API Key Rotation:
 *   Supports multiple API keys via comma-separated GEMINI_API_KEYS env var.
 *   On RESOURCE_EXHAUSTED, automatically rotates to the next key and retries.
 *   Falls back to GEMINI_API_KEY (singular) if GEMINI_API_KEYS is not set.
 *
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

// --- Config ---
const BACKEND = (process.env.GEMINI_BACKEND || 'auto').toLowerCase();
const PROJECT = process.env.GEMINI_PROJECT || 'gcp-virtual-production-lab';
const LOCATION = process.env.GEMINI_LOCATION || 'global';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-preview';

// Models that work on Vertex AI. Everything else routes to API key.
// Update this list as Google enables more models on Vertex AI.
const VERTEX_MODELS = new Set([
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-001',
]);

// --- API Key Pool ---
// GEMINI_API_KEYS (comma-separated) takes priority, falls back to GEMINI_API_KEY
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

let currentKeyIndex = 0;

function getApiKey() {
  if (API_KEYS.length === 0) return null;
  return API_KEYS[currentKeyIndex % API_KEYS.length];
}

function rotateApiKey() {
  if (API_KEYS.length <= 1) return false;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return true;
}

function makeApiKeyClient(apiKey) {
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// --- Clients ---
let vertexClient = null;

if (BACKEND === 'vertex' || BACKEND === 'auto') {
  vertexClient = new GoogleGenAI({
    vertexai: true,
    project: PROJECT,
    location: LOCATION,
  });
}

function getClient(model) {
  if (BACKEND === 'vertex') return { client: vertexClient, via: 'vertex' };

  if (BACKEND === 'apikey') {
    const key = getApiKey();
    return { client: makeApiKeyClient(key), via: 'apikey' };
  }

  // auto: route based on model
  if (VERTEX_MODELS.has(model) && vertexClient) {
    return { client: vertexClient, via: 'vertex' };
  }
  const key = getApiKey();
  if (key) {
    return { client: makeApiKeyClient(key), via: 'apikey' };
  }
  // Fallback: try vertex even if model isn't in the known list
  if (vertexClient) {
    return { client: vertexClient, via: 'vertex' };
  }
  return { client: null, via: 'none' };
}

function isResourceExhausted(err) {
  const msg = (err.message || String(err)).toLowerCase();
  return msg.includes('resource_exhausted') ||
    msg.includes('resource has been exhausted') ||
    msg.includes('quota') ||
    msg.includes('429');
}

// --- MCP Server ---
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
              'gemini-robotics-er-1.5-preview (robotics/embodied reasoning), ' +
              'gemini-2.5-pro, gemini-2.5-flash',
            enum: [
              'gemini-3-pro-preview',
              'gemini-3-flash-preview',
              'gemini-robotics-er-1.5-preview',
              'gemini-2.5-pro',
              'gemini-2.5-flash',
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

  const contents = [
    {
      role: 'user',
      parts: [{ text: fullPrompt }]
    }
  ];

  // Retry loop: on RESOURCE_EXHAUSTED, rotate API key and retry
  const maxAttempts = Math.max(API_KEYS.length, 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { client, via } = getClient(selectedModel);

    if (!client) {
      const hint = via === 'none'
        ? 'No backend configured. Set GEMINI_API_KEY or GOOGLE_APPLICATION_CREDENTIALS.'
        : `Backend "${BACKEND}" not available.`;
      return {
        content: [{ type: 'text', text: `Gemini config error: ${hint}` }],
        isError: true
      };
    }

    try {
      const response = await client.models.generateContent({
        model: selectedModel,
        contents,
        config,
      });

      const responseText = response.text || '';

      let groundingInfo = '';
      const candidate = response.candidates?.[0];
      const grounding = candidate?.groundingMetadata;
      if (grounding?.searchEntryPoint?.renderedContent) {
        groundingInfo = '\n\n[Search grounding was used]';
      }

      const backend = via === 'vertex' ? `Vertex AI | ${LOCATION}` : `AI Studio`;
      const keyInfo = via === 'apikey' && API_KEYS.length > 1
        ? ` | key ${(currentKeyIndex % API_KEYS.length) + 1}/${API_KEYS.length}`
        : '';
      const text = `[Gemini ${selectedModel} | ${backend}${keyInfo}]\n${responseText}${groundingInfo}`;

      return { content: [{ type: 'text', text }] };

    } catch (err) {
      lastError = err;

      // If resource exhausted and we're using API key, try rotating
      if (via === 'apikey' && isResourceExhausted(err) && rotateApiKey()) {
        continue; // retry with next key
      }

      // Not recoverable
      break;
    }
  }

  const msg = lastError?.message || String(lastError);
  const exhaustedHint = isResourceExhausted(lastError)
    ? ` All ${API_KEYS.length} API key(s) exhausted.`
    : '';
  return {
    content: [{ type: 'text', text: `Gemini error (${selectedModel}):${exhaustedHint} ${msg}` }],
    isError: true
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

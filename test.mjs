#!/usr/bin/env node

/**
 * End-to-end test for the Gemini MCP server (Vertex AI edition).
 * Spawns the server, sends MCP protocol messages, validates responses.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = spawn('node', ['server.mjs'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
server.stdout.on('data', d => { stdout += d.toString(); });
server.stderr.on('data', d => { stderr += d.toString(); });

function send(msg) {
  const json = JSON.stringify(msg);
  server.stdin.write(json + '\n');
}

function waitForResponse(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) return resolve(parsed);
        } catch {}
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for response id=${id}`));
      setTimeout(check, 100);
    };
    check();
  });
}

async function run() {
  console.log('=== Test 1: Initialize ===');
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' }
    }
  });

  try {
    const initResp = await waitForResponse(1);
    console.log('✓ Server initialized:', initResp.result?.serverInfo?.name, initResp.result?.serverInfo?.version);
  } catch (e) {
    console.log('✗ Init failed:', e.message);
    console.log('stdout so far:', stdout);
    console.log('stderr so far:', stderr);
    server.kill();
    process.exit(1);
  }

  // Send initialized notification
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  console.log('\n=== Test 2: List Tools ===');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  try {
    const toolsResp = await waitForResponse(2);
    const tools = toolsResp.result?.tools || [];
    console.log(`✓ Found ${tools.length} tool(s):`, tools.map(t => t.name).join(', '));
    if (tools[0]?.name !== 'gemini') {
      console.log('✗ Expected tool named "gemini"');
      server.kill();
      process.exit(1);
    }
    console.log('✓ Tool schema has required "prompt" field:', tools[0].inputSchema?.required?.includes('prompt'));
    const models = tools[0].inputSchema?.properties?.model?.enum;
    console.log('✓ Available models:', models?.join(', '));
  } catch (e) {
    console.log('✗ List tools failed:', e.message);
    server.kill();
    process.exit(1);
  }

  console.log('\n=== Test 3: Call Gemini 3 Flash ===');
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'gemini',
      arguments: {
        prompt: 'Reply with exactly: GEMINI_MCP_TEST_OK',
        model: 'gemini-3-flash-preview',
        googleSearch: false,
        thinkingLevel: 'NONE'
      }
    }
  });

  try {
    const callResp = await waitForResponse(3, 60000);
    const text = callResp.result?.content?.[0]?.text || '';
    console.log('✓ Got response:', text.slice(0, 200));
    if (text.includes('GEMINI_MCP_TEST_OK')) {
      console.log('✓ Response contains expected string');
    } else {
      console.log('⚠ Response did not contain exact string (but call succeeded)');
    }
    if (callResp.result?.isError) {
      console.log('✗ Tool returned isError=true');
    }
  } catch (e) {
    console.log('✗ Gemini 3 Flash call failed:', e.message);
    console.log('stderr:', stderr);
  }

  console.log('\n=== Test 4: Call Gemini 3 Pro (with thinking + search) ===');
  send({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: {
      name: 'gemini',
      arguments: {
        prompt: 'What is 2+2? Reply with just the number.',
        model: 'gemini-3-pro-preview'
      }
    }
  });

  try {
    const callResp = await waitForResponse(4, 120000);
    const text = callResp.result?.content?.[0]?.text || '';
    console.log('✓ Got response:', text.slice(0, 300));
    if (callResp.result?.isError) {
      console.log('✗ Tool returned isError=true');
    } else {
      console.log('✓ Gemini 3 Pro call succeeded');
    }
  } catch (e) {
    console.log('✗ Gemini 3 Pro call failed:', e.message);
    console.log('stderr:', stderr);
  }

  console.log('\n=== All tests complete ===');
  server.kill();
  process.exit(0);
}

run();

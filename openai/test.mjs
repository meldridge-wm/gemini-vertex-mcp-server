#!/usr/bin/env node

/**
 * End-to-end test for the OpenAI MCP server.
 * Spawns the server, sends MCP protocol messages, validates responses.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = spawn('node', ['server.mjs'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
});

let stdout = '';
let stderr = '';
server.stdout.on('data', d => { stdout += d.toString(); });
server.stderr.on('data', d => { stderr += d.toString(); });

function send(msg) {
  server.stdin.write(JSON.stringify(msg) + '\n');
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
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout id=${id}`));
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
    const r = await waitForResponse(1);
    console.log('✓ Server initialized:', r.result?.serverInfo?.name, r.result?.serverInfo?.version);
  } catch (e) {
    console.log('✗ Init failed:', e.message, '\nstderr:', stderr);
    server.kill(); process.exit(1);
  }

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  console.log('\n=== Test 2: List Tools ===');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  try {
    const r = await waitForResponse(2);
    const tools = r.result?.tools || [];
    console.log(`✓ Found ${tools.length} tool(s):`, tools.map(t => t.name).join(', '));
    const models = tools[0].inputSchema?.properties?.model?.enum;
    console.log('✓ Available models:', models?.join(', '));
  } catch (e) {
    console.log('✗ List tools failed:', e.message);
    server.kill(); process.exit(1);
  }

  console.log('\n=== Test 3: o4-mini (fast) ===');
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'openai',
      arguments: {
        prompt: 'Reply with exactly: OPENAI_MCP_TEST_OK',
        model: 'o4-mini',
        reasoningEffort: 'low'
      }
    }
  });

  try {
    const r = await waitForResponse(3, 60000);
    const text = r.result?.content?.[0]?.text || '';
    console.log('✓ Got response:', text.slice(0, 200));
    if (text.includes('OPENAI_MCP_TEST_OK')) console.log('✓ Contains expected string');
    if (r.result?.isError) console.log('✗ Tool returned isError=true');
  } catch (e) {
    console.log('✗ o4-mini failed:', e.message, '\nstderr:', stderr);
  }

  console.log('\n=== Test 4: o3-pro (deep reasoning) ===');
  send({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: {
      name: 'openai',
      arguments: {
        prompt: 'What is 2+2? Reply with just the number.',
        model: 'o3-pro'
      }
    }
  });

  try {
    const r = await waitForResponse(4, 180000);
    const text = r.result?.content?.[0]?.text || '';
    console.log('✓ Got response:', text.slice(0, 300));
    if (r.result?.isError) console.log('✗ Tool returned isError=true');
    else console.log('✓ o3-pro call succeeded');
  } catch (e) {
    console.log('✗ o3-pro failed:', e.message, '\nstderr:', stderr);
  }

  console.log('\n=== All tests complete ===');
  server.kill();
  process.exit(0);
}

run();

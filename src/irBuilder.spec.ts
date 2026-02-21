// irBuilder.spec.ts — Unit tests for the IR builder.
// Run with: npx tsx src/irBuilder.spec.ts

import * as assert from 'assert';
import { buildTurnNode, buildSessionGraph } from './irBuilder';
import type { ISerializableChatData, ISerializableChatRequestData } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ISerializableChatRequestData> = {}): ISerializableChatRequestData {
  return {
    requestId: 'req_1',
    message: 'Hello world',
    variableData: { variables: [] },
    response: [],
    timestamp: 1700000000000,
    modelId: 'gpt-4o',
    ...overrides,
  };
}

function makeSession(requests: ISerializableChatRequestData[]): ISerializableChatData {
  return {
    version: 3,
    sessionId: 'test-session-id',
    creationDate: 1700000000000,
    responderUsername: 'GitHub Copilot',
    requests,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testBasicUserTurnNoResponse() {
  const req = makeRequest({ message: 'What is TypeScript?' });
  const turn = buildTurnNode(req, 0);

  assert.strictEqual(turn.turnIndex, 0);
  assert.strictEqual(turn.request.id, 'user_0');
  assert.strictEqual(turn.request.fullText, 'What is TypeScript?');
  assert.strictEqual(turn.request.requestId, 'req_1');
  assert.strictEqual(turn.response, null); // no response parts
  console.log('✓ testBasicUserTurnNoResponse');
}

function testTurnWithMarkdownResponse() {
  const req = makeRequest({
    response: [
      { kind: 'markdownContent', value: 'TypeScript is a typed superset of JavaScript.' },
    ],
    agent: { id: 'copilot', name: 'copilot' },
    modelState: { value: 1, completedAt: 1700000005000 },
    result: { timings: { totalElapsed: 5000, firstProgress: 200 } },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  assert.strictEqual(turn.response!.id, 'agent_0');
  assert.strictEqual(turn.response!.agent, 'copilot');
  assert.strictEqual(turn.response!.state, 'complete');
  assert.strictEqual(turn.response!.duration, 5000);
  assert.strictEqual(turn.response!.ttft, 200);
  assert.strictEqual(turn.response!.markdown.length, 45);
  assert.ok(turn.response!.markdown.preview.includes('TypeScript'));
  assert.strictEqual(turn.response!.children.length, 0); // no tools/thinking
  console.log('✓ testTurnWithMarkdownResponse');
}

function testToolCallDeduplication() {
  const req = makeRequest({
    response: [
      // Pre-completion version (isComplete=false)
      {
        kind: 'toolInvocationSerialized',
        toolId: 'grep_search',
        toolCallId: 'tc_1',
        invocationMessage: 'Searching...',
        isComplete: false,
        source: { type: 'builtin', label: 'Built-In' },
      } as any,
      // Post-completion version (isComplete=true) — same toolCallId
      {
        kind: 'toolInvocationSerialized',
        toolId: 'grep_search',
        toolCallId: 'tc_1',
        invocationMessage: 'Found 5 results',
        pastTenseMessage: 'Searched codebase',
        isComplete: true,
        source: { type: 'builtin', label: 'Built-In' },
        resultDetails: { output: [{ value: 'result1' }] },
      } as any,
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  // Only 1 tool node (deduplicated by toolCallId, keeps canonical/last version)
  assert.strictEqual(turn.response!.toolCount, 1);
  const tool = turn.response!.children[0];
  assert.strictEqual(tool.type, 'tool');
  if (tool.type === 'tool') {
    assert.strictEqual(tool.isComplete, true);
    assert.strictEqual(tool.message, 'Found 5 results');
  }
  console.log('✓ testToolCallDeduplication');
}

function testThinkingBlock() {
  const req = makeRequest({
    response: [
      {
        kind: 'thinking',
        value: ['Let me think about this. ', 'The answer is 42.'],
      } as any,
      { kind: 'markdownContent', value: 'The answer is 42.' },
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  assert.strictEqual(turn.response!.thinkingCount, 1);
  const thinking = turn.response!.children.find(c => c.type === 'thinking');
  assert.ok(thinking);
  if (thinking?.type === 'thinking') {
    assert.strictEqual(thinking.fullText, 'Let me think about this. The answer is 42.');
    assert.strictEqual(thinking.charCount, 42);
    assert.ok(thinking.wordCount > 0);
  }
  console.log('✓ testThinkingBlock');
}

function testEmptyThinkingBlockSkipped() {
  const req = makeRequest({
    response: [
      { kind: 'thinking', value: '   ' } as any,
      { kind: 'markdownContent', value: 'Hello' },
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  assert.strictEqual(turn.response!.thinkingCount, 0);
  console.log('✓ testEmptyThinkingBlockSkipped');
}

function testSubAgentGrouping() {
  const req = makeRequest({
    response: [
      // SubAgent tool call (the parent)
      {
        kind: 'toolInvocationSerialized',
        toolId: 'runSubagent',
        toolCallId: 'tc_sub',
        invocationMessage: 'Running sub-agent...',
        isComplete: true,
        source: { type: 'builtin', label: 'Built-In' },
        toolSpecificData: {
          kind: 'subagent',
          agentName: 'Explore',
          description: 'Exploring codebase',
          prompt: 'Find all TypeScript files',
          result: 'Found 10 files',
        },
      } as any,
      // Tool call owned by the subagent
      {
        kind: 'toolInvocationSerialized',
        toolId: 'file_search',
        toolCallId: 'tc_inner_1',
        invocationMessage: 'Searching files...',
        isComplete: true,
        subAgentInvocationId: 'tc_sub',
        source: { type: 'builtin', label: 'Built-In' },
      } as any,
      // Another tool call owned by the subagent
      {
        kind: 'toolInvocationSerialized',
        toolId: 'read_file',
        toolCallId: 'tc_inner_2',
        invocationMessage: 'Reading file...',
        isComplete: true,
        subAgentInvocationId: 'tc_sub',
        source: { type: 'builtin', label: 'Built-In' },
      } as any,
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  assert.strictEqual(turn.response!.subAgentCount, 1);
  const subAgent = turn.response!.children.find(c => c.type === 'subAgent');
  assert.ok(subAgent);
  if (subAgent?.type === 'subAgent') {
    assert.strictEqual(subAgent.agentName, 'Explore');
    assert.strictEqual(subAgent.prompt, 'Find all TypeScript files');
    assert.strictEqual(subAgent.result, 'Found 10 files');
    assert.strictEqual(subAgent.children.length, 2); // 2 inner tools
    assert.strictEqual(subAgent.toolCount, 2);
    assert.strictEqual(subAgent.children[0].toolId, 'file_search');
    assert.strictEqual(subAgent.children[1].toolId, 'read_file');
  }
  // Inner tools should NOT appear as top-level children
  const topLevelTools = turn.response!.children.filter(c => c.type === 'tool');
  assert.strictEqual(topLevelTools.length, 0);
  console.log('✓ testSubAgentGrouping');
}

function testMcpToolDetection() {
  const req = makeRequest({
    response: [
      {
        kind: 'toolInvocationSerialized',
        toolId: 'mcp_server_tool',
        toolCallId: 'tc_mcp',
        invocationMessage: 'Querying MCP...',
        isComplete: true,
        source: { type: 'mcp', label: 'context7' },
      } as any,
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  const tool = turn.response!.children[0];
  assert.strictEqual(tool.type, 'tool');
  if (tool.type === 'tool') {
    assert.strictEqual(tool.isMcp, true);
    assert.strictEqual(tool.source.label, 'context7');
  }
  console.log('✓ testMcpToolDetection');
}

function testTextEditGroup() {
  const req = makeRequest({
    response: [
      {
        kind: 'textEditGroup',
        value: {},
        uri: { fsPath: '/src/app.ts' },
        edits: [{ text: 'const x = 1;', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }],
      } as any,
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  const editGroup = turn.response!.children[0];
  assert.strictEqual(editGroup.type, 'editGroup');
  if (editGroup.type === 'editGroup') {
    assert.strictEqual(editGroup.uri, '/src/app.ts');
    assert.strictEqual(editGroup.editCount, 1);
  }
  console.log('✓ testTextEditGroup');
}

function testElicitation() {
  const req = makeRequest({
    response: [
      {
        kind: 'elicitationSerialized',
        title: { value: 'Confirm action' },
        message: { value: 'Delete this file?' },
        state: 'confirmed',
      } as any,
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);

  assert.ok(turn.response);
  const elicitation = turn.response!.children[0];
  assert.strictEqual(elicitation.type, 'elicitation');
  if (elicitation.type === 'elicitation') {
    assert.strictEqual(elicitation.title, 'Confirm action');
    assert.strictEqual(elicitation.message, 'Delete this file?');
    assert.strictEqual(elicitation.state, 'confirmed');
  }
  console.log('✓ testElicitation');
}

function testModelStateNormalization() {
  // Numeric states
  const req1 = makeRequest({ response: [{ kind: 'markdownContent', value: 'x' }], agent: { id: 'copilot' }, modelState: { value: 1 } });
  assert.strictEqual(buildTurnNode(req1, 0).response!.state, 'complete');

  const req2 = makeRequest({ response: [{ kind: 'markdownContent', value: 'x' }], agent: { id: 'copilot' }, modelState: { value: 2 } });
  assert.strictEqual(buildTurnNode(req2, 0).response!.state, 'failed');

  const req3 = makeRequest({ response: [{ kind: 'markdownContent', value: 'x' }], agent: { id: 'copilot' }, modelState: { value: 3 } });
  assert.strictEqual(buildTurnNode(req3, 0).response!.state, 'cancelled');

  // String states
  const req4 = makeRequest({ response: [{ kind: 'markdownContent', value: 'x' }], agent: { id: 'copilot' }, modelState: { value: 'complete' } });
  assert.strictEqual(buildTurnNode(req4, 0).response!.state, 'complete');

  // Unknown
  const req5 = makeRequest({ response: [{ kind: 'markdownContent', value: 'x' }], agent: { id: 'copilot' }, modelState: { value: 99 as any } });
  assert.strictEqual(buildTurnNode(req5, 0).response!.state, 'unknown');

  console.log('✓ testModelStateNormalization');
}

function testBuildSessionGraph() {
  const session = makeSession([
    makeRequest({ requestId: 'r1', message: 'First question', response: [{ kind: 'markdownContent', value: 'First answer' }], agent: { id: 'copilot' }, modelState: { value: 1 } }),
    makeRequest({ requestId: 'r2', message: 'Second question', response: [{ kind: 'markdownContent', value: 'Second answer' }], agent: { id: 'copilot' }, modelState: { value: 1 } }),
  ]);

  const graph = buildSessionGraph(session);

  assert.strictEqual(graph.sessionId, 'test-session-id');
  assert.strictEqual(graph.title, 'First question');
  assert.strictEqual(graph.turns.length, 2);
  assert.strictEqual(graph.turns[0].turnIndex, 0);
  assert.strictEqual(graph.turns[1].turnIndex, 1);
  assert.strictEqual(graph.turns[0].request.fullText, 'First question');
  assert.strictEqual(graph.turns[1].request.fullText, 'Second question');
  console.log('✓ testBuildSessionGraph');
}

function testCustomTitle() {
  const session = makeSession([
    makeRequest({ message: 'Hello' }),
  ]);
  session.customTitle = 'My Custom Title';

  const graph = buildSessionGraph(session);
  assert.strictEqual(graph.title, 'My Custom Title');
  console.log('✓ testCustomTitle');
}

function testEmptySession() {
  const session = makeSession([]);
  const graph = buildSessionGraph(session);

  assert.strictEqual(graph.turns.length, 0);
  assert.strictEqual(graph.title, 'Empty session');
  console.log('✓ testEmptySession');
}

function testVariables() {
  const req = makeRequest({
    variableData: {
      variables: [
        { name: 'file', id: 'v1' },
        { name: 'selection', id: 'v2' },
        { id: 'unnamed_var' },
      ],
    },
  });

  const turn = buildTurnNode(req, 0);
  assert.strictEqual(turn.request.variables.length, 3);
  assert.strictEqual(turn.request.variables[0].name, 'file');
  assert.strictEqual(turn.request.variables[1].name, 'selection');
  assert.strictEqual(turn.request.variables[2].name, 'unnamed_var');
  console.log('✓ testVariables');
}

function testTerminalToolSpecificData() {
  const req = makeRequest({
    response: [
      {
        kind: 'toolInvocationSerialized',
        toolId: 'run_in_terminal',
        toolCallId: 'tc_term',
        invocationMessage: 'Running npm test',
        isComplete: true,
        source: { type: 'builtin', label: 'Built-In' },
        toolSpecificData: {
          kind: 'terminal',
          commandLine: { original: 'npm test' },
          terminalCommandState: { exitCode: 0, duration: 5000 },
          terminalCommandOutput: { text: 'All tests passed', lineCount: 1 },
          cwd: '/home/user/project',
        },
      } as any,
    ],
    agent: { id: 'copilot' },
    modelState: { value: 1 },
  });

  const turn = buildTurnNode(req, 0);
  const tool = turn.response!.children[0];
  assert.strictEqual(tool.type, 'tool');
  if (tool.type === 'tool') {
    assert.ok(tool.specificData);
    assert.strictEqual(tool.specificData!.kind, 'terminal');
    if (tool.specificData!.kind === 'terminal') {
      assert.strictEqual(tool.specificData!.commandLine, 'npm test');
      assert.strictEqual(tool.specificData!.exitCode, 0);
      assert.strictEqual(tool.specificData!.cwd, '/home/user/project');
    }
  }
  console.log('✓ testTerminalToolSpecificData');
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

function runTests() {
  console.log('Running irBuilder tests...\n');
  testBasicUserTurnNoResponse();
  testTurnWithMarkdownResponse();
  testToolCallDeduplication();
  testThinkingBlock();
  testEmptyThinkingBlockSkipped();
  testSubAgentGrouping();
  testMcpToolDetection();
  testTextEditGroup();
  testElicitation();
  testModelStateNormalization();
  testBuildSessionGraph();
  testCustomTitle();
  testEmptySession();
  testVariables();
  testTerminalToolSpecificData();
  console.log('\nAll tests passed! ✓');
}

runTests();

/**
 * NanoClaw Agent Runner - Standard Anthropic SDK Version
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * This version uses @anthropic-ai/sdk instead of @anthropic-ai/claude-agent-sdk
 * to work with Z.ai's Anthropic-compatible API endpoint.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

// Message types for conversation history
type Message = Anthropic.MessageParam;

// Tool definitions
interface Tool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  execute: (input: any) => Promise<string>;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 */
class MessageStream {
  private queue: string[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push(text);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *consume(): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Simple tool implementations
 */
class ToolExecutor {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    // Register basic tools
    this.register({
      name: 'bash',
      description: 'Run a bash shell command',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to run',
          },
        },
        required: ['command'],
      },
      execute: async (input) => {
        try {
          const result = execSync(input.command, {
            encoding: 'utf-8',
            cwd: '/workspace/group',
            maxBuffer: 10 * 1024 * 1024, // 10MB
          });
          return result;
        } catch (error: any) {
          return `Error: ${error.message}`;
        }
      },
    });

    this.register({
      name: 'read_file',
      description: 'Read the contents of a file',
      input_schema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file',
          },
        },
        required: ['file_path'],
      },
      execute: async (input) => {
        try {
          // Security check: only allow reading from /workspace
          if (!input.file_path.startsWith('/workspace/')) {
            return 'Error: Only files under /workspace/ can be read';
          }
          return fs.readFileSync(input.file_path, 'utf-8');
        } catch (error: any) {
          return `Error: ${error.message}`;
        }
      },
    });

    this.register({
      name: 'write_file',
      description: 'Write content to a file',
      input_schema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file',
          },
          content: {
            type: 'string',
            description: 'The content to write',
          },
        },
        required: ['file_path', 'content'],
      },
      execute: async (input) => {
        try {
          // Security check: only allow writing to /workspace/group
          if (!input.file_path.startsWith('/workspace/group/')) {
            return 'Error: Can only write files under /workspace/group/';
          }
          fs.writeFileSync(input.file_path, input.content, 'utf-8');
          return `Successfully wrote to ${input.file_path}`;
        } catch (error: any) {
          return `Error: ${error.message}`;
        }
      },
    });
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getToolDefinitions(): Anthropic.Tool[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  async executeTool(toolName: string, input: any): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return `Error: Unknown tool "${toolName}"`;
    }
    return await tool.execute(input);
  }
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query with tool execution loop
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{ newSessionId: string; closedDuringQuery: boolean }> {
  // Generate a new session ID if needed
  const newSessionId = sessionId || `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Initialize Anthropic client with credential proxy
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  if (!baseURL) {
    throw new Error('ANTHROPIC_BASE_URL environment variable is required');
  }
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder',
    baseURL,
  });

  const toolExecutor = new ToolExecutor();

  // Load global CLAUDE.md as additional system context
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let systemPrompt: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemPrompt = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Build messages array
  const messages: Message[] = [
    { role: 'user', content: prompt }
  ];

  // Tool execution loop
  let closedDuringQuery = false;
  const maxIterations = 10; // Prevent infinite loops
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    // Check for close sentinel during tool execution
    if (shouldClose()) {
      log('Close sentinel detected during tool execution, ending query');
      closedDuringQuery = true;
      break;
    }

    // Drain any IPC messages
    const ipcMessages = drainIpcInput();
    if (ipcMessages.length > 0 && iteration > 1) {
      // Add IPC messages as a new user message
      messages.push({ role: 'user', content: ipcMessages.join('\n') });
    }

    try {
      log(`Query iteration ${iteration}: sending ${messages.length} messages`);

      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolExecutor.getToolDefinitions(),
        messages: messages,
      });

      log(`Response: stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);

      // Process response content
      let hasToolUse = false;
      let textContent = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          hasToolUse = true;
          log(`Tool use requested: ${block.name}`);

          // Execute the tool
          try {
            const toolResult = await toolExecutor.executeTool(block.name, block.input);
            log(`Tool result: ${toolResult.slice(0, 200)}...`);

            // Add tool result to conversation
            messages.push({
              role: 'assistant',
              content: response.content,
            });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: toolResult,
                },
              ],
            });
          } catch (error: any) {
            log(`Tool execution error: ${error.message}`);

            messages.push({
              role: 'assistant',
              content: response.content,
            });
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: `Error: ${error.message}`,
                },
              ],
            });
          }
        }
      }

      // If we have text content, emit it as output
      if (textContent) {
        log(`Emitting text result: ${textContent.slice(0, 200)}...`);
        writeOutput({
          status: 'success',
          result: textContent,
          newSessionId: newSessionId,
        });
      }

      // If no tool use, we're done
      if (!hasToolUse) {
        log('No tool use in response, query complete');
        break;
      }

    } catch (error: any) {
      log(`Query error: ${error.message}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId,
        error: error.message,
      });
      return { newSessionId, closedDuringQuery };
    }
  }

  if (iteration >= maxIterations) {
    log('Reached maximum iterations, ending query');
  }

  return { newSessionId, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\\n\\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\\n' + pending.join('\\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, sessionId, containerInput);
      sessionId = queryResult.newSessionId;

      // If _close was consumed during the query, exit immediately
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();

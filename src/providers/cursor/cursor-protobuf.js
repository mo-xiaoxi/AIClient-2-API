/**
 * cursor-protobuf.js
 *
 * Protobuf encode/decode helpers for Cursor API.
 * Wraps @bufbuild/protobuf runtime functions using the generated agent_pb.js schemas.
 *
 * Ported from cursor-auth/lib/cursor-fetch.ts — adapted for JS ES modules.
 */

import { createHash, randomUUID } from 'node:crypto';
import { create, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import { frameConnectMessage } from './cursor-h2.js';
import { fixToolCallArguments } from './cursor-tool-fixer.js';

import {
    AgentClientMessageSchema,
    AgentConversationTurnStructureSchema,
    AgentRunRequestSchema,
    AgentServerMessageSchema,
    AssistantMessageSchema,
    BackgroundShellSpawnResultSchema,
    ClientHeartbeatSchema,
    ConversationActionSchema,
    ConversationStateStructureSchema,
    ConversationStepSchema,
    ConversationTurnStructureSchema,
    DeleteRejectedSchema,
    DeleteResultSchema,
    DiagnosticsResultSchema,
    ExecClientMessageSchema,
    FetchErrorSchema,
    FetchResultSchema,
    GetBlobResultSchema,
    GrepErrorSchema,
    GrepResultSchema,
    KvClientMessageSchema,
    LsRejectedSchema,
    LsResultSchema,
    McpErrorSchema,
    McpResultSchema,
    McpSuccessSchema,
    McpTextContentSchema,
    McpToolDefinitionSchema,
    McpToolResultContentItemSchema,
    ModelDetailsSchema,
    ReadRejectedSchema,
    ReadResultSchema,
    RequestContextResultSchema,
    RequestContextSchema,
    RequestContextSuccessSchema,
    SelectedContextSchema,
    SelectedImageSchema,
    SetBlobResultSchema,
    ShellRejectedSchema,
    ShellResultSchema,
    UserMessageActionSchema,
    UserMessageSchema,
    WriteRejectedSchema,
    WriteResultSchema,
    WriteShellStdinErrorSchema,
    WriteShellStdinResultSchema,
} from './proto/agent_pb.js';

// ============================================================================
// Message parsing
// ============================================================================

/**
 * Extract plain text and inline images from an OpenAI message content field.
 * @param {unknown} content
 * @returns {{ text: string, images: Array<{data: Uint8Array, mimeType: string}> }}
 */
function extractContent(content) {
    if (typeof content === 'string') return { text: content, images: [] };
    if (content == null) return { text: '', images: [] };
    if (Array.isArray(content)) {
        const textParts = [];
        const images = [];
        for (const part of content) {
            if (typeof part === 'string') {
                textParts.push(part);
            } else if (part && typeof part === 'object') {
                if (part.type === 'text' && typeof part.text === 'string') {
                    textParts.push(part.text);
                } else if (part.type === 'image_url' && part.image_url?.url) {
                    const parsed = parseDataUrl(part.image_url.url);
                    if (parsed) images.push(parsed);
                } else if (part.type === 'image' && part.image) {
                    const url = typeof part.image === 'string' ? part.image : part.image.url;
                    if (url) {
                        const parsed = parseDataUrl(url);
                        if (parsed) images.push(parsed);
                    }
                }
            }
        }
        return { text: textParts.join(''), images };
    }
    return { text: String(content), images: [] };
}

/**
 * Parse a data: URL into raw bytes and MIME type.
 * Returns null for http(s):// URLs.
 * @param {string} url
 * @returns {{ data: Uint8Array, mimeType: string }|null}
 */
function parseDataUrl(url) {
    if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            return {
                mimeType: match[1],
                data: new Uint8Array(Buffer.from(match[2], 'base64')),
            };
        }
    }
    return null;
}

/**
 * Parse an OpenAI messages array into Cursor-friendly fields.
 *
 * @param {Array<{role: string, content: unknown, tool_call_id?: string}>} messages
 * @returns {{
 *   systemPrompt: string,
 *   userText: string,
 *   images: Array<{data: Uint8Array, mimeType: string}>,
 *   turns: Array<{userText: string, assistantText: string}>,
 *   toolResults: Array<{toolCallId: string, content: string}>
 * }}
 */
export function parseMessages(messages) {
    let systemPrompt = 'You are a helpful assistant.';
    const pairs = [];
    const toolResults = [];
    let images = [];

    const systemParts = messages
        .filter((m) => m.role === 'system')
        .map((m) => extractContent(m.content).text);
    if (systemParts.length > 0) systemPrompt = systemParts.join('\n');

    const nonSystem = messages.filter((m) => m.role !== 'system');
    let pendingUser = '';

    for (const msg of nonSystem) {
        if (msg.role === 'tool') {
            toolResults.push({
                toolCallId: msg.tool_call_id ?? '',
                content: extractContent(msg.content).text,
            });
        } else if (msg.role === 'user') {
            if (pendingUser) pairs.push({ userText: pendingUser, assistantText: '' });
            const parsed = extractContent(msg.content);
            pendingUser = parsed.text;
            images = parsed.images;
        } else if (msg.role === 'assistant') {
            if (pendingUser) {
                pairs.push({ userText: pendingUser, assistantText: extractContent(msg.content).text });
                pendingUser = '';
            }
        }
    }

    let lastUserText = '';
    if (pendingUser) {
        lastUserText = pendingUser;
    } else if (pairs.length > 0 && toolResults.length === 0) {
        const last = pairs.pop();
        lastUserText = last.userText;
    }

    return { systemPrompt, userText: lastUserText, images, turns: pairs, toolResults };
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

/**
 * Convert OpenAI tool definitions to Cursor McpToolDefinition protobuf messages.
 * @param {Array<{type: string, function: {name: string, description?: string, parameters?: object}}>} tools
 * @returns {Array<object>} McpToolDefinition[]
 */
export function buildMcpToolDefinitions(tools) {
    return (tools || []).map((t) => {
        const fn = t.function;
        const jsonSchema = (fn.parameters && typeof fn.parameters === 'object')
            ? fn.parameters
            : { type: 'object', properties: {}, required: [] };
        const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
        return create(McpToolDefinitionSchema, {
            name: fn.name,
            description: fn.description || '',
            providerIdentifier: 'alma',
            toolName: fn.name,
            inputSchema,
        });
    });
}

function decodeMcpArgValue(value) {
    try { return toJson(ValueSchema, fromBinary(ValueSchema, value)); } catch {}
    return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args) {
    const decoded = {};
    for (const [key, value] of Object.entries(args ?? {})) {
        decoded[key] = decodeMcpArgValue(value);
    }
    return decoded;
}

// ============================================================================
// Request building
// ============================================================================

/**
 * Build a framed AgentClientMessage binary payload from OpenAI-style inputs.
 *
 * @param {object} options
 * @param {string} options.modelId
 * @param {string} options.systemPrompt
 * @param {string} options.userText
 * @param {Array<{data: Uint8Array, mimeType: string}>} options.images
 * @param {Array<{userText: string, assistantText: string}>} options.turns
 * @param {Array<object>} [options.mcpTools]  - McpToolDefinition[]
 * @returns {{ requestBytes: Uint8Array, blobStore: Map<string, Uint8Array>, mcpTools: Array<object> }}
 */
export function buildCursorAgentRequest({ modelId, systemPrompt, userText, images, turns, mcpTools = [] }) {
    const blobStore = new Map();
    const turnBytes = [];

    for (const turn of turns) {
        const userMsg = create(UserMessageSchema, { text: turn.userText, messageId: randomUUID() });
        const stepBytes = [];
        if (turn.assistantText) {
            stepBytes.push(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
                message: {
                    case: 'assistantMessage',
                    value: create(AssistantMessageSchema, { text: turn.assistantText }),
                },
            })));
        }
        const agentTurn = create(AgentConversationTurnStructureSchema, {
            userMessage: toBinary(UserMessageSchema, userMsg),
            steps: stepBytes,
        });
        turnBytes.push(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
            turn: { case: 'agentConversationTurn', value: agentTurn },
        })));
    }

    // System prompt → blob store
    const systemJson = JSON.stringify({ role: 'system', content: systemPrompt });
    const systemBytes = new TextEncoder().encode(systemJson);
    const systemBlobId = new Uint8Array(createHash('sha256').update(systemBytes).digest());
    blobStore.set(Buffer.from(systemBlobId).toString('hex'), systemBytes);

    const conversationState = create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemBlobId],
        turns: turnBytes,
        todos: [],
        pendingToolCalls: [],
        previousWorkspaceUris: [],
        fileStates: {},
        fileStatesV2: {},
        summaryArchives: [],
        turnTimings: [],
        subagentStates: {},
        selfSummaryCount: 0,
        readPaths: [],
    });

    // User message (with optional images)
    const userMessage = create(UserMessageSchema, { text: userText, messageId: randomUUID() });
    if (images && images.length > 0) {
        const selectedImages = images.map((img) =>
            create(SelectedImageSchema, {
                uuid: randomUUID(),
                mimeType: img.mimeType,
                dataOrBlobId: { case: 'data', value: img.data },
            })
        );
        userMessage.selectedContext = create(SelectedContextSchema, { selectedImages });
    }

    const action = create(ConversationActionSchema, {
        action: {
            case: 'userMessageAction',
            value: create(UserMessageActionSchema, { userMessage }),
        },
    });
    const modelDetails = create(ModelDetailsSchema, {
        modelId,
        displayModelId: modelId,
        displayName: modelId,
    });
    const runRequest = create(AgentRunRequestSchema, {
        conversationState,
        action,
        modelDetails,
        conversationId: randomUUID(),
    });
    const clientMessage = create(AgentClientMessageSchema, {
        message: { case: 'runRequest', value: runRequest },
    });

    return {
        requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
        blobStore,
        mcpTools,
    };
}

// ============================================================================
// Heartbeat
// ============================================================================

/**
 * Build a framed heartbeat message.
 * @returns {Buffer}
 */
export function buildHeartbeatBytes() {
    return frameConnectMessage(
        toBinary(
            AgentClientMessageSchema,
            create(AgentClientMessageSchema, {
                message: {
                    case: 'clientHeartbeat',
                    value: create(ClientHeartbeatSchema, {}),
                },
            })
        )
    );
}

// ============================================================================
// KV / Exec message handlers
// ============================================================================

/**
 * Handle a KV server message and send the appropriate client response.
 * @param {object} kv - KvServerMessage
 * @param {Map<string, Uint8Array>} blobStore
 * @param {(data: Buffer) => void} sendFrame
 */
function handleKvMessage(kv, blobStore, sendFrame) {
    if (kv.message.case === 'getBlobArgs') {
        const blobData = blobStore.get(Buffer.from(kv.message.value.blobId).toString('hex'));
        const r = create(KvClientMessageSchema, {
            id: kv.id,
            message: {
                case: 'getBlobResult',
                value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
            },
        });
        sendFrame(frameConnectMessage(
            toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
                message: { case: 'kvClientMessage', value: r },
            }))
        ));
    } else if (kv.message.case === 'setBlobArgs') {
        blobStore.set(
            Buffer.from(kv.message.value.blobId).toString('hex'),
            kv.message.value.blobData
        );
        const r = create(KvClientMessageSchema, {
            id: kv.id,
            message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) },
        });
        sendFrame(frameConnectMessage(
            toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
                message: { case: 'kvClientMessage', value: r },
            }))
        ));
    }
}

/**
 * Send an exec response frame.
 */
function sendExec(exec, messageCase, messageValue, sendFrame) {
    sendFrame(frameConnectMessage(
        toBinary(AgentClientMessageSchema,
            create(AgentClientMessageSchema, {
                message: {
                    case: 'execClientMessage',
                    value: create(ExecClientMessageSchema, {
                        id: exec.id,
                        execId: exec.execId,
                        message: { case: messageCase, value: messageValue },
                    }),
                },
            })
        )
    ));
}

/**
 * Handle an exec server message. For filesystem/shell operations, returns
 * a "not available" rejection. For MCP exec, calls onMcpExec.
 *
 * @param {object} exec - ExecServerMessage
 * @param {Array<object>} mcpTools
 * @param {(data: Buffer) => void} sendFrame
 * @param {(pendingExec: object) => void} onMcpExec
 */
function handleExecMessage(exec, mcpTools, sendFrame, onMcpExec) {
    const c = exec.message.case;
    const R = 'Tool not available in this environment. Use the MCP tools provided instead.';

    if (c === 'requestContextArgs') {
        const ctx = create(RequestContextSchema, {
            rules: [],
            repositoryInfo: [],
            tools: mcpTools,
            gitRepos: [],
            projectLayouts: [],
            mcpInstructions: [],
            fileContents: {},
            customSubagents: [],
        });
        sendExec(exec, 'requestContextResult',
            create(RequestContextResultSchema, {
                result: {
                    case: 'success',
                    value: create(RequestContextSuccessSchema, { requestContext: ctx }),
                },
            }), sendFrame);
    } else if (c === 'mcpArgs') {
        const a = exec.message.value;
        const toolName = a.toolName || a.name;
        let decodedArgs = decodeMcpArgsMap(a.args);
        // R7: Tool argument auto-repair (enabled by default, disable via CURSOR_TOOL_FIX_ENABLED=false)
        if (process.env.CURSOR_TOOL_FIX_ENABLED !== 'false') {
            decodedArgs = fixToolCallArguments(toolName, decodedArgs);
        }
        onMcpExec({
            execId: exec.execId,
            execMsgId: exec.id,
            toolCallId: a.toolCallId || randomUUID(),
            toolName,
            decodedArgs: JSON.stringify(decodedArgs),
        });
    } else if (c === 'readArgs') {
        sendExec(exec, 'readResult', create(ReadResultSchema, {
            result: { case: 'rejected', value: create(ReadRejectedSchema, { path: exec.message.value.path, reason: R }) },
        }), sendFrame);
    } else if (c === 'lsArgs') {
        sendExec(exec, 'lsResult', create(LsResultSchema, {
            result: { case: 'rejected', value: create(LsRejectedSchema, { path: exec.message.value.path, reason: R }) },
        }), sendFrame);
    } else if (c === 'grepArgs') {
        sendExec(exec, 'grepResult', create(GrepResultSchema, {
            result: { case: 'error', value: create(GrepErrorSchema, { error: R }) },
        }), sendFrame);
    } else if (c === 'writeArgs') {
        sendExec(exec, 'writeResult', create(WriteResultSchema, {
            result: { case: 'rejected', value: create(WriteRejectedSchema, { path: exec.message.value.path, reason: R }) },
        }), sendFrame);
    } else if (c === 'deleteArgs') {
        sendExec(exec, 'deleteResult', create(DeleteResultSchema, {
            result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: exec.message.value.path, reason: R }) },
        }), sendFrame);
    } else if (c === 'shellArgs' || c === 'shellStreamArgs') {
        const a = exec.message.value;
        sendExec(exec, 'shellResult', create(ShellResultSchema, {
            result: { case: 'rejected', value: create(ShellRejectedSchema, { command: a.command ?? '', workingDirectory: a.workingDirectory ?? '', reason: R, isReadonly: false }) },
        }), sendFrame);
    } else if (c === 'backgroundShellSpawnArgs') {
        const a = exec.message.value;
        sendExec(exec, 'backgroundShellSpawnResult', create(BackgroundShellSpawnResultSchema, {
            result: { case: 'rejected', value: create(ShellRejectedSchema, { command: a.command ?? '', workingDirectory: a.workingDirectory ?? '', reason: R, isReadonly: false }) },
        }), sendFrame);
    } else if (c === 'writeShellStdinArgs') {
        sendExec(exec, 'writeShellStdinResult', create(WriteShellStdinResultSchema, {
            result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error: R }) },
        }), sendFrame);
    } else if (c === 'fetchArgs') {
        sendExec(exec, 'fetchResult', create(FetchResultSchema, {
            result: { case: 'error', value: create(FetchErrorSchema, { url: exec.message.value.url ?? '', error: R }) },
        }), sendFrame);
    } else if (c === 'diagnosticsArgs') {
        sendExec(exec, 'diagnosticsResult', create(DiagnosticsResultSchema, {}), sendFrame);
    } else {
        const fallbackCases = {
            listMcpResourcesExecArgs: 'listMcpResourcesExecResult',
            readMcpResourceExecArgs: 'readMcpResourceExecResult',
            recordScreenArgs: 'recordScreenResult',
            computerUseArgs: 'computerUseResult',
        };
        if (fallbackCases[c]) {
            sendExec(exec, fallbackCases[c], create(McpResultSchema, {}), sendFrame);
        }
    }
}

// ============================================================================
// Server message processing
// ============================================================================

/**
 * Process a single AgentServerMessage and dispatch callbacks.
 *
 * @param {Uint8Array} msgBytes - raw protobuf bytes (without Connect 5-byte header)
 * @param {object} callbacks
 * @param {Map<string, Uint8Array>} callbacks.blobStore
 * @param {Array<object>} callbacks.mcpTools
 * @param {(data: Buffer) => void} callbacks.sendFrame
 * @param {(text: string, isThinking: boolean) => void} callbacks.onText
 * @param {(pendingExec: object) => void} callbacks.onMcpExec
 */
export function processAgentServerMessage(msgBytes, callbacks) {
    const { blobStore, mcpTools, sendFrame, onText, onMcpExec } = callbacks;
    const msg = fromBinary(AgentServerMessageSchema, msgBytes);
    const c = msg.message.case;

    if (c === 'interactionUpdate') {
        const u = msg.message.value.message;
        if (u?.case === 'textDelta' && u.value.text) onText(u.value.text, false);
        else if (u?.case === 'thinkingDelta' && u.value.text) onText(u.value.text, true);
    } else if (c === 'kvServerMessage') {
        handleKvMessage(msg.message.value, blobStore, sendFrame);
    } else if (c === 'execServerMessage') {
        handleExecMessage(msg.message.value, mcpTools, sendFrame, onMcpExec);
    }
}

// ============================================================================
// Tool result resume helpers
// ============================================================================

/**
 * Build the tool result frames that should be sent back to the Cursor server
 * when resuming a session with tool results.
 *
 * @param {Array<{execId: string, execMsgId: string, toolCallId: string, toolName: string, decodedArgs: string}>} pendingExecs
 * @param {Array<{toolCallId: string, content: string}>} toolResults
 * @returns {Buffer[]} array of framed binary messages to write to the H2 stream
 */
export function buildToolResultFrames(pendingExecs, toolResults) {
    return pendingExecs.map((exec) => {
        const result = toolResults.find((r) => r.toolCallId === exec.toolCallId);
        const mcpResult = result
            ? create(McpResultSchema, {
                result: {
                    case: 'success',
                    value: create(McpSuccessSchema, {
                        content: [create(McpToolResultContentItemSchema, {
                            content: {
                                case: 'text',
                                value: create(McpTextContentSchema, { text: result.content }),
                            },
                        })],
                        isError: false,
                    }),
                },
            })
            : create(McpResultSchema, {
                result: {
                    case: 'error',
                    value: create(McpErrorSchema, { error: 'Tool result not provided' }),
                },
            });

        const cm = create(AgentClientMessageSchema, {
            message: {
                case: 'execClientMessage',
                value: create(ExecClientMessageSchema, {
                    id: exec.execMsgId,
                    execId: exec.execId,
                    message: { case: 'mcpResult', value: mcpResult },
                }),
            },
        });
        return frameConnectMessage(toBinary(AgentClientMessageSchema, cm));
    });
}

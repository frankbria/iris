import WebSocket, { WebSocketServer } from 'ws';
import { translateSync, translate, Action } from './translator';
import { ActionExecutor, ExecutionResult, ActionExecutorOptions } from './executor';
import { Page } from 'playwright';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface BrowserSession {
  executor: ActionExecutor;
  page: Page | null;
  isActive: boolean;
  lastActivity: number;
}

export interface BrowserStatus {
  isActive: boolean;
  hasPage: boolean;
  lastActivity: number;
  context?: {
    url?: string;
    title?: string;
  };
}

/**
 * Start a JSON-RPC 2.0 over WebSocket server on the given port.
 */
export function startServer(port: number, options?: { sessionTimeout?: number }): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const sessions = new Map<WebSocket, BrowserSession>();
  const sessionTimeout = options?.sessionTimeout || 30 * 60 * 1000; // 30 minutes default

  // Cleanup inactive sessions periodically
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ws, session] of sessions.entries()) {
      if (now - session.lastActivity > sessionTimeout) {
        cleanupSession(ws, sessions);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return;
      }

      const res: JsonRpcResponse = { jsonrpc: '2.0', id: req.id };

      try {
        switch (req.method) {
          case 'executeCommand': {
            const { instruction } = req.params;
            res.result = translateSync(instruction);
            break;
          }

          case 'launchBrowser': {
            const { options: browserOptions } = req.params || {};
            const session = await createBrowserSession(browserOptions);
            sessions.set(ws, session);
            res.result = {
              success: true,
              message: 'Browser launched successfully',
              sessionId: getSessionId(ws)
            };
            break;
          }

          case 'closeBrowser': {
            const session = sessions.get(ws);
            if (!session) {
              throw { code: -32000, message: 'No active browser session' };
            }
            await cleanupSession(ws, sessions);
            res.result = { success: true, message: 'Browser closed successfully' };
            break;
          }

          case 'getBrowserStatus': {
            const session = sessions.get(ws);
            res.result = await getBrowserSessionStatus(session);
            break;
          }

          case 'executeBrowserAction': {
            const { instruction, actions, url } = req.params;
            const session = sessions.get(ws);

            if (!session) {
              throw { code: -32000, message: 'No active browser session. Call launchBrowser first.' };
            }

            const result = await executeBrowserActions(session, instruction, actions, url);
            res.result = result;
            break;
          }

          case 'getStatus': {
            res.result = { status: 'ready' };
            break;
          }

          case 'streamLogs': {
            res.result = ['log1', 'log2'];
            break;
          }

          default:
            throw { code: -32601, message: 'Method not found' };
        }
      } catch (err: any) {
        res.error = {
          code: err.code || -32000,
          message: err.message || 'Server error',
          data: err.data
        };
      }

      ws.send(JSON.stringify(res));
    });

    ws.on('close', () => {
      cleanupSession(ws, sessions);
    });

    ws.on('error', () => {
      cleanupSession(ws, sessions);
    });
  });

  wss.on('close', () => {
    clearInterval(cleanupInterval);
    // Cleanup all sessions
    for (const [ws] of sessions.entries()) {
      cleanupSession(ws, sessions);
    }
  });

  return wss;
}

/**
 * Create a new browser session with ActionExecutor
 */
async function createBrowserSession(browserOptions?: ActionExecutorOptions): Promise<BrowserSession> {
  const executor = new ActionExecutor(browserOptions);

  const session: BrowserSession = {
    executor,
    page: null,
    isActive: true,
    lastActivity: Date.now(),
  };

  return session;
}

/**
 * Execute browser actions using the session's ActionExecutor
 */
async function executeBrowserActions(
  session: BrowserSession,
  instruction?: string,
  actions?: Action[],
  url?: string
): Promise<{
  success: boolean;
  results: ExecutionResult[];
  translationResult?: any;
  error?: string;
}> {
  try {
    session.lastActivity = Date.now();

    // Create page if needed
    if (!session.page) {
      session.page = await session.executor.createPage();
    }

    let actionsToExecute: Action[] = [];
    let translationResult = null;

    // If instruction provided, translate it to actions
    if (instruction) {
      const translation = await translate(instruction, url ? { url } : undefined);
      translationResult = translation;
      actionsToExecute = translation.actions;
    } else if (actions) {
      // Use provided actions directly
      actionsToExecute = actions;
    } else {
      throw new Error('Either instruction or actions must be provided');
    }

    if (actionsToExecute.length === 0) {
      return {
        success: false,
        results: [],
        translationResult,
        error: 'No actions to execute'
      };
    }

    // Execute the actions
    const results = await session.executor.executeActions(actionsToExecute, session.page);

    const success = results.every(result => result.success);

    return {
      success,
      results,
      translationResult,
      error: success ? undefined : 'Some actions failed'
    };

  } catch (error) {
    return {
      success: false,
      results: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get browser session status
 */
async function getBrowserSessionStatus(session?: BrowserSession): Promise<BrowserStatus> {
  if (!session) {
    return {
      isActive: false,
      hasPage: false,
      lastActivity: 0
    };
  }

  const status: BrowserStatus = {
    isActive: session.isActive,
    hasPage: session.page !== null,
    lastActivity: session.lastActivity
  };

  // Get page context if available
  if (session.page) {
    try {
      const context = await session.executor.getPageContext(session.page);
      status.context = {
        url: context.url,
        title: context.title
      };
    } catch (error) {
      // Context retrieval failed, but status is still valid
    }
  }

  return status;
}

/**
 * Clean up a browser session
 */
async function cleanupSession(ws: WebSocket, sessions: Map<WebSocket, BrowserSession>): Promise<void> {
  const session = sessions.get(ws);
  if (session) {
    try {
      await session.executor.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
    sessions.delete(ws);
  }
}

/**
 * Generate a session ID for a WebSocket connection
 */
function getSessionId(ws: WebSocket): string {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

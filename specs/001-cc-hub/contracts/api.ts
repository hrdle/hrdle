/**
 * CC Hub API Contract
 *
 * Type definitions used by the Hono RPC client.
 * This file is a reference for the types inferred from the backend route definitions.
 */

import { z } from 'zod';

// =============================================================================
// Validation Schemas
// =============================================================================

// Auth
export const LoginSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8),
});

export const RegisterSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8),
});

// Sessions
export const CreateSessionSchema = z.object({
  name: z.string().min(1).max(64).optional(),
});

export const ResizeTerminalSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

// Push Subscription
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

// =============================================================================
// Response Types
// =============================================================================

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    username: string;
  };
}

export interface SessionResponse {
  id: string;
  name: string;
  createdAt: string;
  lastAccessedAt: string;
  state: 'idle' | 'working' | 'waiting_input' | 'waiting_permission' | 'disconnected';
}

export interface SessionListResponse {
  sessions: SessionResponse[];
}

export interface ErrorResponse {
  error: string;
  code?: string;
}

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * POST /api/auth/login
 * Body: LoginSchema
 * Response: AuthResponse
 */

/**
 * POST /api/auth/register
 * Body: RegisterSchema
 * Response: AuthResponse
 */

/**
 * POST /api/auth/logout
 * Headers: Authorization: Bearer {token}
 * Response: { success: true }
 */

/**
 * GET /api/sessions
 * Headers: Authorization: Bearer {token}
 * Response: SessionListResponse
 */

/**
 * POST /api/sessions
 * Headers: Authorization: Bearer {token}
 * Body: CreateSessionSchema
 * Response: SessionResponse
 */

/**
 * GET /api/sessions/:id
 * Headers: Authorization: Bearer {token}
 * Response: SessionResponse
 */

/**
 * DELETE /api/sessions/:id
 * Headers: Authorization: Bearer {token}
 * Response: { success: true }
 */

/**
 * POST /api/sessions/:id/resize
 * Headers: Authorization: Bearer {token}
 * Body: ResizeTerminalSchema
 * Response: { success: true }
 */

/**
 * GET /api/sessions/:id/state
 * Headers: Authorization: Bearer {token}
 * Response: { state: SessionState }
 */

/**
 * POST /api/push/subscribe
 * Headers: Authorization: Bearer {token}
 * Body: PushSubscriptionSchema
 * Response: { success: true }
 */

/**
 * DELETE /api/push/unsubscribe
 * Headers: Authorization: Bearer {token}
 * Response: { success: true }
 */

// =============================================================================
// WebSocket Endpoints
// =============================================================================

/**
 * WebSocket /ws/terminal/:sessionId
 *
 * Upgrade: websocket
 * Headers: Authorization: Bearer {token} (via query param or cookie)
 *
 * Client -> Server Messages:
 * - Binary data: Terminal input
 * - JSON: { type: 'resize', cols: number, rows: number }
 *
 * Server -> Client Messages:
 * - Binary data: Terminal output
 * - JSON: { type: 'state', state: SessionState }
 * - JSON: { type: 'error', message: string }
 */

/**
 * WebSocket /ws/notifications
 *
 * Server -> Client Messages:
 * - JSON: { type: 'state_change', sessionId: string, state: SessionState }
 * - JSON: { type: 'notification', title: string, body: string, sessionId: string }
 */

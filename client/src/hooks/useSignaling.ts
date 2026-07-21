import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@screenshare/server/protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseSignalingOptions {
  /** ws:// or wss:// URL. Defaults to a path relative to the current origin. */
  url?: string;
  /** Auto-reconnect with exponential backoff. Default true. */
  autoReconnect?: boolean;
}

export interface UseSignalingResult {
  status: ConnectionStatus;
  /** Last received error message from the server, if any. */
  lastError: string | null;
  send: (msg: ClientMessage) => void;
  /** Subscribe to incoming server messages. Returns an unsubscribe fn. */
  onMessage: (handler: (msg: ServerMessage) => void) => () => void;
  /** Explicit open/close for the user session. */
  connect: () => void;
  disconnect: () => void;
}

/**
 * Low-level signaling WebSocket hook.
 *
 * Provides a stable `send` and an event-bus-style `onMessage` subscription.
 * Higher-level hooks (useRoom, useVoice, useScreenShare) subscribe via
 * `onMessage` and emit via `send`.
 */
export function useSignaling(options: UseSignalingOptions = {}): UseSignalingResult {
  const { url, autoReconnect = true } = options;

  const resolvedUrl =
    url ??
    (typeof location !== 'undefined'
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : 'ws://localhost:3000/ws');

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);

  const dispatch = useCallback((msg: ServerMessage) => {
    for (const handler of handlersRef.current) {
      try {
        handler(msg);
      } catch (err) {
        // Handler errors must not break other subscribers.
        console.error('[signaling] handler threw', err);
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      console.debug('[signaling] connect() skipped — already open');
      return;
    }
    console.debug('[signaling] connect() → new WebSocket', resolvedUrl);

    intentionalCloseRef.current = false;
    setStatus('connecting');

    const ws = new WebSocket(resolvedUrl);
    wsRef.current = ws;

    // StrictMode guard: every handler below bails out unless this `ws` is
    // STILL the current connection. Otherwise a stale socket closed during
    // React's dev double-mount would clobber the fresh one's status.
    const isCurrent = () => wsRef.current === ws;

    ws.onopen = () => {
      console.debug('[signaling] onopen', { isCurrent: isCurrent() });
      if (!isCurrent()) return;
      reconnectAttemptRef.current = 0;
      setStatus('open');
      setLastError(null);
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === 'error') {
          setLastError(msg.payload.message);
        }
        dispatch(msg);
      } catch (err) {
        console.error('[signaling] invalid message', err);
      }
    };

    ws.onerror = (e) => {
      console.debug('[signaling] onerror', { isCurrent: isCurrent(), e });
      if (!isCurrent()) return;
      setStatus('error');
    };

    ws.onclose = (e) => {
      console.debug('[signaling] onclose', {
        isCurrent: isCurrent(),
        code: e.code,
        reason: e.reason,
        intentional: intentionalCloseRef.current,
      });
      if (!isCurrent()) return;
      setStatus('closed');
      wsRef.current = null;
      if (autoReconnect && !intentionalCloseRef.current) {
        const attempt = ++reconnectAttemptRef.current;
        const delay = Math.min(1000 * 2 ** attempt, 10_000);
        reconnectTimerRef.current = setTimeout(() => connect(), delay);
      }
    };
  }, [resolvedUrl, autoReconnect, dispatch]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('idle');
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[signaling] socket not open, dropping', msg.type);
      return;
    }
    ws.send(JSON.stringify(msg));
  }, []);

  const onMessage = useCallback((handler: (msg: ServerMessage) => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, lastError, send, onMessage, connect, disconnect };
}

import { useSyncExternalStore } from 'react';
import { ws } from '@/api/ws';
import type { ConnectionState } from '@deveye/types';

/**
 * Subscribe a React component to the live WebSocket connection state. Returns the
 * raw {@link ConnectionState}; pair it with `ws.hasConnected` to tell a genuine
 * drop apart from the very first connect (see the topbar `ConnectionStatus`).
 */
export function useConnectionState(): ConnectionState {
    return useSyncExternalStore(
        (cb) => ws.onStateChange(cb),
        () => ws.state,
        () => ws.state
    );
}

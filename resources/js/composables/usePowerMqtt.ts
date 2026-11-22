import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';

export interface MeterData {
    voltage: number;
    current: number;
    power_factor: number;
    total_power: number;
    total_energy: number;
    last_seen: number;
}

export interface PowerUpdatedPayload {
    meters: Record<string, MeterData>;
}

export interface MeterUpdatePayload extends MeterData {
    device_id: string;
}

interface ServerToClientEvents {
    'power.updated': (payload: PowerUpdatedPayload) => void;
    'meter:update': (payload: MeterUpdatePayload) => void;
    connect: () => void;
    disconnect: (reason: string) => void;
}

interface ClientToServerEvents {
    'meters:request': () => void;
}

type PowerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DEFAULT_SOCKET_URL = 'http://localhost:3001';

const socketUrl =
    (import.meta.env.VITE_SOCKET_IO_URL as string | undefined) ??
    DEFAULT_SOCKET_URL;

let socket: PowerSocket | null = null;

function getSocket(): PowerSocket {
    if (!socket) {
        socket = io(socketUrl, {
            transports: ['websocket', 'polling'],
            autoConnect: true,
            reconnection: true,
        }) as PowerSocket;
    }

    return socket;
}

/**
 * Listens to the Node.js power-monitoring service through Socket.IO.
 *
 * - `power.updated` delivers the full meter snapshot (also sent immediately by
 *   the server when a client connects and every 3 seconds after that).
 * - `meter:update` delivers a single real-time reading.
 *
 * The underlying Socket.IO connection is shared by every component, while each
 * caller gets its own reactive state and cleans up its listeners on unmount.
 */
export function usePowerMqtt(): {
    meters: Ref<Record<string, MeterData>>;
    connected: Ref<boolean>;
    lastUpdatedAt: Ref<number | null>;
} {
    const meters = ref<Record<string, MeterData>>({});
    const connected = ref(false);
    const lastUpdatedAt = ref<number | null>(null);

    // Socket.IO is browser-only; during SSR no connection is created.
    const activeSocket = typeof window === 'undefined' ? null : getSocket();

    const handleConnect = () => {
        connected.value = true;

        // Ask for a fresh snapshot right away (e.g. after a reconnect).
        activeSocket?.emit('meters:request');
    };

    const handleDisconnect = () => {
        connected.value = false;
    };

    const handlePowerUpdated = (payload: PowerUpdatedPayload) => {
        if (!payload?.meters) {
            return;
        }

        meters.value = payload.meters;
        lastUpdatedAt.value = Date.now();
    };

    const handleMeterUpdate = (payload: MeterUpdatePayload) => {
        if (!payload?.device_id) {
            return;
        }

        const { device_id: deviceId, ...reading } = payload;

        meters.value = {
            ...meters.value,
            [deviceId]: reading,
        };
        lastUpdatedAt.value = Date.now();
    };

    if (activeSocket) {
        connected.value = activeSocket.connected;
        activeSocket.on('connect', handleConnect);
        activeSocket.on('disconnect', handleDisconnect);
        activeSocket.on('power.updated', handlePowerUpdated);
        activeSocket.on('meter:update', handleMeterUpdate);

        // The server answers with a `power.updated` snapshot.
        activeSocket.emit('meters:request');

        if (getCurrentScope()) {
            onScopeDispose(() => {
                activeSocket.off('connect', handleConnect);
                activeSocket.off('disconnect', handleDisconnect);
                activeSocket.off('power.updated', handlePowerUpdated);
                activeSocket.off('meter:update', handleMeterUpdate);
            });
        }
    }

    return { meters, connected, lastUpdatedAt };
}

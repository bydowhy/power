/**
 * Power Monitoring System — MQTT / Redis / Socket.IO sidecar
 * ----------------------------------------------------------
 * Flow: ESP32 -> EMQX (WebSocket TLS / WSS) -> this service -> Redis + Socket.IO
 *
 * This service is the replacement for `php artisan mqtt:subscribe`
 * (app/Console/Commands/MqttSubscriber.php). Laravel keeps handling the UI/API and
 * the shift cronjob, which reads the exact same Redis keys.
 *
 * REDIS CONTRACT — must stay identical to MqttSubscriber.php:
 *   HSET  meter:{device_id}:latest  voltage current power_factor total_power total_energy last_seen
 *         - every value is a string, `last_seen` is the Unix timestamp in SECONDS (PHP time()).
 *   ZADD  meter:{device_id}:history  <unix-seconds>  <raw JSON message>
 *   ZREMRANGEBYSCORE meter:{device_id}:history  -inf  <now - 1800>
 *   EXPIRE meter:{device_id}:history  1900
 *
 * IMPORTANT: Laravel's Redis client applies a key prefix
 * (config/database.php -> Str::slug(APP_NAME).'-database-', here "laravel-database-").
 * The subcommands above are sent with that prefix by the Laravel facade, so the
 * physical keys are e.g. "laravel-database-meter:sensor_sim_01:latest".
 * We prepend REDIS_PREFIX manually for exactly that reason; without it the Laravel
 * cronjob/API would never see the data.
 *
 * Socket.IO events emitted on port 3001 (see .env):
 *   power.updated  { meters: { [deviceId]: { voltage, current, power_factor,
 *                                           total_power, total_energy, last_seen } } }
 *                  - full snapshot every SOCKET_IO_BROADCAST_INTERVAL_MS (old Reverb
 *                    event name/payload, so the Vue migration stays small).
 *   meter:update   { device_id, voltage, current, power_factor, total_power,
 *                    total_energy, last_seen }
 *                  - immediately after every successfully stored MQTT reading.
 *   meters:request - client -> server; replies with power.updated snapshot (ack supported).
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import process from 'node:process';

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import Redis from 'ioredis';
import mqtt from 'mqtt';
import { Server as SocketIOServer } from 'socket.io';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Always load mqtt-service/.env, regardless of the current working directory.
dotenv.config({ path: join(__dirname, '.env') });

const HISTORY_WINDOW_SECONDS = 1800; // 30 minutes — same as MqttSubscriber.php
const HISTORY_TTL_SECONDS = 1900; // safety TTL — same as MqttSubscriber.php
const DEFAULT_REDIS_PREFIX = 'laravel-database-';

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function readEnv(name) {
    const value = process.env[name];

    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed === '' ? undefined : trimmed;
}

function readOptionalSecret(name) {
    const value = readEnv(name);

    if (value === undefined || ['null', 'nil', '~'].includes(value.toLowerCase())) {
        return undefined;
    }

    return value;
}

function readInt(name, fallback) {
    const value = readEnv(name);

    if (value === undefined) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name, fallback) {
    const value = readEnv(name);

    if (value === undefined) {
        return fallback;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function resolveMqttUrl() {
    const explicitUrl = readEnv('MQTT_URL');

    if (explicitUrl) {
        return explicitUrl;
    }

    const protocol = (readEnv('MQTT_PROTOCOL') ?? 'wss').toLowerCase();
    const host = readEnv('MQTT_HOST') ?? 'emqx.bydowhy.web.id';
    const defaultPort = protocol === 'wss' || protocol === 'mqtts' ? 443 : 8083;
    const port = readInt('MQTT_PORT', defaultPort);
    const rawPath = readEnv('MQTT_PATH') ?? '/mqtt';
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

    return `${protocol}://${host}:${port}${path}`;
}

function resolveCorsOrigin() {
    const raw = readEnv('SOCKET_IO_CORS_ORIGIN') ?? '*';

    if (raw === '*') {
        return '*';
    }

    const origins = raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    return origins.length > 0 ? origins : '*';
}

function resolveTlsCa() {
    const caFile = readEnv('MQTT_TLS_CA_FILE');

    if (!caFile) {
        return undefined;
    }

    const absolutePath = isAbsolute(caFile) ? caFile : join(__dirname, caFile);

    try {
        return readFileSync(absolutePath);
    } catch (error) {
        throw new Error(`Unable to read MQTT_TLS_CA_FILE "${absolutePath}": ${error.message}`);
    }
}

const redisPrefix =
    process.env.REDIS_PREFIX !== undefined
        ? process.env.REDIS_PREFIX.trim()
        : DEFAULT_REDIS_PREFIX;

const CONFIG = {
    logLevel: (readEnv('LOG_LEVEL') ?? 'info').toLowerCase(),
    logMessages: readBoolean('LOG_MQTT_MESSAGES', false),
    maxPendingMessages: readInt('MAX_PENDING_MESSAGES', 1000),
    meterCacheTtlSeconds: readInt('METER_CACHE_TTL_SECONDS', 3600),
    socket: {
        host: readEnv('SOCKET_IO_HOST') ?? '0.0.0.0',
        port: readInt('SOCKET_IO_PORT', 3001),
        corsOrigin: resolveCorsOrigin(),
        broadcastIntervalMs: readInt('SOCKET_IO_BROADCAST_INTERVAL_MS', 3000),
    },
    mqtt: {
        url: resolveMqttUrl(),
        topic: readEnv('MQTT_TOPIC') ?? 'energy/meter',
        qos: readInt('MQTT_QOS', 0),
        clientId: readEnv('MQTT_CLIENT_ID') ?? 'node-mqtt-service_001',
        username: readOptionalSecret('MQTT_AUTH_USERNAME') ?? readOptionalSecret('MQTT_USERNAME'),
        password: readOptionalSecret('MQTT_AUTH_PASSWORD') ?? readOptionalSecret('MQTT_PASSWORD'),
        cleanSession: readBoolean('MQTT_CLEAN_SESSION', true),
        keepalive: readInt('MQTT_KEEPALIVE', 60),
        connectTimeout: readInt('MQTT_CONNECT_TIMEOUT', 10000),
        reconnectPeriod: readInt('MQTT_RECONNECT_PERIOD', 5000),
        protocolVersion: readInt('MQTT_PROTOCOL_VERSION', 4),
        rejectUnauthorized: readBoolean('MQTT_TLS_REJECT_UNAUTHORIZED', true),
        ca: undefined,
    },
    redis: {
        host: readEnv('REDIS_HOST') ?? '127.0.0.1',
        port: readInt('REDIS_PORT', 6379),
        username: readOptionalSecret('REDIS_USERNAME'),
        password: readOptionalSecret('REDIS_PASSWORD'),
        db: readInt('REDIS_DB', 0),
        prefix: redisPrefix,
    },
};

// Fail fast on a misconfigured TLS certificate file.
if (CONFIG.mqtt.ca === undefined && /^(wss|mqtts|ssl|tls):/i.test(CONFIG.mqtt.url)) {
    CONFIG.mqtt.ca = resolveTlsCa();
}

const redisKey = (key) => `${CONFIG.redis.prefix}${key}`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const threshold = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.info;

function log(level, message, meta) {
    if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < threshold) {
        return;
    }

    const timestamp = new Date().toISOString();
    let suffix = '';

    if (meta !== undefined) {
        try {
            suffix = ` ${JSON.stringify(meta)}`;
        } catch {
            suffix = ' [meta not serialisable]';
        }
    }

    const line = `${timestamp} [${level.toUpperCase()}] ${message}${suffix}`;

    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

const throttledAt = new Map();

/** Logs at most once per `intervalMs` for a given key (avoids error floods). */
function logThrottled(key, intervalMs, level, message, meta) {
    const now = Date.now();
    const last = throttledAt.get(key) ?? 0;

    if (now - last < intervalMs) {
        return;
    }

    throttledAt.set(key, now);
    log(level, message, meta);
}

function truncate(value, maxLength) {
    if (typeof value !== 'string' || value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}… (${value.length} chars)`;
}

function redactUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const hasCredentials = url.username || url.password;

        if (hasCredentials) {
            url.username = '***';
            url.password = '***';
        }

        return url.toString();
    } catch {
        return rawUrl;
    }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const state = {
    startedAt: Date.now(),
    mqttConnected: false,
    lastMessageAt: null,
    lastStoredAt: null,
    messagesReceived: 0,
    messagesStored: 0,
    invalidMessages: 0,
    storeErrors: 0,
    historyErrors: 0,
    droppedMessages: 0,
    meters: new Map(),
};

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

const redis = new Redis({
    host: CONFIG.redis.host,
    port: CONFIG.redis.port,
    username: CONFIG.redis.username,
    password: CONFIG.redis.password,
    db: CONFIG.redis.db,
    // Commands are serialised per message below, so fail fast instead of buffering
    // seconds of readings in memory while Redis is unreachable.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 3000),
    // The prefix is applied manually via redisKey(); ioredis must not add its own.
});

redis.on('ready', () => {
    log('info', 'Redis connected', {
        host: CONFIG.redis.host,
        port: CONFIG.redis.port,
        db: CONFIG.redis.db,
        prefix: CONFIG.redis.prefix,
    });
});

redis.on('reconnecting', () => {
    logThrottled('redis-reconnecting', 10000, 'warn', 'Redis reconnecting...');
});

redis.on('error', (error) => {
    logThrottled('redis-error', 10000, 'error', `Redis error: ${error.message}`);
});

redis.on('end', () => {
    log('warn', 'Redis connection closed');
});

// ---------------------------------------------------------------------------
// Parsing / PHP-compatible formatting
// ---------------------------------------------------------------------------

/**
 * Reproduces PHP's `(string) ($value ?? 0)` cast used by MqttSubscriber.php:
 *  - missing / null  -> "0"
 *  - boolean         -> "1" / ""
 *  - array / object  -> "Array" (PHP emits a notice, but this is what it stores)
 */
function phpStringCast(value) {
    if (value === null || value === undefined) {
        return '0';
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '';
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return '0';
        }

        return String(value);
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value) || typeof value === 'object') {
        return 'Array';
    }

    return String(value);
}

function toNumber(value) {
    const parsed = Number.parseFloat(value);

    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Validates and normalises an MQTT payload the same way MqttSubscriber.php does:
 * JSON must decode, must be a non-empty object, and must contain `device_id`.
 */
function parseReading(rawMessage) {
    let data;

    try {
        data = JSON.parse(rawMessage);
    } catch (error) {
        return { error: `invalid JSON (${error.message})` };
    }

    // PHP: if (!$data) { error } — empty objects/arrays are falsy there.
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        return { error: 'JSON payload is empty or not an object' };
    }

    const deviceId = data.device_id;

    if (deviceId === undefined || deviceId === null) {
        return { error: "field 'device_id' not found in JSON" };
    }

    if (typeof deviceId !== 'string' && typeof deviceId !== 'number') {
        return { error: "field 'device_id' must be a string or a number" };
    }

    const meterId = String(deviceId);

    if (meterId.trim() === '') {
        return { error: "field 'device_id' is empty" };
    }

    return {
        meterId,
        metrics: {
            voltage: phpStringCast(data.voltage),
            current: phpStringCast(data.current),
            power_factor: phpStringCast(data.power_factor),
            total_power: phpStringCast(data.total_power),
            total_energy: phpStringCast(data.total_energy),
        },
    };
}

// ---------------------------------------------------------------------------
// Redis writes (identical contract to MqttSubscriber.php)
// ---------------------------------------------------------------------------

/**
 * Writes one reading to Redis.
 *
 * @returns {Promise<boolean>} true when the `:latest` hash was written successfully.
 */
async function writeReadingToRedis(reading, rawMessage, nowSeconds) {
    const latestKey = redisKey(`meter:${reading.meterId}:latest`);
    const historyKey = redisKey(`meter:${reading.meterId}:history`);
    let latestWritten = false;

    // 1) Latest snapshot (HMSET in the old PHP code; HSET with multiple fields is
    //    equivalent and supported by every modern Redis).
    try {
        await redis.hset(latestKey, {
            ...reading.metrics,
            last_seen: String(nowSeconds),
        });

        latestWritten = true;
    } catch (error) {
        state.storeErrors += 1;
        logThrottled('redis-hset-error', 5000, 'error', `Failed to save latest meter data: ${error.message}`, {
            meter_id: reading.meterId,
        });
    }

    // 2) 30-minute history sorted set. The old command wrote this block even when
    //    the hash write failed (duplicated block at the end of handle()), so history
    //    is attempted independently here as well.
    try {
        const results = await redis
            .pipeline()
            .zadd(historyKey, nowSeconds, rawMessage)
            .zremrangebyscore(historyKey, '-inf', nowSeconds - HISTORY_WINDOW_SECONDS)
            .expire(historyKey, HISTORY_TTL_SECONDS)
            .exec();

        const failed = results?.find(([error]) => error);

        if (failed) {
            throw failed[0];
        }
    } catch (error) {
        state.historyErrors += 1;
        logThrottled('redis-history-error', 5000, 'error', `Failed to save meter history: ${error.message}`, {
            meter_id: reading.meterId,
        });
    }

    return latestWritten;
}

// ---------------------------------------------------------------------------
// Socket.IO payloads
// ---------------------------------------------------------------------------

function meterPayload(entry) {
    return {
        voltage: toNumber(entry.metrics.voltage),
        current: toNumber(entry.metrics.current),
        power_factor: toNumber(entry.metrics.power_factor),
        total_power: toNumber(entry.metrics.total_power),
        total_energy: toNumber(entry.metrics.total_energy),
        last_seen: entry.last_seen,
    };
}

/** Same shape the old `PowerMeterUpdated` event delivered: { [meterId]: {...} }. */
function buildMetersSnapshot() {
    const meters = {};

    for (const [meterId, entry] of state.meters) {
        meters[meterId] = meterPayload(entry);
    }

    return meters;
}

function pruneStaleMeters() {
    const cutoff = Date.now() - CONFIG.meterCacheTtlSeconds * 1000;

    for (const [meterId, entry] of state.meters) {
        if (entry.receivedAt < cutoff) {
            state.meters.delete(meterId);
        }
    }
}

// ---------------------------------------------------------------------------
// Message processing (serialised, so `latest` can never be overwritten out of order)
// ---------------------------------------------------------------------------

let io;
let broadcastTimer;

let queueTail = Promise.resolve();
let queueDepth = 0;

function enqueueMessage(rawMessage) {
    if (queueDepth >= CONFIG.maxPendingMessages) {
        state.droppedMessages += 1;
        logThrottled('queue-overflow', 5000, 'warn', 'Message queue is full; dropping MQTT message', {
            pending: queueDepth,
            dropped_total: state.droppedMessages,
        });

        return;
    }

    queueDepth += 1;

    queueTail = queueTail
        .then(() => processMessage(rawMessage))
        .catch((error) => {
            log('error', `Unhandled error while processing MQTT message: ${error.message}`);
        })
        .finally(() => {
            queueDepth -= 1;
        });
}

async function processMessage(rawMessage) {
    state.messagesReceived += 1;
    state.lastMessageAt = Date.now();

    if (CONFIG.logMessages) {
        log('debug', 'MQTT message received', { payload: truncate(rawMessage, 300) });
    }

    const reading = parseReading(rawMessage);

    if (reading.error) {
        state.invalidMessages += 1;
        log('warn', `Skipping MQTT message: ${reading.error}`, {
            payload: truncate(rawMessage, 300),
        });

        return;
    }

    // PHP time(): Unix timestamp in seconds, shared by the hash and the sorted set.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stored = await writeReadingToRedis(reading, rawMessage, nowSeconds);

    if (!stored) {
        return;
    }

    state.messagesStored += 1;
    state.lastStoredAt = Date.now();
    state.meters.set(reading.meterId, {
        metrics: reading.metrics,
        last_seen: nowSeconds,
        receivedAt: Date.now(),
    });

    // Optional low-latency event; the periodic `power.updated` snapshot remains the
    // primary feed and matches the previous Reverb payload.
    io?.emit('meter:update', {
        device_id: reading.meterId,
        ...meterPayload(state.meters.get(reading.meterId)),
    });

    if (CONFIG.logMessages) {
        log('debug', `Stored reading for meter: ${reading.meterId}`, {
            last_seen: nowSeconds,
        });
    }
}

// ---------------------------------------------------------------------------
// HTTP + Socket.IO server
// ---------------------------------------------------------------------------

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: CONFIG.socket.corsOrigin }));
app.use(express.json({ limit: '256kb' }));

app.get('/', (_request, response) => {
    response.json({
        service: 'power-mqtt-service',
        version: '1.0.0',
        endpoints: ['/health', '/api/meters'],
        socket_io: {
            port: CONFIG.socket.port,
            events: ['power.updated', 'meter:update', 'meters:request'],
        },
    });
});

app.get('/health', async (_request, response) => {
    let redisPing = false;

    try {
        redisPing = (await redis.ping()) === 'PONG';
    } catch {
        redisPing = false;
    }

    const mqttConnected = state.mqttConnected;
    const healthy = redisPing && mqttConnected;

    response.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        uptime_seconds: Math.floor((Date.now() - state.startedAt) / 1000),
        mqtt: {
            connected: mqttConnected,
            broker: redactUrl(CONFIG.mqtt.url),
            topic: CONFIG.mqtt.topic,
            qos: CONFIG.mqtt.qos,
            client_id: CONFIG.mqtt.clientId,
        },
        redis: {
            connected: redis.status === 'ready',
            ping: redisPing,
            host: CONFIG.redis.host,
            port: CONFIG.redis.port,
            db: CONFIG.redis.db,
            prefix: CONFIG.redis.prefix,
        },
        meters_cached: state.meters.size,
        last_message_at: state.lastMessageAt ? new Date(state.lastMessageAt).toISOString() : null,
        last_stored_at: state.lastStoredAt ? new Date(state.lastStoredAt).toISOString() : null,
        counters: {
            received: state.messagesReceived,
            stored: state.messagesStored,
            invalid: state.invalidMessages,
            dropped: state.droppedMessages,
            store_errors: state.storeErrors,
            history_errors: state.historyErrors,
            queue_pending: queueDepth,
        },
    });
});

app.get('/api/meters', (_request, response) => {
    const meters = buildMetersSnapshot();

    response.json({
        count: Object.keys(meters).length,
        generated_at: new Date().toISOString(),
        meters,
    });
});

app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _request, response, _next) => {
    log('error', `HTTP request failed: ${error.message}`);

    response.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);

io = new SocketIOServer(server, {
    cors: {
        origin: CONFIG.socket.corsOrigin,
        methods: ['GET', 'POST'],
    },
    serveClient: false,
    pingInterval: 25000,
    pingTimeout: 20000,
});

io.on('connection', (socket) => {
    log('info', `Socket.IO client connected: ${socket.id}`, {
        transport: socket.conn.transport.name,
        clients: io.engine.clientsCount,
    });

    // Give new clients an immediate snapshot instead of waiting for the next tick.
    socket.emit('power.updated', { meters: buildMetersSnapshot() });

    socket.on('meters:request', (acknowledge) => {
        const payload = { meters: buildMetersSnapshot() };

        socket.emit('power.updated', payload);

        if (typeof acknowledge === 'function') {
            acknowledge(payload);
        }
    });

    socket.on('disconnect', (reason) => {
        log('info', `Socket.IO client disconnected: ${socket.id}`, { reason });
    });
});

function startBroadcastLoop() {
    broadcastTimer = setInterval(() => {
        pruneStaleMeters();

        if (state.meters.size === 0) {
            return;
        }

        io.emit('power.updated', { meters: buildMetersSnapshot() });
    }, CONFIG.socket.broadcastIntervalMs);
}

// ---------------------------------------------------------------------------
// MQTT client
// ---------------------------------------------------------------------------

let mqttClient;

function connectMqtt() {
    const options = {
        clientId: CONFIG.mqtt.clientId,
        clean: CONFIG.mqtt.cleanSession,
        keepalive: CONFIG.mqtt.keepalive,
        connectTimeout: CONFIG.mqtt.connectTimeout,
        reconnectPeriod: CONFIG.mqtt.reconnectPeriod,
        protocolVersion: CONFIG.mqtt.protocolVersion,
        resubscribe: false,
    };

    if (CONFIG.mqtt.username !== undefined) {
        options.username = CONFIG.mqtt.username;
    }

    if (CONFIG.mqtt.password !== undefined) {
        options.password = CONFIG.mqtt.password;
    }

    if (/^(wss|mqtts|ssl|tls):/i.test(CONFIG.mqtt.url)) {
        options.rejectUnauthorized = CONFIG.mqtt.rejectUnauthorized;

        if (CONFIG.mqtt.ca) {
            options.ca = CONFIG.mqtt.ca;
        }
    }

    log('info', 'Connecting to MQTT broker...', {
        broker: redactUrl(CONFIG.mqtt.url),
        topic: CONFIG.mqtt.topic,
        qos: CONFIG.mqtt.qos,
        client_id: CONFIG.mqtt.clientId,
    });

    try {
        mqttClient = mqtt.connect(CONFIG.mqtt.url, options);
    } catch (error) {
        log('error', `Invalid MQTT configuration: ${error.message}`);
        void shutdown('mqtt-configuration', 1);

        return;
    }

    mqttClient.on('connect', (connack) => {
        state.mqttConnected = true;
        log('info', 'MQTT connected', {
            broker: redactUrl(CONFIG.mqtt.url),
            session_present: connack?.sessionPresent ?? false,
        });

        mqttClient.subscribe(CONFIG.mqtt.topic, { qos: CONFIG.mqtt.qos }, (error, granted) => {
            if (error) {
                log('error', `MQTT subscribe failed: ${error.message}`, {
                    topic: CONFIG.mqtt.topic,
                });

                return;
            }

            const rejected = (granted ?? []).filter((grant) => grant.qos === 128);

            if (rejected.length > 0) {
                log('error', 'MQTT broker rejected the subscription', {
                    topics: rejected.map((grant) => grant.topic),
                });

                return;
            }

            log('info', `Subscribed to MQTT topic: ${CONFIG.mqtt.topic}`, {
                qos: CONFIG.mqtt.qos,
            });
        });
    });

    mqttClient.on('message', (_topic, payload) => {
        enqueueMessage(payload.toString('utf8'));
    });

    mqttClient.on('reconnect', () => {
        logThrottled('mqtt-reconnect', 15000, 'warn', 'MQTT reconnecting...');
    });

    mqttClient.on('offline', () => {
        state.mqttConnected = false;
        logThrottled('mqtt-offline', 15000, 'warn', 'MQTT client is offline');
    });

    mqttClient.on('close', () => {
        state.mqttConnected = false;
        logThrottled('mqtt-close', 15000, 'warn', 'MQTT connection closed');
    });

    mqttClient.on('error', (error) => {
        state.mqttConnected = false;
        logThrottled('mqtt-error', 15000, 'error', `MQTT error: ${error.message}`);
    });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    log('info', `Shutting down (${reason})...`);

    // Never hang forever on open sockets.
    const forceExitTimer = setTimeout(() => {
        log('warn', 'Forcing shutdown after 5s timeout');
        process.exit(exitCode);
    }, 5000);

    forceExitTimer.unref();

    if (broadcastTimer) {
        clearInterval(broadcastTimer);
    }

    try {
        mqttClient?.end(true);
    } catch {
        // ignore
    }

    // Close Socket.IO first: it disconnects keep-alive clients and closes the
    // underlying HTTP server, so `server.close()` cannot wait on them forever.
    try {
        await new Promise((resolve) => io?.close(() => resolve()) ?? resolve());
    } catch {
        // ignore
    }

    try {
        await new Promise((resolve) => server.close(() => resolve()));
    } catch {
        // ignore
    }

    try {
        await redis.quit();
    } catch {
        redis.disconnect();
    }

    clearTimeout(forceExitTimer);
    log('info', 'Shutdown complete');
    process.exit(exitCode);
}

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});

process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
    });
});

process.on('uncaughtException', (error) => {
    log('error', 'Uncaught exception', { error: error.message, stack: error.stack });
    void shutdown('uncaughtException', 1);
});

server.on('error', (error) => {
    log('error', `HTTP server error: ${error.message}`);
    void shutdown('http-server-error', 1);
});

server.listen(CONFIG.socket.port, CONFIG.socket.host, () => {
    log('info', `Socket.IO + HTTP listening on http://${CONFIG.socket.host}:${CONFIG.socket.port}`, {
        cors_origin: CONFIG.socket.corsOrigin,
        broadcast_interval_ms: CONFIG.socket.broadcastIntervalMs,
    });

    startBroadcastLoop();
    connectMqtt();
});

log('info', 'Power MQTT service starting', {
    node: process.version,
    redis: `${CONFIG.redis.host}:${CONFIG.redis.port}/${CONFIG.redis.db}`,
    redis_prefix: CONFIG.redis.prefix,
    mqtt_broker: redactUrl(CONFIG.mqtt.url),
    mqtt_topic: CONFIG.mqtt.topic,
});

// main.ts — git-forge entrypoint.
//
// The forge itself (routing, auth, git smart HTTP, REST v3, GraphQL v4,
// MCP) lives in app.ts; this file only owns the process lifecycle: bind a
// port, tell the suite about it when there is one, serve until the suite
// is done, then stop.
//
// Two modes:
//   - Trial: MAKEFUN_ENV_URL points at the suite. Bind an ephemeral port,
//     POST {"port": <port>} to <env>/register, then keep polling
//     <env>/done until it answers {"done": true}, and exit 0.
//   - Local: MAKEFUN_ENV_URL is unset. Bind PORT (or 3000 when PORT is
//     absent) and serve until the process is killed, so sdk/run.ts can be
//     pointed at it by hand.

import { createApp } from './app.ts';

const LOCAL_PORT_FALLBACK = 3000;
const REGISTER_RETRY_DELAY_MS = 500;
const REGISTER_GIVE_UP_MS = 120_000;
const REGISTER_REQUEST_TIMEOUT_MS = 5_000;
const DONE_REQUEST_TIMEOUT_MS = 60_000;
const DONE_RETRY_DELAY_MS = 1_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function suiteBase(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.replace(/\/+$/, '');
}

function localPort(): number {
  const raw = process.env.PORT;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return LOCAL_PORT_FALLBACK;
}

async function tryRegister(base: string, port: number): Promise<'ok' | 'already' | 'retry'> {
  let response: Response;
  try {
    response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REGISTER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return 'retry';
  }
  if (response.status === 200) return 'ok';
  if (response.status === 409) return 'already';
  return 'retry';
}

async function registerWithSuite(base: string, port: number): Promise<void> {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const outcome = await tryRegister(base, port);
    if (outcome === 'ok') {
      console.log(`git-forge: suite accepted our port ${port}`);
      return;
    }
    if (outcome === 'already') {
      console.log(`git-forge: suite already holds our registration (port ${port})`);
      return;
    }
    if (Date.now() - started > REGISTER_GIVE_UP_MS) {
      throw new Error(`could not register port ${port} with the suite after ${attempt} attempts`);
    }
    console.log(`git-forge: register attempt ${attempt} failed, retrying`);
    await pause(REGISTER_RETRY_DELAY_MS);
  }
}

async function awaitSuiteDone(base: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${base}/done`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(DONE_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // A dropped or timed-out poll only means "not done yet".
    }
    await pause(DONE_RETRY_DELAY_MS);
  }
}

function closeServer(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function run(): Promise<void> {
  const server = createApp();
  const base = suiteBase();
  const port = base === null ? localPort() : 0;

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`git-forge: ${signal} received, stopping`);
    await closeServer(server);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  server.on('error', (err) => {
    console.error(`git-forge: server error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`git-forge: listening on 0.0.0.0:${boundPort}`);

  if (base === null) {
    console.log('git-forge: local mode, no MAKEFUN_ENV_URL set; serving until killed');
    return;
  }

  await registerWithSuite(base, boundPort);
  await awaitSuiteDone(base);
  console.log('git-forge: suite is done, shutting down');
  await closeServer(server);
}

run().catch((err: unknown) => {
  console.error(`git-forge: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

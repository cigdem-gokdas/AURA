import { chmod, mkdir, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname, resolve } from 'node:path';

export type AgentControlCommand = 'KILL' | 'DISARM';

export function agentControlPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AURA_CONTROL_SOCKET_PATH ?? '.aura/agent-control.sock');
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) throw new Error(`Control path is not a socket: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const active = await new Promise<boolean>((resolveProbe, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1_000);
    probe.once('connect', () => { probe.destroy(); resolveProbe(true); });
    probe.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolveProbe(false);
      else reject(error);
    });
    probe.once('timeout', () => { probe.destroy(); reject(new Error('Control socket probe timed out')); });
  });
  if (active) throw new Error('Another AURA agent:run control server is already active');
  await unlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** Reject a duplicate run before it starts MCP clients or makes exchange reads. */
export async function assertAgentNotRunning(path: string): Promise<void> {
  await removeStaleSocket(resolve(path));
}

/** One local agent:run owns this socket; it exposes no exchange or arming command. */
export async function startAgentControl(path: string, onCommand: (command: AgentControlCommand) => void): Promise<() => Promise<void>> {
  const socketPath = resolve(path);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);
  const server: Server = createServer(socket => {
    let input = '';
    socket.setTimeout(3_000, () => socket.destroy());
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 32) { socket.end('ERROR invalid command\n'); return; }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const command = input.slice(0, newline);
      if (command !== 'KILL' && command !== 'DISARM') {
        socket.end('ERROR invalid command\n'); return;
      }
      try {
        onCommand(command);
        socket.end(command === 'KILL' ? 'KILL_SWITCH_ACTIVE\n' : 'LIVE_ENTRIES_DISARMED\n');
      } catch (error) {
        socket.end(`ERROR ${error instanceof Error ? error.message : 'Control failure'}\n`);
      }
    });
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); done(); });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return async () => {
    await new Promise<void>(done => server.close(() => done()));
    await unlink(socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  };
}

export async function sendAgentControl(path: string, command: AgentControlCommand): Promise<string> {
  const expected = command === 'KILL' ? 'KILL_SWITCH_ACTIVE' : 'LIVE_ENTRIES_DISARMED';
  return new Promise<string>((done, reject) => {
    const socket = createConnection(resolve(path));
    let response = '';
    socket.setTimeout(3_000, () => socket.destroy(new Error('AURA control timed out')));
    socket.once('connect', () => socket.write(`${command}\n`));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('error', reject);
    socket.once('end', () => {
      const value = response.trim();
      if (value === expected) done(value);
      else reject(new Error(value || 'AURA control did not acknowledge the command'));
    });
  });
}

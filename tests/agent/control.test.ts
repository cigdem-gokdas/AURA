import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentControlPath, sendAgentControl, startAgentControl } from '../../src/agent/control.js';
import { main } from '../../src/main.js';

const runFile = promisify(execFile);

describe('operator control from a second process', () => {
  it('routes exact npm CLI kill and disarm commands from a second process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aura-control-'));
    const path = join(directory, 'control.sock');
    const received: string[] = [];
    const close = await startAgentControl(path, command => { received.push(command); });
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const env = { ...process.env, AURA_CONTROL_SOCKET_PATH: path };
      const disarm = await runFile('npm', ['run', 'agent:disarm'], { cwd: process.cwd(), env });
      expect(disarm.stdout).toContain('LIVE_ENTRIES_DISARMED');
      const kill = await runFile('npm', ['run', 'agent:kill'], { cwd: process.cwd(), env });
      expect(kill.stdout).toContain('KILL_SWITCH_ACTIVE');
      expect(received).toEqual(['DISARM', 'KILL']);
      await expect(startAgentControl(path, () => undefined)).rejects.toThrow('already active');
      await expect(main('run', { ...env, OKX_PROFILE: 'live', LIVE_TRADING_ARMED: 'true' }))
        .rejects.toThrow('already active');
    } finally { await close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);

  it('fails when no running agent owns the socket', async () => {
    const path = join(tmpdir(), `aura-absent-${process.pid}-${Date.now()}.sock`);
    expect(agentControlPath({ AURA_CONTROL_SOCKET_PATH: path })).toBe(path);
    await expect(sendAgentControl(path, 'KILL')).rejects.toThrow();
  });
});

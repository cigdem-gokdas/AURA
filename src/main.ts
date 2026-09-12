export type AgentCommand = 'preflight' | 'calibrate' | 'demo-smoke' | 'run';

// Command entry points are placeholders until their behavior is implemented.
throw new Error(
  `AURA command "${process.argv[2] ?? 'unknown'}" is not implemented`,
);

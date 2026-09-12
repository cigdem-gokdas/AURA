import { OkxMcpConnector, type OkxMcpSessionFactory } from './connector.js';
import { atkLaneConfigFromEnv } from './config.js';

/** Separate stdio process with ATK's server-enforced --read-only flag. */
export class AtkReadClient extends OkxMcpConnector {
  constructor(env: Readonly<Record<string, string | undefined>> = process.env,
    sessionFactory?: OkxMcpSessionFactory) {
    super(atkLaneConfigFromEnv(env, 'READ'), sessionFactory);
  }
}

/** Separate spot-only stdio process; only the execution engine receives it. */
export class AtkWriteClient extends OkxMcpConnector {
  constructor(env: Readonly<Record<string, string | undefined>> = process.env,
    sessionFactory?: OkxMcpSessionFactory) {
    super(atkLaneConfigFromEnv(env, 'WRITE'), sessionFactory);
  }
}

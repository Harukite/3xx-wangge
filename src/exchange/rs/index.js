import { PaperExchange } from './paper.js';
import { RisexExchange } from './risex.js';

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.account || !cfg.signerKey) {
      throw new Error('LIVE 模式需要 ACCOUNT_ADDRESS 和 SIGNER_PRIVATE_KEY 环境变量。');
    }
    return new RisexExchange({
      account: cfg.account, signerKey: cfg.signerKey,
      apiUrl: cfg.apiUrl, wsUrl: cfg.wsUrl,
    });
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, startBalance: cfg.startBalance });
}

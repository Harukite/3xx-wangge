import { PaperExchange } from './paper.js';
import { ExtendedExchange } from './extended.js';

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.apiKey || !cfg.vault || !cfg.starkPrivateKey) {
      throw new Error('LIVE 模式需要 EXTENDED_API_KEY、EXTENDED_VAULT 和 EXTENDED_STARK_PRIVATE_KEY 环境变量（在 app.extended.exchange 的 API Management 页面获取）。');
    }
    return new ExtendedExchange({
      apiKey: cfg.apiKey, vault: cfg.vault,
      privateKey: cfg.starkPrivateKey, publicKey: cfg.starkPublicKey || null,
      apiUrl: cfg.apiUrl, network: cfg.network, feeRate: cfg.feeRate,
    });
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, network: cfg.network, startBalance: cfg.startBalance, feeRate: cfg.feeRate });
}


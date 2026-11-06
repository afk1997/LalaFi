import { Command, Option } from 'commander';
import { registerDeposit } from './commands/deposit.js';
import { registerInfoCommands } from './commands/info.js';
import { registerOperatorCommands } from './commands/operator.js';
import { registerSpendCommands } from './commands/spend.js';
import { registerWalletCommands } from './commands/wallet.js';

export function buildProgram(): Command {
  const program = new Command('xpool')
    .description('xpool v1 cross-chain privacy pool wallet')
    .version('0.1.0')
    .addOption(new Option('--env <env>', 'environment').choices(['local', 'testnet', 'mainnet']).default('local'))
    .option('--home <dir>', 'wallet home directory (default ~/.xpool or $XPOOL_HOME)')
    .option('--no-tor', 'W8 override: do not use Tor even if available (loud warning)')
    .option('--relayer <url>', 'relayer base URL (or $XPOOL_RELAYER_URL)')
    .option('--config-dir <dir>', 'directory with <env>.json configs (or $XPOOL_CONFIG_DIR)')
    .option('--deployments-dir <dir>', 'directory with deployments/<env>.json (or $XPOOL_DEPLOYMENTS_DIR)')
    .option('--circuits-dir <dir>', 'circuits directory with build/ and artifacts/ (or $XPOOL_CIRCUITS_DIR)')
    .showHelpAfterError();
  registerWalletCommands(program);
  registerDeposit(program);
  registerSpendCommands(program);
  registerInfoCommands(program);
  registerOperatorCommands(program);
  return program;
}

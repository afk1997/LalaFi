/**
 * TESTNET ONLY: Iris-compatible attestation endpoint for LockReleaseMessenger pools (tokens Circle's CCTP
 * doesn't support, e.g. test DAI). Same API the keeper already uses:
 *   GET /v2/messages/{srcDomain}?transactionHash=0x… → { messages: [{ message, attestation, status: "complete" }] }
 * It reads the burn transaction's receipt on the source chain, takes MessageSent events emitted by that
 * chain's configured messenger, waits for confirmations, and signs keccak256(message) with the attester key.
 *
 * Env: XPOOL_ENV, XPOOL_CONFIG, ATTESTER_PRIVATE_KEY, ATTESTER_PORT (8095), ATTESTER_CONFIRMATIONS (3)
 */
import { createServer } from 'node:http';
import { createPublicClient, decodeEventLog, http, isHex, keccak256, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount, sign, serializeSignature } from 'viem/accounts';
import { loadConfig } from '@xpool/service-common';

const cfg = loadConfig();
if (cfg.env === 'mainnet') throw new Error('test-attester is testnet-only');
const key = process.env.ATTESTER_PRIVATE_KEY as Hex | undefined;
if (!key || !isHex(key)) throw new Error('ATTESTER_PRIVATE_KEY required');
delete process.env.ATTESTER_PRIVATE_KEY;
const attester = privateKeyToAccount(key);
const port = Number(process.env.ATTESTER_PORT ?? 8095);
const confirmations = BigInt(process.env.ATTESTER_CONFIRMATIONS ?? 3);

const messageSent = parseAbi(['event MessageSent(bytes message)']);
const byDomain = new Map<number, { messenger: Hex; rpc: string }>();
byDomain.set(cfg.hub.cctp.domain, { messenger: cfg.hub.cctp.tokenMessengerV2, rpc: cfg.hub.rpc[0]! });
for (const s of cfg.spokes) byDomain.set(s.cctp.domain, { messenger: s.cctp.tokenMessengerV2, rpc: s.rpc[0]! });
const clients = new Map([...byDomain].map(([d, v]) => [d, createPublicClient({ transport: http(v.rpc) })]));

async function attest(domain: number, txHash: Hex) {
  const src = byDomain.get(domain);
  const client = clients.get(domain);
  if (!src || !client) return { status: 400, body: { error: 'unknown domain' } };
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => undefined);
  if (!receipt) return { status: 404, body: { error: 'not found' } };
  const head = await client.getBlockNumber();
  const final = head >= receipt.blockNumber + confirmations;
  const messages = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== src.messenger.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: messageSent, data: log.data, topics: log.topics });
      const message = ev.args.message;
      const attestation = final ? serializeSignature(await sign({ hash: keccak256(message), privateKey: key! })) : 'PENDING';
      messages.push({ message, attestation, status: final ? 'complete' : 'pending_confirmations', eventNonce: String(log.logIndex) });
    } catch {
      /* not a MessageSent log */
    }
  }
  return messages.length ? { status: 200, body: { messages } } : { status: 404, body: { error: 'no messages' } };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = /^\/v2\/messages\/(\d+)$/.exec(url.pathname);
  const tx = url.searchParams.get('transactionHash');
  let out: { status: number; body: unknown } = { status: 404, body: { error: 'not found' } };
  try {
    if (req.method === 'GET' && m && tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) out = await attest(Number(m[1]), tx as Hex);
  } catch {
    out = { status: 500, body: { error: 'internal' } };
  }
  res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'test-attester started', attester: attester.address, port, domains: [...byDomain.keys()] })));

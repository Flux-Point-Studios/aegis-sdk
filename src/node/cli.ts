// aegis-book: buy gen-3 Sovereign Book cover from a buyer's wallet, or post an underwriter's
// offers, on preview or preprod.
//
//   aegis-book whoami  --network preview --wallet-dir DIR
//   aegis-book quote   --network preview --wallet-dir DIR --instance ada|usdcx --feed ADA/USD
//                      [--class barrier|depeg] --strike N --coverage 50 --term-days 7 [--pin] --api URL
//   aegis-book buy     ...the quote's arguments... [--submit]
//   aegis-book post    --network preview --wallet-dir DIR --instance ada|usdcx --feed ADA/USD [--feed ...]
//                      --size 500 [--class barrier|depeg] [--min-depth-bps N --max-depth-bps N]
//                      [--min-term-days 7] [--max-term-days 45] [--load-bps 0] [--min-fill 10] [--max-fill N]
//                      [--sheet HASH] [--lovelace 40] [--receipts N] --api URL [--submit]
//   aegis-book starter --network preview --wallet-dir DIR --instance ada|usdcx [--only LABEL ...] --api URL [--submit]
//
// A wallet is a directory holding public.json and mnemonic.txt; the key never leaves this
// process and no transaction bytes are printed. Every command prints one JSON line per result;
// a refusal prints {"ok":false,"problems":[...]} and exits 2. Without --submit nothing is signed
// but the reservation a dry-run buy asks the API for, which lapses on its own. The Koios token is
// read from AEGIS_KOIOS_API_TOKEN, never from the command line. AEGIS_NETWORK, when set, must
// name the network asked for, and Koios must report that network's magic before anything is read.

import {
  BookRefusal,
  CHAIN_FACTS,
  G3_INSTANCES,
  G3_STARTER,
  buildG3OfferPost,
  compactJson,
  decodeG3ReceiptPin,
  decodeTransaction,
  g3AddressView,
  g3CollateralOf,
  g3CoverRequest,
  g3FundingFor,
  g3Offer,
  g3OfferOutput,
  g3OfferSummary,
  g3PayoutOf,
  g3PostProblems,
  g3QuoteLine,
  g3ReservationPayload,
  g3SaleFacts,
  g3SheetCells,
  heldBy,
  koiosHeaders,
  koiosUtxos,
  outputsNamedBy,
  prepareG3Cover,
  protocolParamsFromCli,
  quoteG3Cover,
  readResolvedOutputs,
  readWalletOutputs,
  spliceVkeyWitnesses,
  submitG3Sale,
  transactionId,
  verifyG3Sale,
} from '../index';
import type {
  G3CoverRequest,
  G3Instance,
  G3OfferAsk,
  G3SaleFacts,
  KoiosReadOptions,
  MinimalFetch,
  Network,
  ProtocolParams,
  ResolvedOutput,
  TxOutput,
} from '../index';
import { bytesToHex, hexToBytes } from '../cbor';
import { openWalletDir } from './wallet_dir';
import type { WalletDir } from './wallet_dir';

const TESTNETS = ['preview', 'preprod'] as const;
const CLASS_NAMES = ['barrier', 'depeg'] as const;
const CLASS_TAGS: Readonly<Record<string, number>> = { barrier: 0, depeg: 1 };
/** Environment names that hold key material by their look; the process refuses to run beside one. */
const KEY_NAME_FRAGMENTS = ['MNEMONIC', 'SKEY', 'SIGNING_KEY', 'PRIVATE_KEY', 'SEED', 'PASSPHRASE', 'ACCOUNT_KEY',
  'AGENT_KEY', 'MARK_KEY', 'WALLET_PATH', 'XPRV', 'ROOT_KEY'];
export const POLL_MS = 10_000;
export const POLL_LIMIT = 180;

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl: MinimalFetch;
  out: (line: string) => void;
  err: (text: string) => void;
  nowMs: () => bigint;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

type Flag = { name: string; kind: 'string' | 'int' | 'bool' | 'list'; required?: boolean; choices?: readonly string[] };
type Args = Record<string, string | bigint | boolean | string[] | undefined>;

const COMMON: Flag[] = [
  { name: 'network', kind: 'string', required: true, choices: TESTNETS },
  { name: 'wallet-dir', kind: 'string', required: true },
];
const INSTANCE: Flag = { name: 'instance', kind: 'string', required: true, choices: ['ada', 'usdcx'] };
const API: Flag = { name: 'api', kind: 'string', required: true };
const SUBMIT: Flag = { name: 'submit', kind: 'bool' };
const COVER: Flag[] = [
  INSTANCE, API,
  { name: 'feed', kind: 'string', required: true },
  { name: 'class', kind: 'string', choices: CLASS_NAMES },
  { name: 'strike', kind: 'int', required: true },
  { name: 'coverage', kind: 'int', required: true },
  { name: 'term-days', kind: 'int', required: true },
  { name: 'pin', kind: 'bool' },
];
const COMMANDS: Readonly<Record<string, Flag[]>> = {
  whoami: COMMON,
  quote: [...COMMON, ...COVER],
  buy: [...COMMON, ...COVER, SUBMIT],
  cancel: [...COMMON, INSTANCE, { name: 'position', kind: 'string', required: true }, SUBMIT],
  post: [...COMMON, INSTANCE, API, SUBMIT,
    { name: 'feed', kind: 'list', required: true },
    { name: 'size', kind: 'int', required: true },
    { name: 'class', kind: 'string', choices: CLASS_NAMES },
    ...['min-depth-bps', 'max-depth-bps', 'min-term-days', 'max-term-days', 'load-bps', 'min-fill', 'max-fill', 'lovelace', 'receipts']
      .map((name): Flag => ({ name, kind: 'int' })),
    { name: 'sheet', kind: 'string' },
  ],
  starter: [...COMMON, INSTANCE, API, SUBMIT, { name: 'only', kind: 'list' }],
};

class UsageError extends Error {}

/** The command and its flags, refused as argparse refuses: an unknown flag, a missing one, a bad value. */
export function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd, ...rest] = argv;
  const flags = COMMANDS[cmd];
  if (!flags) throw new UsageError(`a command is one of ${Object.keys(COMMANDS).join(', ')}`);
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = flags.find((f) => `--${f.name}` === rest[i]);
    if (!flag) throw new UsageError(`${cmd} takes no ${rest[i]}`);
    if (flag.kind === 'bool') {
      args[flag.name] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`--${flag.name} takes a value`);
    if (flag.choices && !flag.choices.includes(value)) throw new UsageError(`--${flag.name} is one of ${flag.choices.join(', ')}`);
    if (flag.kind === 'int') {
      if (!/^-?[0-9]+$/.test(value)) throw new UsageError(`--${flag.name} takes a whole number`);
      args[flag.name] = BigInt(value);
    } else if (flag.kind === 'list') {
      args[flag.name] = [...((args[flag.name] as string[] | undefined) ?? []), value];
    } else {
      args[flag.name] = value;
    }
  }
  const missing = flags.filter((f) => f.required && args[f.name] === undefined).map((f) => `--${f.name}`);
  if (missing.length) throw new UsageError(`${cmd} needs ${missing.join(', ')}`);
  return { cmd, args };
}

/** The ask a post command names, as post_g3_offer's _ask reads it. */
export function askOf(args: Args): G3OfferAsk {
  const int = (name: string) => args[name] as bigint | undefined;
  if ((int('min-depth-bps') === undefined) !== (int('max-depth-bps') === undefined)) {
    throw new BookRefusal('depth-half-named', 'name both --min-depth-bps and --max-depth-bps, or neither');
  }
  const ask: G3OfferAsk = {
    feeds: args.feed as string[],
    size: int('size')!,
    loadBps: int('load-bps') ?? 0n,
    termDays: [int('min-term-days') ?? 7n, int('max-term-days') ?? 45n],
    minFill: int('min-fill') ?? 10n,
  };
  if (args.class !== undefined) ask.class = CLASS_TAGS[args.class as string];
  if (int('min-depth-bps') !== undefined) ask.depth = [int('min-depth-bps')!, int('max-depth-bps')!];
  if (int('max-fill') !== undefined) ask.maxFill = int('max-fill');
  if (args.sheet !== undefined) ask.sheet = args.sheet as string;
  if (int('lovelace') !== undefined) ask.lovelace = int('lovelace');
  if (int('receipts') !== undefined) ask.receipts = int('receipts');
  return ask;
}

class Refused extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

interface Context {
  deps: CliDeps;
  network: Network;
  koios: KoiosReadOptions;
  wallet: WalletDir;
  line: (obj: unknown) => void;
}

async function koiosGet(ctx: Context, path: string): Promise<any> {
  const res = await ctx.deps.fetchImpl(`${CHAIN_FACTS[ctx.network].koios}${path}`, { method: 'GET', headers: koiosHeaders(ctx.koios) });
  if (!res.ok) throw new Refused('koios-unreadable', `Koios ${path} answered HTTP ${res.status}`);
  return res.json();
}

async function koiosPost(ctx: Context, path: string, body: unknown): Promise<any> {
  const res = await ctx.deps.fetchImpl(`${CHAIN_FACTS[ctx.network].koios}${path}`, {
    method: 'POST', headers: koiosHeaders(ctx.koios), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Refused('koios-unreadable', `Koios ${path} answered HTTP ${res.status}`);
  return res.json();
}

async function protocolParams(ctx: Context): Promise<ProtocolParams> {
  return protocolParamsFromCli(await koiosGet(ctx, '/cli_protocol_params'));
}

/** Refuses unless every out-ref is unspent on chain. */
async function assertUnspent(ctx: Context, refs: string[], what: string): Promise<void> {
  const rows = await koiosUtxos(ctx.koios, 'utxo_info', { _utxo_refs: refs, _extended: false });
  const unspent = new Set(rows.filter((r) => !r.is_spent).map((r) => `${r.tx_hash}#${r.tx_index}`));
  const spent = refs.filter((r) => !unspent.has(r)).sort();
  if (spent.length) throw new Refused('input-spent', `${what} ${JSON.stringify(spent)} are spent or unknown`);
}

/** The landed transaction `id`, decoded, once Koios holds it; Refused after POLL_LIMIT polls. */
async function awaitLanding(ctx: Context, id: string) {
  for (let poll = 0; poll < POLL_LIMIT; poll++) {
    const rows = await koiosPost(ctx, '/tx_cbor', { _tx_hashes: [id] }).catch(() => []);
    const row = Array.isArray(rows) ? rows.find((r: { tx_hash?: string }) => r.tx_hash === id) : undefined;
    if (row?.cbor) return decodeTransaction(row.cbor);
    await ctx.deps.sleep(ctx.deps.pollMs ?? POLL_MS);
  }
  throw new Refused('not-landed', `${id} was submitted and is not on chain after ${POLL_LIMIT} polls`);
}

const sameOutput = (a: TxOutput, b: TxOutput) =>
  compactJson(JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))) ===
  compactJson(JSON.parse(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));

async function submitToKoios(ctx: Context, signed: string): Promise<string> {
  const res = await ctx.deps.fetchImpl(`${CHAIN_FACTS[ctx.network].koios}/submittx`, {
    method: 'POST',
    headers: { ...koiosHeaders(ctx.koios), 'content-type': 'application/cbor' },
    body: hexToBytes(signed) as unknown as string,
  });
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Refused('submit-refused', `Koios answered HTTP ${res.status}: ${JSON.stringify(answer)}`);
  return String(answer);
}

function held(o: TxOutput | ResolvedOutput, inst: G3Instance, pin: { policy: string; name: string } | null) {
  const plain = inst.unitPolicy ? o.assets[inst.unitPolicy]?.[inst.unitName] ?? 0n : o.lovelace;
  return { plain, receipts: pin ? o.assets[pin.policy]?.[pin.name] ?? 0n : 0n };
}

function terms(facts: G3SaleFacts) {
  const pd = facts.policy!;
  return {
    feed: pd.feed, class: pd.class, strike: pd.strike, coverage: pd.coverage, premium: pd.premium,
    start: pd.startMs, expiry: pd.expiryMs, pin: pd.extension === null ? null : decodeG3ReceiptPin(pd.extension),
  };
}

async function whoami(ctx: Context): Promise<number> {
  const listing = await readWalletOutputs(ctx.wallet.address, ctx.koios);
  const { lovelace, tokens } = heldBy(Object.values(listing.outputs));
  ctx.line({ network: ctx.network, address: ctx.wallet.address, vkh: ctx.wallet.vkh, lovelace, tokens, cut: listing.cut });
  return 0;
}

async function buy(ctx: Context, cmd: string, args: Args, inst: G3Instance): Promise<number> {
  const api = { baseUrl: (args.api as string).replace(/\/+$/, ''), fetchImpl: ctx.deps.fetchImpl };
  const params = await protocolParams(ctx);
  const { outputs: wallet } = await readWalletOutputs(ctx.wallet.address, ctx.koios);
  const collateral = g3CollateralOf(wallet);
  let request: G3CoverRequest = g3CoverRequest(inst, {
    feed: args.feed as string, class: ((args.class as string | undefined) ?? 'barrier') as 'barrier' | 'depeg',
    strike: args.strike as bigint, coverage: args.coverage as bigint, termDays: args['term-days'] as bigint, pin: !!args.pin,
  }, { insured: ctx.wallet.vkh, payout: g3PayoutOf(g3AddressView(ctx.wallet.address)), funding: [collateral], collateral }, params);
  const quote = await quoteG3Cover(api, inst, request);
  if (cmd === 'quote') {
    ctx.deps.out(g3QuoteLine(quote, request));
    return 0;
  }
  const lovelace = quote.needs.lovelace + (inst.unitPolicy ? 0n : quote.needs.unit);
  const tokens = inst.unitPolicy ? { [inst.unit]: quote.needs.unit } : {};
  const funding = g3FundingFor(wallet, lovelace, tokens, new Set([collateral]));
  request = { ...request, premium: quote.premium, funding: Object.keys(funding).sort() };
  const addressHex = await ctx.wallet.signer.getChangeAddress();
  const payload = bytesToHex(new TextEncoder().encode(g3ReservationPayload(request)));
  const signature = await ctx.wallet.signer.signData(addressHex, payload);
  const prepared = await prepareG3Cover(api, inst, request, { [ctx.wallet.vkh]: signature });
  const tx = decodeTransaction(prepared.cbor);
  const resolved = await readResolvedOutputs(outputsNamedBy(tx), ctx.koios);
  const problems = verifyG3Sale({ tx: prepared.cbor, request, quote, instance: inst, resolved, params });
  if (problems.length) {
    throw new Refused('sale-not-the-quote', problems.map((p) => `${p.code}/${p.conjunct}: ${p.detail}`).join('; '));
  }
  const facts = g3SaleFacts(tx, inst);
  const cover = terms(facts);
  const legs = facts.legs.map((l) => ({ offer: l.datum!.source, coverage: l.datum!.coverage, premium: l.datum!.premium, ...held(l.output, inst, cover.pin) }));
  if (!args.submit) {
    ctx.line({ dry_run: true, reservation: prepared.reservation, fee: tx.fee, quote: quote.answer, cover, legs });
    return 0;
  }
  await assertUnspent(ctx, tx.inputs, "the sale's inputs");
  const id = await submitG3Sale(api, inst, prepared, await ctx.wallet.signer.signTx(prepared.cbor, false));
  const landed = await awaitLanding(ctx, id);
  if (!sameOutput(landed.outputs[facts.pAt], tx.outputs[facts.pAt])) throw new Refused('landed-another-cover', `${id} landed without the P-leg judged`);
  ctx.line({ tx: id, position: `${id}#${facts.pAt}`, cover, legs });
  return 0;
}

async function referenceSheets(ctx: Context, inst: G3Instance): Promise<Record<string, string>> {
  const resolved = await readResolvedOutputs(Object.values(inst.sheets), ctx.koios);
  const cells: Record<string, string> = {};
  for (const [hash, ref] of Object.entries(inst.sheets)) {
    const datum = resolved[ref].datum;
    if (datum?.kind !== 'inline') throw new Refused('sheet-not-the-hash', `the UTxO ${ref} holds no inline sheet`);
    cells[hash] = g3SheetCells(hash, datum.cbor);
  }
  return cells;
}

async function postOffers(ctx: Context, args: Args, inst: G3Instance, asks: readonly G3OfferAsk[]): Promise<number> {
  const api = { baseUrl: (args.api as string).replace(/\/+$/, ''), fetchImpl: ctx.deps.fetchImpl };
  const params = await protocolParams(ctx);
  const sheets = await referenceSheets(ctx, inst);
  const stake = g3AddressView(ctx.wallet.address).stake;
  if (!stake || !('key' in stake)) throw new Refused('wallet-unstaked', 'an offer sits under its owner\'s stake key; the wallet has none');
  const own = await ctx.wallet.signer.getChangeAddress();
  let { outputs: wallet } = await readWalletOutputs(ctx.wallet.address, ctx.koios);
  const holds = heldBy(Object.values(wallet));
  let needLovelace = 0n;
  const needTokens: Record<string, bigint> = {};
  for (const ask of asks) {
    const label = ask.label ?? 'offer';
    try {
      const offer = g3Offer(inst, ask, ctx.wallet.vkh, ctx.deps.nowMs(), sheets);
      const out = g3OfferOutput(inst, offer, stake.key);
      const funding = g3FundingFor(wallet, offer.lovelace, offer.tokens);
      const built = await buildG3OfferPost(api, inst, offer, stake.key, Object.keys(funding));
      const problems = g3PostProblems(built.cbor, out, funding, own, params);
      if (problems.length) throw new Refused('post-not-the-offer', problems.join('; '));
      const tx = decodeTransaction(built.cbor);
      if (!args.submit) {
        needLovelace += offer.lovelace + tx.fee;
        for (const [u, q] of Object.entries(offer.tokens)) needTokens[u] = (needTokens[u] ?? 0n) + q;
        ctx.line({ label, dry_run: true, fee: tx.fee, offer: g3OfferSummary(offer) });
        continue;
      }
      await assertUnspent(ctx, tx.inputs, 'the funding');
      const id = transactionId(built.cbor);
      const signed = spliceVkeyWitnesses(built.cbor, await ctx.wallet.signer.signTx(built.cbor, false));
      const answered = await submitToKoios(ctx, signed);
      if (answered !== id) throw new Refused('submit-refused', `the provider answered ${answered} for ${id}`);
      const landed = await awaitLanding(ctx, id);
      if (!sameOutput(landed.outputs[0], out)) throw new Refused('landed-another-offer', `${id} landed without the offer judged`);
      ctx.line({ label, tx: id, offer: `${id}#0` });
      const change = tx.outputs.flatMap((o, i): Array<[string, ResolvedOutput]> => (i > 0 && o.address === own
        ? [[`${id}#${i}`, { address: o.address, lovelace: o.lovelace, assets: o.assets, datum: o.datum, referenceScript: null }]]
        : []));
      wallet = { ...Object.fromEntries(Object.entries(wallet).filter(([ref]) => !tx.inputs.includes(ref))), ...Object.fromEntries(change) };
    } catch (e) {
      if (!(e instanceof Refused || e instanceof BookRefusal)) throw e;
      const [code, detail] = e instanceof Refused ? [e.code, e.detail] : [e.refusal, e.detail];
      ctx.line({ label, ok: false, code, detail });
      return 2;
    }
  }
  if (args.submit) return 0;
  const short: Record<string, bigint> = { lovelace: needLovelace + 5_000_000n > holds.lovelace ? needLovelace + 5_000_000n - holds.lovelace : 0n };
  for (const [u, q] of Object.entries(needTokens)) if (q > (holds.tokens[u] ?? 0n)) short[u] = q - (holds.tokens[u] ?? 0n);
  const fits = Object.values(short).every((q) => q === 0n);
  ctx.line({ set: asks.map((a) => a.label ?? 'offer'), fits_the_wallet: fits, ...(fits ? {} : { short }) });
  return fits ? 0 : 2;
}

/** Runs one command; the exit code a shell sees. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const line = (obj: unknown) => deps.out(compactJson(obj));
  const refuse = (code: string, detail: unknown) => {
    line({ ok: false, problems: [{ code, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }] });
    return 2;
  };
  const keyNames = Object.keys(deps.env).filter((n) => KEY_NAME_FRAGMENTS.some((f) => n.toUpperCase().includes(f))).sort();
  if (keyNames.length) {
    deps.err(`forbidden environment names: ${keyNames.join(', ')}\n`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    deps.err(`aegis-book: ${e.message}\n`);
    return 2;
  }
  const { cmd, args } = parsed;
  const network = args.network as Network;
  if ((deps.env.AEGIS_NETWORK ?? network) !== network) {
    return refuse('network-not-a-testnet', `--network ${network} with AEGIS_NETWORK naming another`);
  }
  const koios: KoiosReadOptions = { network, fetchImpl: deps.fetchImpl, token: deps.env.AEGIS_KOIOS_API_TOKEN?.trim() || undefined };
  try {
    const wallet = openWalletDir(args['wallet-dir'] as string, network);
    const ctx: Context = { deps, network, koios, wallet, line };
    const genesis = await koiosGet(ctx, '/genesis');
    const magic = Number((Array.isArray(genesis) ? genesis[0] : genesis)?.networkmagic);
    if (magic !== CHAIN_FACTS[network].networkMagic) {
      return refuse('koios-off-the-network', `Koios reports magic ${magic}, not ${network}'s ${CHAIN_FACTS[network].networkMagic}`);
    }
    if (cmd === 'whoami') return await whoami(ctx);
    const inst = G3_INSTANCES[network]?.[args.instance as string];
    if (!inst) return refuse('instance-unrecorded', `${network} records no ${args.instance} instance`);
    if (cmd === 'quote' || cmd === 'buy') return await buy(ctx, cmd, args, inst);
    if (cmd === 'post') return await postOffers(ctx, args, inst, [askOf(args)]);
    if (cmd === 'starter') {
      const only = args.only as string[] | undefined;
      const set = G3_STARTER[inst.name] ?? [];
      const asks = set.filter((a) => !only || only.includes(a.label!));
      const unknown = (only ?? []).filter((l) => !set.some((a) => a.label === l)).sort();
      if (unknown.length || !asks.length) return refuse('starter-label-unknown', `the ${inst.name} starter set has no ${JSON.stringify(unknown)}`);
      return await postOffers(ctx, args, inst, asks);
    }
    return refuse('command-unbuilt', `${cmd} is not built`);
  } catch (e) {
    if (e instanceof Refused) return refuse(e.code, e.detail);
    if (e instanceof BookRefusal) return refuse(e.refusal, e.detail);
    throw e;
  }
}

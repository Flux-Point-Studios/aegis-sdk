/**
 * examples/fluid-borrow-with-cover.ts
 *
 * Borrow from a FluidTokens V4 pool on preview and buy gen-3 Book cover on the loan in the
 * same transaction, one signature, one fee. The cover is a Barrier on the ADA/USD feed sized
 * to the principal: a composition proof of the borrow and the Underwrite together, not the
 * liquidation (RH1) cover a loan ultimately wants.
 *
 * A dry run is the default: it reads the chain and the Book, composes the transaction, has
 * Koios evaluate it, recomposes at the measured units and prints the plan. Nothing is signed
 * and nothing is sent. --submit signs with the wallet and submits through Koios. Neither mode
 * prints a key, a witness or the transaction's bytes.
 *
 *   npm run build
 *   node examples/fluid-borrow-with-cover.ts --wallet-dir <dir> --pool <tx id>#<index> \
 *     [--principal-ada 50] [--term-days 7] [--depth-bps 3000] --api <Aegis API base URL> [--submit]
 *
 * <dir> holds public.json and mnemonic.txt (see src/node/wallet_dir.ts); any CIP-30 wallet's
 * API can stand in for the signer.
 */
import {
  CHAIN_FACTS,
  G3_PREVIEW_ADA,
  bytesToHex,
  composeFluidBorrowWithCover,
  decodeFeedReading,
  decodePlutusData,
  fluidBorrowGuards,
  g3DepthBps,
  g3LegPremium,
  g3SheetCell,
  koiosUtxos,
  posixMsToSlot,
  readFluidSuite,
  readResolvedOutputs,
  slotToPosixMs,
  spliceVkeyWitnesses,
  encodeTransaction,
  hexToBytes,
  protocolParamsFromCli,
} from '../dist/esm/index.js';
import type { FluidCoverPlan, KoiosUtxo } from '../dist/esm/index.js';
import { walletDirSigner } from '../dist/esm/node/index.js';
import type { Cip30Signer } from '../dist/esm/node/index.js';

const NETWORK = 'preview';
const KOIOS = CHAIN_FACTS[NETWORK].koios;
const ADA_USD = '4bba53d510bf2af7d08e8edf57c3a49ccdb6b0406c8470eea03081ef';
const TERM_DAY_MS = 86_400_000n;
/** The preview UTxOs holding each FluidTokens V4 script a borrow runs, by script hash. */
const FLUID_PREVIEW_SCRIPTS: Record<string, string> = {
  a33aee4034165f1772e57af5fb975f26c35f7e9080b7e44b4634f227: '915a5a2dd3a23ddec8dba8b1ef0983ff0b13aae667ebba340f989a5ab0de2347#0',
  bf8c4378bab7de15baddbb5d8805255d89174c08bf36179c21cad685: '915a5a2dd3a23ddec8dba8b1ef0983ff0b13aae667ebba340f989a5ab0de2347#1',
  '344755c30db0617ff43cb41e5212379b729985352a213371b15c90cd': '915a5a2dd3a23ddec8dba8b1ef0983ff0b13aae667ebba340f989a5ab0de2347#3',
  '2f1aa941f437e351e3870f7247d735b2bc2952f1c7977426e8960d17': 'd2c3ee32051f1d6174ce68afbbc33099f4a9d58c61e53df0756b94510cec145e#0',
  bcd713bb7858d4b08738bed90ee7068d8f9b38d02e0cae0b45ac7a9b: '479f7460c6f10e75065ec980dc60f0d43e3de73cced399911e5220c1e497496c#0',
  eadc69a5d2d1357acc9b9d49ec5390fcdf6e080c7a40139917223dcb: 'd2d5b9b6ff1335862719a7d43c060dfe50fbd5445e900598e6b0ec1f62d34b94#0',
};

interface BookOffer {
  ref: string;
  lovelace: number;
  terms: {
    feeds: string[];
    classes: number;
    sheet: string;
    load_bps: number;
    min_depth_bps: number;
    max_depth_bps: number;
    min_term_ms: number;
    max_term_ms: number;
    min_fill: number;
    max_fill: number;
    approval: boolean;
  };
}

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at > 0 ? process.argv[at + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const refOf = (r: KoiosUtxo) => `${r.tx_hash}#${r.tx_index}`;

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${KOIOS}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Koios ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main(): Promise<void> {
  const signer: Cip30Signer = walletDirSigner(arg('wallet-dir'), NETWORK);
  const submit = process.argv.includes('--submit');
  const principal = BigInt(Math.round(Number(arg('principal-ada', '50')) * 1e6));
  const termMs = BigInt(arg('term-days', '7')) * TERM_DAY_MS;
  const depthBps = BigInt(arg('depth-bps', '3000'));
  const pool = arg('pool');
  const api = arg('api');
  const inst = G3_PREVIEW_ADA;
  const opts = { network: NETWORK } as const;

  const borrower = await signer.getChangeAddress();
  const params = protocolParamsFromCli(await (await fetch(`${KOIOS}/cli_protocol_params`)).json());
  const suite = await readFluidSuite(opts);
  const wallet = (await post('credential_utxos', { _payment_credentials: [borrower.slice(2, 58)], _extended: true })) as KoiosUtxo[];
  const adaOnly = wallet.filter((r) => !r.is_spent && (r.asset_list ?? []).length === 0 && !r.reference_script);
  if (adaOnly.length === 0) throw new Error('the wallet holds no ADA-only UTxO for collateral and funding');
  const funding = adaOnly.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)))[0];

  const heads = (await koiosUtxos(opts, 'asset_utxos', { _asset_list: [[inst.beaconPolicy, inst.beaconName]], _extended: true })).filter((r: KoiosUtxo) => !r.is_spent);
  const tables = (await koiosUtxos(opts, 'asset_utxos', { _asset_list: [[inst.tableHash, inst.tableName]], _extended: true })).filter((r: KoiosUtxo) => !r.is_spent);
  const readings = (await post('credential_utxos', { _payment_credentials: [inst.publisherVkh], _extended: true })) as KoiosUtxo[];
  const reading = readings.find((r) => !r.is_spent && (r.asset_list ?? []).some((a: { policy_id: string }) => a.policy_id === ADA_USD));
  if (heads.length === 0 || tables.length !== 1 || !reading?.inline_datum) throw new Error('the Book has no free Head, one table and an ADA/USD reading');
  const feed = decodeFeedReading(reading.inline_datum.bytes);

  const nowMs = BigInt(Date.now());
  const upperMs = ((nowMs + 120_000n < feed.validUntil ? nowMs + 120_000n : feed.validUntil) / 1000n) * 1000n;
  if (upperMs < feed.observedAt || upperMs > feed.observedAt + 600_000n) throw new Error('the ADA/USD reading is too old to sell a Barrier on');
  const validToSlot = posixMsToSlot(upperMs, NETWORK);
  const validFromSlot = validToSlot - 600n;

  const poolRead = await readResolvedOutputs([pool], opts);
  const collateral = fluidBorrowGuards(decodePlutusData((poolRead[pool].datum as { cbor: string }).cbor), {
    principal, collateral: 10n ** 15n, validFromMs: slotToPosixMs(validFromSlot, NETWORK), validToMs: upperMs,
  });
  const spot = feed.min12h < feed.spot ? feed.min12h : feed.spot;
  const strike = (spot * (10_000n - depthBps)) / 10_000n;

  const book = (await (await fetch(`${api}/api/book/g3?network=${NETWORK}&unit=lovelace`)).json()) as { offers: BookOffer[] };
  const offer = book.offers.find((o) => {
    const t = o.terms;
    return !t.approval && t.feeds.includes(ADA_USD) && (t.classes & 1) === 1 && BigInt(t.min_fill) <= principal &&
      principal <= BigInt(t.max_fill) && principal <= BigInt(o.lovelace) && BigInt(t.min_term_ms) <= termMs &&
      termMs <= BigInt(t.max_term_ms) && BigInt(t.min_depth_bps) <= depthBps && depthBps <= BigInt(t.max_depth_bps) &&
      t.sheet in inst.sheets;
  });
  if (!offer) throw new Error(`no Book offer takes ${principal} lovelace of ADA/USD Barrier cover for ${termMs} ms at ${depthBps} bps`);
  const sheetRef = inst.sheets[offer.terms.sheet];

  const named = [pool, refOf(funding), refOf(heads[0]), offer.ref, refOf(reading), refOf(tables[0]), sheetRef, suite.configRef,
    ...Object.values(FLUID_PREVIEW_SCRIPTS), inst.refScripts.position, inst.refScripts.book, inst.refScripts.observer];
  const resolved = await readResolvedOutputs(named, opts);
  const { cell, rateBps } = g3SheetCell((resolved[sheetRef].datum as { cbor: string }).cbor, { class: 0, depthBps: g3DepthBps(feed, strike), termMs });
  const premium = g3LegPremium({ coverage: principal, totalCoverage: principal, rateBps, loadBps: BigInt(offer.terms.load_bps) }, inst);

  const plan = (units?: FluidCoverPlan['units']): FluidCoverPlan => ({
    suite, fluidScripts: FLUID_PREVIEW_SCRIPTS, pool, principal, collateral, borrower, funding: [refOf(funding)],
    collateralInput: refOf(funding), validFromSlot, validToSlot,
    cover: {
      instance: inst, head: refOf(heads[0]), reading: refOf(reading), table: refOf(tables[0]), insured: borrower.slice(2, 58),
      feed: ADA_USD, class: 0, strike, startMs: upperMs, termMs,
      legs: [{ offer: offer.ref, coverage: principal, premium, sheet: offer.terms.sheet, cell }],
    },
    resolved, params, units,
  });

  const draft = composeFluidBorrowWithCover(plan());
  const evaluated = (await post('ogmios', { jsonrpc: '2.0', method: 'evaluateTransaction', params: { transaction: { cbor: bytesToHex(encodeTransaction(draft.draft)) } } })) as {
    result?: Array<{ validator: { purpose: string; index: number }; budget: { memory: number; cpu: number } }>;
    error?: { message: string };
  };
  if (!evaluated.result) throw new Error(`Koios's evaluation refused the transaction: ${evaluated.error?.message ?? 'no answer'}`);
  const units = evaluated.result.map((r) => ({ purpose: r.validator.purpose as 'spend', index: r.validator.index, mem: BigInt(r.budget.memory), steps: BigInt(r.budget.cpu) }));
  const tx = composeFluidBorrowWithCover(plan(units));
  const bytes = encodeTransaction(tx.draft);

  console.log(JSON.stringify({
    mode: submit ? 'submit' : 'dry-run', loanId: tx.loanId, position: tx.digest, pool, offer: offer.ref,
    principal, collateral, coverage: principal, premium, strike, termMs, fee: tx.draft.fee, sizeBytes: bytes.length,
    units: units.map((u) => `${u.purpose}:${u.index} mem ${u.mem} steps ${u.steps}`), layout: tx.layout,
  }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  if (!submit) return;

  const signed = spliceVkeyWitnesses(bytes, await signer.signTx(bytesToHex(bytes), true));
  const res = await fetch(`${KOIOS}/submittx`, { method: 'POST', headers: { 'content-type': 'application/cbor' }, body: hexToBytes(signed) });
  const answer = (await res.text()).replace(/"/g, '');
  if (!res.ok) throw new Error(`Koios refused the submission (${res.status}): ${answer.slice(0, 300)}`);
  console.log(JSON.stringify({ submitted: answer }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

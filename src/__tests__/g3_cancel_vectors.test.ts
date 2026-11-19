// A gen-3 buyer's cancel against the Python CLI's own (fixtures/g3_cancel_vectors.json, written
// by offchain/scripts/g3_cancel_vectors.py at the commit it names): over each chain as Koios
// serves it, the BuyerCancel byte for byte and the line the CLI prints, or the code and detail
// it refuses with; the pre-sign mirror's every problem over each tampered cancel; and aegis-book
// cancel over those chains.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookRefusal, G3_INSTANCES, G3_PREVIEW_ADA, G3_PREVIEW_USDCX, resolvedOutputsFromKoios } from '../book';
import type { G3Instance } from '../book';
import { g3BuyerCancelProblems, prepareG3BuyerCancel } from '../book_cancel';
import type { G3CancelSummary } from '../book_cancel';
import type { MinimalFetch } from '../fetch_quote';
import type { KoiosUtxo } from '../koios';
import { bytesToHex } from '../cbor';
import { main } from '../node/cli';
import type { CliDeps } from '../node/cli';
import { decodeTransaction, transactionId, txViewOf } from '../tx';
import type { ProtocolParams } from '../tx';
import vectors from './fixtures/g3_cancel_vectors.json';
import cliVectors from './fixtures/g3_cli_vectors.json';

const V = vectors as any;
const W = cliVectors as any;

const PARAMS: ProtocolParams = {
  minFeeA: BigInt(V.params.min_fee_a),
  minFeeB: BigInt(V.params.min_fee_b),
  priceMem: [BigInt(V.params.price_mem[0]), BigInt(V.params.price_mem[1])],
  priceSteps: [BigInt(V.params.price_steps[0]), BigInt(V.params.price_steps[1])],
  refScriptCostPerByte: [BigInt(V.params.ref_script_cost_per_byte), 1n],
  coinsPerUtxoByte: BigInt(V.params.coins_per_utxo_byte),
  maxTxSize: V.params.max_tx_size,
  maxValueSize: V.params.max_val_size,
  maxTxMem: BigInt(V.params.max_tx_mem),
  maxTxSteps: BigInt(V.params.max_tx_steps),
  collateralPercent: BigInt(V.params.collateral_percent),
  costModelsV3: V.cost_models.map(BigInt),
};

/** The same parameters as Koios's cli_protocol_params answers them. */
const CLI_PARAMS = {
  txFeePerByte: V.params.min_fee_a, txFeeFixed: V.params.min_fee_b, utxoCostPerByte: V.params.coins_per_utxo_byte,
  executionUnitPrices: {
    priceMemory: V.params.price_mem[0] / V.params.price_mem[1], priceSteps: V.params.price_steps[0] / V.params.price_steps[1],
  },
  minFeeRefScriptCostPerByte: V.params.ref_script_cost_per_byte, maxTxSize: V.params.max_tx_size, maxValueSize: V.params.max_val_size,
  maxTxExecutionUnits: { memory: V.params.max_tx_mem, steps: V.params.max_tx_steps }, collateralPercentage: V.params.collateral_percent,
  costModels: { PlutusV3: V.cost_models },
};

/** The preview instance the vectors' stand-in world joins its scripts to. */
function instanceOf(name: string): G3Instance {
  const v = V.instances[name];
  const base = name === 'ada' ? G3_PREVIEW_ADA : G3_PREVIEW_USDCX;
  return {
    ...base,
    unitPolicy: v.unit_policy,
    unitName: v.unit_name,
    legCarrier: BigInt(v.leg_carrier),
    liqwidHash: v.liqwid_hash,
    positionHash: v.position_hash,
    observerHash: v.observer_hash,
    beaconPolicy: v.beacon_policy,
    publisherVkh: v.publisher_vkh,
    refScripts: { ...base.refScripts, ...v.ref_scripts },
    rates: v.rates.map((r: { policy: string; name: string }) => ({ ...G3_PREVIEW_USDCX.rates[0], ...r })),
  };
}

function holds(row: KoiosUtxo, policy: string, name?: string): boolean {
  return (row.asset_list ?? []).some((a) => a.policy_id === policy && (name === undefined || a.asset_name === name) && a.quantity !== '0');
}

/** Koios over one case's chain: each route the cancel reads, and Ogmios answering every redeemer at the run's units. */
function koios(chain: { txs: Record<string, string>; rows: KoiosUtxo[] }, evaluation: unknown = null) {
  const asked: string[] = [];
  const evaluated: string[] = [];
  const unspent = chain.rows.filter((r) => !r.is_spent);
  const answer = (path: string, body: any): unknown => {
    switch (path) {
      case 'tx_cbor':
        return body._tx_hashes.filter((h: string) => h in chain.txs).map((h: string) => ({ tx_hash: h, cbor: chain.txs[h] }));
      case 'utxo_info':
        return chain.rows.filter((r) => body._utxo_refs.includes(`${r.tx_hash}#${r.tx_index}`));
      case 'policy_asset_addresses':
        return unspent.filter((r) => holds(r, body._asset_policy)).flatMap((r) => (r.asset_list ?? [])
          .filter((a) => a.policy_id === body._asset_policy).map((a) => ({ asset_name: a.asset_name, payment_address: r.address, quantity: a.quantity })));
      case 'asset_utxos':
        return unspent.filter((r) => body._asset_list.some(([p, n]: [string, string]) => holds(r, p, n)));
      case 'ogmios': {
        const tx = body.params.transaction.cbor;
        evaluated.push(tx);
        return evaluation ?? {
          jsonrpc: '2.0',
          result: decodeTransaction(tx).redeemers.map((r) => ({
            validator: { purpose: r.purpose, index: r.index }, budget: { memory: V.evaluation.memory, cpu: V.evaluation.cpu },
          })),
        };
      }
      default:
        throw new Error(`a Koios request the cancel does not make: ${path}`);
    }
  };
  const fetchImpl: MinimalFetch = async (url, init) => {
    const path = url.replace('https://preview.koios.rest/api/v1/', '');
    asked.push(path);
    const json = answer(path, init?.body === undefined ? undefined : JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => json };
  };
  return { fetchImpl, asked, evaluated };
}

function plain(summary: G3CancelSummary): unknown {
  return JSON.parse(JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

async function outcome(call: () => Promise<unknown>): Promise<{ refused: string; detail: unknown } | null> {
  try {
    await call();
    return null;
  } catch (e) {
    if (e instanceof BookRefusal) return { refused: e.refusal, detail: e.detail };
    throw e;
  }
}

function cancelOf(c: any, fetchImpl: MinimalFetch) {
  return prepareG3BuyerCancel({
    instance: instanceOf(c.instance),
    position: c.position,
    wallet: { address: V.wallet.address, collateral: V.wallet.collateral },
    koios: { network: 'preview', fetchImpl },
    tipMs: BigInt(c.tip_ms),
    params: PARAMS,
  });
}

describe('the vectors', () => {
  it('cover each instance, a pin, a staked payout and none, script-owned legs, a reading that bounds the range and each refusal', () => {
    const built = V.cases.filter((c: any) => c.tx);
    expect(built.length).toBe(11);
    expect(new Set(built.map((c: any) => c.instance))).toEqual(new Set(['ada', 'usdcx']));
    expect(built.every((c: any) => c.redeemers_in_ledger_order)).toBe(true);
    expect(V.cases.filter((c: any) => c.refused).map((c: any) => c.refused).sort()).toEqual([
      'buyer-cancel-gate', 'buyer-cancel-gate', 'no-reading', 'not-a-position', 'not-the-insured', 'position-settled', 'stale-reading',
    ]);
    expect(V.mirror.length).toBe(37);
    expect(V.cases.find((c: any) => c.name === 'a reading off the second that bounds the range').tx).not.toBe(V.cases[0].tx);
  });
});

describe('a buyer cancel', () => {
  for (const c of V.cases) {
    it(c.name, async () => {
      const chain = koios(c.chain);
      if (c.refused) {
        expect(await outcome(() => cancelOf(c, chain.fetchImpl))).toEqual({ refused: c.refused, detail: c.detail });
        return;
      }
      const prepared = await cancelOf(c, chain.fetchImpl);
      expect(prepared.tx).toBe(c.tx);
      expect(chain.evaluated).toEqual([c.tx]);
      expect(plain(prepared.summary)).toEqual(c.summary);
      expect(chain.asked).toEqual(['tx_cbor', 'utxo_info', 'utxo_info', 'policy_asset_addresses', 'asset_utxos', 'utxo_info', 'ogmios']);
    });
  }

  it('reads the tip and the parameters from Koios when it is handed neither', async () => {
    const c = V.cases[0];
    const chain = koios(c.chain);
    const fetchImpl: MinimalFetch = async (url, init) => {
      if (url.endsWith('/tip')) return { ok: true, status: 200, json: async () => [{ block_time: Math.floor(c.tip_ms / 1000) }] };
      if (url.endsWith('/cli_protocol_params')) return { ok: true, status: 200, json: async () => CLI_PARAMS };
      return chain.fetchImpl(url, init);
    };
    const prepared = await prepareG3BuyerCancel({
      instance: instanceOf(c.instance), position: c.position, wallet: { address: V.wallet.address, collateral: V.wallet.collateral },
      koios: { network: 'preview', fetchImpl },
    });
    const pinned = await cancelOf({ ...c, tip_ms: Math.floor(c.tip_ms / 1000) * 1000 }, koios(c.chain).fetchImpl);
    expect(prepared.tx).toBe(pinned.tx);
  });

  it('refuses cancel-not-evaluated when Ogmios fails a script', async () => {
    const c = V.cases[0];
    const chain = koios(c.chain, { jsonrpc: '2.0', error: { code: 3010, message: 'a script failed' } });
    const refused = await outcome(() => cancelOf(c, chain.fetchImpl));
    expect(refused).toEqual({
      refused: 'cancel-not-evaluated',
      detail: 'the evaluation failed: {"code":3010,"message":"a script failed"}',
    });
  });
});

describe('the pre-sign mirror', () => {
  for (const m of V.mirror) {
    it(m.name, () => {
      const base = V.cases[m.base];
      const over = new Set(m.rows.map((r: KoiosUtxo) => `${r.tx_hash}#${r.tx_index}`));
      const rows = [...base.chain.rows.filter((r: KoiosUtxo) => !over.has(`${r.tx_hash}#${r.tx_index}`)), ...m.rows];
      const problems = g3BuyerCancelProblems(txViewOf(decodeTransaction(m.tx)), instanceOf(base.instance), resolvedOutputsFromKoios(rows));
      expect(problems).toEqual(m.problems);
    });
  }

  it('passes every cancel the CLI builds', () => {
    for (const c of V.cases.filter((x: any) => x.tx)) {
      const problems = g3BuyerCancelProblems(txViewOf(decodeTransaction(c.tx)), instanceOf(c.instance), resolvedOutputsFromKoios(c.chain.rows));
      expect(problems).toEqual([]);
    }
  });
});

describe('aegis-book cancel', () => {
  const recorded = G3_INSTANCES.preview;
  beforeEach(() => {
    (G3_INSTANCES as Record<string, unknown>).preview = { ada: instanceOf('ada'), usdcx: instanceOf('usdcx') };
  });
  afterEach(() => {
    (G3_INSTANCES as Record<string, unknown>).preview = recorded;
  });

  /** Koios over a case's chain as the CLI reads it, its first `lagging` sale reads empty as from a node behind the tip. */
  function cliChain(c: any, lagging = 0) {
    const chain = koios(c.chain);
    const landed: Record<string, string> = {};
    const submitted: string[] = [];
    let saleReads = 0;
    let behind = lagging;
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const fetchImpl = async (url: string, init?: { body?: any }) => {
      const path = url.split('?')[0].replace('https://preview.koios.rest/api/v1/', '');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      if (path === 'genesis') return json([{ networkmagic: '2' }]);
      if (path === 'tip') return json([{ block_time: Math.floor(c.tip_ms / 1000) }]);
      if (path === 'cli_protocol_params') return json(CLI_PARAMS);
      if (path === 'address_utxos') return json(c.chain.rows.filter((r: KoiosUtxo) => !r.is_spent && body._addresses.includes(r.address)));
      if (path === 'submittx') {
        const signed = bytesToHex(body);
        submitted.push(signed);
        landed[transactionId(signed)] = signed;
        return json(transactionId(signed));
      }
      if (path === 'tx_cbor' && body._tx_hashes[0] in landed) {
        return json([{ tx_hash: body._tx_hashes[0], cbor: landed[body._tx_hashes[0]] }]);
      }
      if (path === 'tx_cbor') {
        saleReads += 1;
        if (behind > 0) {
          behind -= 1;
          return json([]);
        }
      }
      return chain.fetchImpl(url.split('?')[0], body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
    };
    return { fetchImpl, submitted, saleReads: () => saleReads };
  }

  function run(c: any, chain: ReturnType<typeof cliChain>, ...extra: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-book-'));
    writeFileSync(join(dir, 'mnemonic.txt'), W.mnemonic);
    writeFileSync(join(dir, 'public.json'), JSON.stringify({ network: 'preview', address: W.public.address, payment_vkh: W.public.payment_vkh }));
    const out: string[] = [];
    const slept: number[] = [];
    const deps: CliDeps = {
      env: {},
      out: (l) => out.push(l),
      err: () => undefined,
      nowMs: () => BigInt(c.tip_ms),
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      fetchImpl: chain.fetchImpl as any,
    };
    const done = main(['cancel', '--network', 'preview', '--wallet-dir', dir, '--instance', c.instance, '--position', c.position, ...extra], deps);
    return { done, out, slept };
  }

  /** The SDK's cancel at the whole second Koios reports for the tip. */
  const atTheTip = (c: any) => cancelOf({ ...c, tip_ms: Math.floor(c.tip_ms / 1000) * 1000 }, koios(c.chain).fetchImpl);
  const built = V.cases.find((c: any) => c.tx);

  it('prints the summary of the cancel a dry run builds for the wallet', async () => {
    expect(V.wallet.address).toBe(W.public.address);
    const r = run(built, cliChain(built));
    expect(await r.done).toBe(0);
    expect(r.out.map((l) => JSON.parse(l))).toEqual([{ dry_run: true, ...(plain((await atTheTip(built)).summary) as object) }]);
  });

  it('asks again while Koios has not yet seen the sale', async () => {
    const chain = cliChain(built, 2);
    const r = run(built, chain);
    expect(await r.done).toBe(0);
    expect(JSON.parse(r.out[0]).dry_run).toBe(true);
    expect(chain.saleReads()).toBe(3);
    expect(r.slept.length).toBe(2);
  });

  it('gives up on a sale Koios never shows', async () => {
    const r = run(built, cliChain(built, 1_000));
    await expect(r.done).rejects.toThrow(/has no transaction/);
  });

  it('asks once for a position it refuses', async () => {
    const c = V.cases.find((x: any) => x.refused === 'not-the-insured');
    const chain = cliChain(c);
    const r = run(c, chain);
    expect(await r.done).toBe(2);
    expect(JSON.parse(r.out[0]).problems[0]).toEqual({ code: c.refused, detail: c.detail });
    expect(chain.saleReads()).toBe(1);
    expect(r.slept).toEqual([]);
  });

  it('submits the dry run body with the wallet witness and prints its id', async () => {
    const chain = cliChain(built);
    const r = run(built, chain, '--submit');
    expect(await r.done).toBe(0);
    const expected = await atTheTip(built);
    expect(chain.submitted.length).toBe(1);
    const id = transactionId(chain.submitted[0]);
    expect(id).toBe(transactionId(expected.tx));
    expect(decodeTransaction(chain.submitted[0]).vkeyWitnesses).toEqual([W.public.payment_vkh]);
    expect(r.out.map((l) => JSON.parse(l))).toEqual([{ tx: id, ...(plain(expected.summary) as object) }]);
  });

  /** The chain, with `over` answering the requests it names in its place. */
  function answering(chain: ReturnType<typeof cliChain>, over: (path: string, body: any) => unknown) {
    const fetchImpl = async (url: string, init?: { body?: any }) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      const given = over(url.split('?')[0].replace('https://preview.koios.rest/api/v1/', ''), body);
      if (given === undefined) return chain.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => given, text: async () => JSON.stringify(given) };
    };
    return { ...chain, fetchImpl };
  }

  it('signs nothing once an input is spent after the build', async () => {
    const chain = cliChain(built);
    const spent = answering(chain, (path, body) => (path === 'utxo_info' && body._extended === false
      ? body._utxo_refs.map((ref: string) => ({ tx_hash: ref.split('#')[0], tx_index: Number(ref.split('#')[1]), is_spent: true }))
      : undefined));
    const r = run(built, spent, '--submit');
    expect(await r.done).toBe(2);
    expect(JSON.parse(r.out[0]).problems[0].code).toBe('input-spent');
    expect(chain.submitted).toEqual([]);
  });

  it('refuses a submission Koios answers with another id', async () => {
    const chain = cliChain(built);
    const r = run(built, answering(chain, (path) => (path === 'submittx' ? 'ff'.repeat(32) : undefined)), '--submit');
    expect(await r.done).toBe(2);
    expect(JSON.parse(r.out[0]).problems[0].code).toBe('submit-refused');
  });
});

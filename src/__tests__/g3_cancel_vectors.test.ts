// A gen-3 buyer's cancel against the Python CLI's own (fixtures/g3_cancel_vectors.json, written
// by offchain/scripts/g3_cancel_vectors.py at the commit it names): over each chain as Koios
// serves it, the BuyerCancel byte for byte and the line the CLI prints, or the code and detail
// it refuses with; and the pre-sign mirror's every problem over each tampered cancel.

import { describe, expect, it } from 'vitest';
import { BookRefusal, G3_PREVIEW_ADA, G3_PREVIEW_USDCX, resolvedOutputsFromKoios } from '../book';
import type { G3Instance } from '../book';
import { g3BuyerCancelProblems, prepareG3BuyerCancel } from '../book_cancel';
import type { G3CancelSummary } from '../book_cancel';
import type { MinimalFetch } from '../fetch_quote';
import type { KoiosUtxo } from '../koios';
import { decodeTransaction, txViewOf } from '../tx';
import type { ProtocolParams } from '../tx';
import vectors from './fixtures/g3_cancel_vectors.json';

const V = vectors as any;

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
    const p = V.params;
    const cli = {
      txFeePerByte: p.min_fee_a, txFeeFixed: p.min_fee_b, utxoCostPerByte: p.coins_per_utxo_byte,
      executionUnitPrices: { priceMemory: p.price_mem[0] / p.price_mem[1], priceSteps: p.price_steps[0] / p.price_steps[1] },
      minFeeRefScriptCostPerByte: p.ref_script_cost_per_byte, maxTxSize: p.max_tx_size, maxValueSize: p.max_val_size,
      maxTxExecutionUnits: { memory: p.max_tx_mem, steps: p.max_tx_steps }, collateralPercentage: p.collateral_percent,
      costModels: { PlutusV3: V.cost_models },
    };
    const fetchImpl: MinimalFetch = async (url, init) => {
      if (url.endsWith('/tip')) return { ok: true, status: 200, json: async () => [{ block_time: Math.floor(c.tip_ms / 1000) }] };
      if (url.endsWith('/cli_protocol_params')) return { ok: true, status: 200, json: async () => cli };
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

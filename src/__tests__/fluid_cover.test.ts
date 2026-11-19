import { describe, expect, it } from 'vitest';
import { addressBytes } from '../address';
import { G3_PREVIEW_ADA, decodeFeedReading, g3DepthBps, g3Digest, g3Donation, g3LegPremium, g3ProtocolFee, g3SheetCell, resolvedOutputsFromKoios } from '../book';
import type { ResolvedOutput } from '../book';
import { bytesToHex, hexToBytes } from '../cbor';
import { composeFluidBorrowWithCover } from '../fluid_cover';
import type { FluidCoverPlan } from '../fluid_cover';
import { decodeFluidSuite } from '../fluid_v4';
import { FLUID_POOL_SPEND_REDEEMER, fluidBorrowGuards, fluidLoanDatum, fluidLoanId } from '../fluid_v4_borrow';
import type { KoiosUtxo } from '../koios';
import { posixMsToSlot, slotToPosixMs } from '../networks';
import { decodePlutusData, encodePlutusData } from '../plutus_data';
import type { PlutusConstr } from '../plutus_data';
import { decodeTransaction, minFee, minUtxo, protocolParamsFromCli, requiredCollateral } from '../tx';
import type { TxOutput } from '../tx';
import cli from './fixtures/preview_protocol_params.json';
import live from './fixtures/fluid_cover_preview.json';
import landed from './fixtures/g3_preview_sale.json';

const PARAMS = protocolParamsFromCli(cli.response);
const rows = live.utxoInfo as unknown as KoiosUtxo[];
const resolved = resolvedOutputsFromKoios(rows);
const named = (prefix: string) => Object.keys(resolved).find((r) => r.startsWith(prefix)) as string;

const POOL = named('93492f0ed239f3d3');
const CONFIG = named('8dd38e97b79cc7c8');
const HEAD = named('9b9df872bf82aeaf');
const OFFER = named('88c59c1b3bb3d297');
const READING = named('50ae9c748cbeabae');
const TABLE = named('6a659cf8f39f4ac5');
const SHEET = '972e9a6f37447d906eedaee839d6e2a67659189394090c2b49dab6a6f6c3f280';
const WALLET = named('cf447ae7bebb43c6');
const BORROWER = bytesToHex(
  addressBytes('addr_test1qr0prpt3anm70ey4dam4yp2v7jm6g8wsrzwe8vkvr279plkjlqjza7zcf2gs6ymzgdwck9at45ntyrva68jhrfjpym0q6k0yqq'),
);
const INSURED = BORROWER.slice(2, 58);
const FEED = '4bba53d510bf2af7d08e8edf57c3a49ccdb6b0406c8470eea03081ef';
const FLUID_SCRIPTS: Record<string, string> = {
  a33aee4034165f1772e57af5fb975f26c35f7e9080b7e44b4634f227: named('915a5a2dd3a23dde').replace(/#\d+$/, '#0'),
  bf8c4378bab7de15baddbb5d8805255d89174c08bf36179c21cad685: named('915a5a2dd3a23dde').replace(/#\d+$/, '#1'),
  '344755c30db0617ff43cb41e5212379b729985352a213371b15c90cd': named('915a5a2dd3a23dde').replace(/#\d+$/, '#3'),
  '2f1aa941f437e351e3870f7247d735b2bc2952f1c7977426e8960d17': named('d2c3ee32051f1d61'),
  bcd713bb7858d4b08738bed90ee7068d8f9b38d02e0cae0b45ac7a9b: named('479f7460c6f10e75'),
  eadc69a5d2d1357acc9b9d49ec5390fcdf6e080c7a40139917223dcb: named('d2d5b9b6ff133586'),
};

const configRow = rows.find((r) => `${r.tx_hash}#${r.tx_index}` === CONFIG) as KoiosUtxo;
const suite = decodeFluidSuite((configRow.inline_datum as { bytes: string }).bytes, 'preview', CONFIG);
const poolDatum = decodePlutusData((resolved[POOL].datum as { cbor: string }).cbor);
const reading = decodeFeedReading((resolved[READING].datum as { cbor: string }).cbor);
const sheetRow = rows.find((r) => r.tx_hash.startsWith('bc72910169088cc8')) as KoiosUtxo;

const PRINCIPAL = 50_000_000n;
const TERM_MS = 604_800_000n;
const UPPER = posixMsToSlot(((reading.observedAt + 999n) / 1000n) * 1000n, 'preview');
const LOWER = UPPER - 600n;
const START_MS = slotToPosixMs(UPPER, 'preview');
const COLLATERAL = fluidBorrowGuards(poolDatum, {
  principal: PRINCIPAL, collateral: 10n ** 15n, validFromMs: slotToPosixMs(LOWER, 'preview'), validToMs: START_MS,
});
const effectiveSpot = reading.min12h < reading.spot ? reading.min12h : reading.spot;
const STRIKE = (effectiveSpot * 7n) / 10n;
const { cell, rateBps } = g3SheetCell((sheetRow.inline_datum as { bytes: string }).bytes, {
  class: 0, depthBps: g3DepthBps(reading, STRIKE), termMs: TERM_MS,
});
const PREMIUM = g3LegPremium({ coverage: PRINCIPAL, totalCoverage: PRINCIPAL, rateBps, loadBps: 100n }, G3_PREVIEW_ADA);

function plan(edit: (p: FluidCoverPlan) => void = () => undefined): FluidCoverPlan {
  const p: FluidCoverPlan = {
    suite, fluidScripts: FLUID_SCRIPTS, pool: POOL, principal: PRINCIPAL, collateral: COLLATERAL, borrower: BORROWER,
    funding: [WALLET], collateralInput: WALLET, validFromSlot: LOWER, validToSlot: UPPER,
    cover: {
      instance: G3_PREVIEW_ADA, head: HEAD, reading: READING, table: TABLE, insured: INSURED, feed: FEED, class: 0,
      strike: STRIKE, startMs: START_MS, termMs: TERM_MS,
      legs: [{ offer: OFFER, coverage: PRINCIPAL, premium: PREMIUM, sheet: SHEET, cell }],
    },
    resolved, params: PARAMS,
  };
  edit(p);
  return p;
}

const fields = (cbor: string) => (decodePlutusData(cbor) as PlutusConstr).fields;
const datumOf = (o: TxOutput) => (o.datum as { cbor: string }).cbor;

describe('composeFluidBorrowWithCover', () => {
  const tx = composeFluidBorrowWithCover(plan());
  const { draft, layout } = tx;
  const out = draft.outputs;
  const redeemer = (purpose: string, index: number) =>
    draft.redeemers.find((r) => r.purpose === purpose && r.index === index) as { data: string };

  it('prices the cover on the live preview sheet the offer names', () => {
    expect(PREMIUM).toBe(20_000_000n);
    expect(COLLATERAL).toBeGreaterThan(PRINCIPAL);
  });

  it("places the borrow's four outputs first and the Book's after them", () => {
    expect(layout).toEqual({
      pool: 0, loan: 1, borrowerBond: 2, lenderBond: 3, head: 4, pLeg: 5, legs: 6, conts: 7, fee: 8, accrual: 9, change: 10,
    });
    expect(out).toHaveLength(11);
    expect(out[0]).toMatchObject({ address: resolved[POOL].address, lovelace: resolved[POOL].lovelace - PRINCIPAL, assets: resolved[POOL].assets });
    expect(datumOf(out[0])).toBe((resolved[POOL].datum as { cbor: string }).cbor);
  });

  it('names the loan and both bonds by the pool input it spends', () => {
    const loanId = fluidLoanId(POOL);
    expect(tx.loanId).toBe(loanId);
    expect(out[1].address).toBe('10' + suite.loanSpendScriptHash + BORROWER.slice(58));
    expect(out[1].lovelace).toBe(COLLATERAL);
    expect(out[1].assets).toEqual({ [suite.loanPolicyId]: { [loanId]: 1n } });
    const poolId = Object.keys(resolved[POOL].assets[suite.poolPolicyId])[0];
    expect(datumOf(out[1])).toBe(
      bytesToHex(encodePlutusData(fluidLoanDatum(poolDatum, { collateralIndex: 0, principal: PRINCIPAL, validToMs: START_MS, poolId }))),
    );
    expect(out[2]).toMatchObject({ address: BORROWER, assets: { [suite.borrowerBondPolicyId]: { [loanId]: 1n } }, datum: null });
    expect(out[3].assets).toEqual({ [suite.lenderBondPolicyId]: { [loanId]: 1n } });
    for (const o of [out[2], out[3]]) expect(o.lovelace).toBe(minUtxo(o, PARAMS));
    expect(draft.mint).toMatchObject({
      [suite.loanPolicyId]: { [loanId]: 1n },
      [suite.lenderBondPolicyId]: { [loanId]: 1n },
      [suite.borrowerBondPolicyId]: { [loanId]: 1n },
    });
  });

  it('keeps the Head and writes the position its digest names', () => {
    const digest = g3Digest(HEAD);
    expect(tx.digest).toBe(digest);
    expect(out[4]).toEqual({ ...resolved[HEAD], referenceScript: undefined, scriptRef: null });
    expect(out[5].assets).toEqual({ [G3_PREVIEW_ADA.positionHash]: { ['50' + digest]: 1n } });
    expect(out[5].lovelace).toBe(minUtxo(out[5], PARAMS));
    const p = fields(datumOf(out[5]));
    expect(p.slice(0, 8)).toEqual([
      expect.any(Uint8Array), expect.any(Uint8Array), STRIKE, PRINCIPAL, PREMIUM, START_MS, START_MS + TERM_MS, expect.any(Uint8Array),
    ]);
    expect(bytesToHex(p[1] as Uint8Array)).toBe(INSURED);
    expect(draft.mint[G3_PREVIEW_ADA.positionHash]).toEqual({ ['43' + digest]: 1n, ['50' + digest]: 1n });
  });

  it("writes the leg at the offer's stake and re-parks the offer's remainder with its datum", () => {
    const offer = resolved[OFFER];
    const digest = tx.digest;
    expect(out[6].address).toBe('10' + G3_PREVIEW_ADA.positionHash + offer.address.slice(58));
    expect(out[6]).toMatchObject({ lovelace: PRINCIPAL, assets: { [G3_PREVIEW_ADA.positionHash]: { ['43' + digest]: 1n } } });
    const leg = fields(datumOf(out[6]));
    expect(leg[0]).toEqual(fields((offer.datum as { cbor: string }).cbor)[0]);
    expect(leg.slice(1, 3)).toEqual([PRINCIPAL, PREMIUM]);
    expect(bytesToHex(encodePlutusData(leg[3]))).toBe(`d879825820${OFFER.slice(0, 64)}00`);
    expect(bytesToHex(leg[4] as Uint8Array)).toBe(digest);
    expect(out[7]).toMatchObject({ address: offer.address, lovelace: offer.lovelace + PREMIUM - PRINCIPAL, datum: offer.datum });
  });

  it("pays the protocol fee to the treasury and the Treasury's cut to the accrual script", () => {
    const digestDatum = bytesToHex(encodePlutusData(hexToBytes(tx.digest)));
    expect(out[8]).toMatchObject({ address: G3_PREVIEW_ADA.treasury, lovelace: g3ProtocolFee(PREMIUM, G3_PREVIEW_ADA, PARAMS) });
    expect(datumOf(out[8])).toBe(digestDatum);
    expect(out[9].address).toBe('70' + G3_PREVIEW_ADA.accrualHash);
    expect(datumOf(out[9])).toBe(digestDatum);
    const floor = minUtxo(out[9], PARAMS);
    const owed = g3Donation(PREMIUM, G3_PREVIEW_ADA);
    expect(out[9].lovelace).toBe(owed > floor ? owed : floor);
    expect(draft.donation).toBeNull();
  });

  it('points every redeemer and every index it carries at what it names', () => {
    expect(draft.inputs).toEqual([...draft.inputs].sort());
    const spend = (ref: string) => draft.inputs.indexOf(ref);
    expect(redeemer('spend', spend(POOL)).data).toBe(bytesToHex(encodePlutusData(FLUID_POOL_SPEND_REDEEMER)));
    expect(fields(redeemer('spend', spend(OFFER)).data)).toEqual([BigInt(spend(HEAD))]);
    const u = fields(redeemer('spend', spend(HEAD)).data);
    expect(u.slice(0, 7)).toEqual([PRINCIPAL, PREMIUM, 4n, 5n, 6n, 7n, 8n]);
    expect(u[7]).toEqual([[BigInt(draft.referenceInputs.indexOf(G3_PREVIEW_ADA.sheets[SHEET])), BigInt(cell)]]);

    const withdrawals = draft.withdrawals.map((w) => w.credential.hash);
    expect(withdrawals).toEqual([suite.poolBorrowActionScriptHash, G3_PREVIEW_ADA.observerHash, suite.poolPolicyId]);
    const configIndex = BigInt(draft.referenceInputs.indexOf(CONFIG));
    const borrow = fields(redeemer('withdraw', 0).data);
    expect(borrow[0]).toBe(configIndex);
    const [borrowed] = borrow[1] as PlutusConstr[];
    expect(borrowed.fields.slice(1, 3)).toEqual([3n, 2n]);
    expect(borrowed.fields[6]).toBe(PRINCIPAL);
    expect(fields(redeemer('withdraw', 2).data)[0]).toBe(configIndex);

    const mints = Object.keys(draft.mint).sort();
    const ordered = [...draft.redeemers].sort((a, b) => ['spend', 'mint', 'cert', 'withdraw'].indexOf(a.purpose) - ['spend', 'mint', 'cert', 'withdraw'].indexOf(b.purpose) || a.index - b.index);
    const origin = ordered.findIndex((r) => r.purpose === 'withdraw' && r.index === 2);
    expect(fields(redeemer('mint', mints.indexOf(suite.loanPolicyId)).data)).toEqual([configIndex, { constructor: 1, fields: [] }, BigInt(origin)]);
    expect(draft.redeemers).toHaveLength(10);
    expect(draft.requiredSigners).toEqual([INSURED]);
  });

  it("attests the reading the way the landed sale's observer redeemer did", () => {
    const sold = decodeTransaction(landed.signed);
    const withdraw = sold.redeemers.find((r) => r.purpose === 'withdraw') as { data: string };
    const soldRows = resolvedOutputsFromKoios(landed.utxoInfo as unknown as KoiosUtxo[]);
    const soldReading = Object.keys(soldRows).find((r) => r.startsWith('09e25e1b')) as string;
    const recomposed = composeFluidBorrowWithCover(plan((p) => {
      p.resolved = { ...resolved, [soldReading]: soldRows[soldReading] };
      p.cover.reading = soldReading;
    }));
    const observer = recomposed.draft.redeemers.find((r) => r.purpose === 'withdraw' && r.index === 1) as { data: string };
    expect(observer.data).toBe(withdraw.data);
  });

  it('balances on the change output at the fee and collateral the ledger asks', () => {
    let lovelace = 0n;
    for (const r of draft.inputs) lovelace += resolved[r].lovelace;
    for (const o of out) lovelace -= o.lovelace;
    expect(lovelace).toBe(draft.fee);
    expect(out[10].address).toBe(BORROWER);
    expect(out[10].assets).toEqual({});
    expect(draft.fee).toBe(minFee(draft, PARAMS, { witnesses: 1, referenceScriptBytes: tx.referenceScriptBytes }));
    expect(tx.referenceScriptBytes).toBe(
      draft.referenceInputs.reduce((s, r) => s + (resolved[r].referenceScript?.size ?? 0), 0),
    );
    expect(draft.totalCollateral).toBe(requiredCollateral(draft.fee, PARAMS));
    expect(draft.collateralReturn).toMatchObject({ address: BORROWER, lovelace: resolved[WALLET].lovelace - (draft.totalCollateral as bigint) });
  });

  it("donates the Treasury's cut itself once it passes the accrual output's min-UTxO", () => {
    const premium = 300_000_000n;
    const rich = composeFluidBorrowWithCover(plan((p) => { p.cover.legs = [{ ...p.cover.legs[0], premium }]; }));
    expect(rich.draft.outputs[rich.layout.accrual].lovelace).toBe(g3Donation(premium, G3_PREVIEW_ADA));
    expect(g3Donation(premium, G3_PREVIEW_ADA)).toBeGreaterThan(minUtxo(rich.draft.outputs[rich.layout.accrual], PARAMS));
  });

  it('keeps the datum a Head carries', () => {
    const datum = { kind: 'inline' as const, cbor: 'd87980' };
    const kept = composeFluidBorrowWithCover(plan((p) => { p.resolved = { ...resolved, [HEAD]: { ...resolved[HEAD], datum } }; }));
    expect(kept.draft.outputs[kept.layout.head].datum).toEqual(datum);
  });

  it('declares the units an evaluation measured', () => {
    const units = draft.redeemers.map((r, i) => ({ purpose: r.purpose, index: r.index, mem: 1000n + BigInt(i), steps: 9000n }));
    const measured = composeFluidBorrowWithCover(plan((p) => { p.units = units; }));
    expect(measured.draft.redeemers.map((r) => r.mem)).toEqual(units.map((u) => u.mem));
    expect(measured.draft.fee).toBeLessThan(draft.fee);
  });

  const withOutput = (ref: string, edit: (o: ResolvedOutput) => void) => (p: FluidCoverPlan) => {
    const o: ResolvedOutput = { ...resolved[ref], assets: { ...resolved[ref].assets } };
    edit(o);
    p.resolved = { ...resolved, [ref]: o };
  };

  it.each<[string, (p: FluidCoverPlan) => void, RegExp]>([
    ['cover of another instance', (p) => { p.cover.instance = { ...G3_PREVIEW_ADA, unit: 'ab'.repeat(28) }; }, /ADA instance/],
    ['no leg', (p) => { p.cover.legs = []; }, /no leg/],
    ['two legs on one offer', (p) => { p.cover.legs = [p.cover.legs[0], p.cover.legs[0]]; }, /two legs name one offer/],
    ['a principal the pool cannot keep its min-UTxO after', (p) => { p.principal = resolved[POOL].lovelace; p.collateral = 10n ** 12n; }, /min-UTxO/],
    ['collateral under the pool ratio', (p) => { p.collateral = PRINCIPAL; }, /asks/],
    ['a missing script reference', (p) => { p.fluidScripts = {}; }, /no reference input carries/],
    ['a sheet the instance does not name', (p) => { p.cover.legs = [{ ...p.cover.legs[0], sheet: '00'.repeat(32) }]; }, /no sheet/],
    ['an unread input', (p) => { p.funding = ['ab'.repeat(32) + '#0']; }, /hold no input/],
    ['a token-holding collateral input', withOutput(WALLET, (o) => { o.assets = { ['ab'.repeat(28)]: { '': 1n } }; }), /collateral input holds a token/],
    ['an offer short of its leg', (p) => { p.cover.legs = [{ ...p.cover.legs[0], coverage: 10n ** 12n }]; }, /less than its leg/],
    ['a wallet short of the sale', withOutput(WALLET, (o) => { o.lovelace = 60_000_000n; }), /lovelace short/],
    ['a borrower with no stake key', (p) => { p.borrower = '60' + INSURED; }, /no stake credential for the loan/],
  ])('refuses %s', (_what, edit, expected) => {
    expect(() => composeFluidBorrowWithCover(plan(edit))).toThrow(expected);
  });
});


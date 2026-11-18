// The Conway transaction codec against the first gen-3 sale on preview (cf447ae7): the bytes
// the relay presented decode to the sale the chain landed, re-encode byte for byte, take the
// buyer's CIP-30 witness set to become the landed transaction, and price at the fee and
// min-UTxO the reference builder settled them at.

import { describe, it, expect } from 'vitest';
import {
  decodeTransaction,
  draftId,
  encodeTransaction,
  minFee,
  minUtxo,
  protocolParamsFromCli,
  requiredCollateral,
  scriptDataHash,
  spliceVkeyWitnesses,
  transactionId,
  txViewOf,
} from '../tx';
import { decodeCborItem, encodeCborItem } from '../cbor_item';
import { bytesToHex, hexToBytes } from '../cbor';
import { InputError } from '../errors';
import sale from './fixtures/g3_preview_sale.json';
import cli from './fixtures/preview_protocol_params.json';

const POSITION = '60e9069318a5a5f6adcd8be58a04a616e50fe14f7359d82239843537';
const DIGEST = '9f2f99d6d154d220550ada857535a79b111a1e85898bdfebf862ce3a';
const OBSERVER = '8f5b93aefb8f471f19128ab92e56d04b2435e9f88bcdfd35238211c8';
const REF_SCRIPT_BYTES = 8528 + 14220 + 4014;
const PARAMS = protocolParamsFromCli(cli.response);

describe('decodeTransaction', () => {
  const tx = decodeTransaction(sale.prepared);

  it('names the transaction by the hash of its body bytes', () => {
    expect(tx.id).toBe(sale.tx);
    expect(transactionId(sale.prepared)).toBe(sale.tx);
    expect(transactionId(sale.signed)).toBe(sale.tx);
  });

  it('reads the body the relay presented', () => {
    expect(tx.inputs).toEqual([
      '93492f0ed239f3d3da55e095defdd347d5ee2d69d53edadeff1aeb7502b9b6eb#4',
      '9b9df872bf82aeaf2f03a9c297fa44450cff0499a48f3b8345aaae1c97dd08ae#0',
      'a3e5dadfd53efa164e44ff8584e8f0c9fc769b651db5461f8a2f3ab29d763fb8#0',
    ]);
    expect(tx.referenceInputs).toHaveLength(6);
    expect(tx.collateral).toEqual(['93492f0ed239f3d3da55e095defdd347d5ee2d69d53edadeff1aeb7502b9b6eb#4']);
    expect(tx.fee).toBe(847514n);
    expect(tx.validFromSlot).toBe(128383443n);
    expect(tx.validToSlot).toBe(128383743n);
    expect(tx.donation).toBe(100000n);
    expect(tx.networkId).toBeNull();
    expect(tx.requiredSigners).toEqual(['de118571ecf7e7e4956f7752054cf4b7a41dd0189d93b2cc1abc50fe']);
    expect(tx.mint).toEqual({ [POSITION]: { ['43' + DIGEST]: 1n, ['50' + DIGEST]: 1n } });
    expect(tx.withdrawals).toEqual([{ credential: { kind: 'script', hash: OBSERVER }, networkId: 0, amount: 0n }]);
    expect(tx.certificates).toBe(0);
    expect(tx.outputs.map((o) => o.lovelace)).toEqual([2000000n, 2111900n, 50000000n, 470000000n, 1137840n, 372664303n]);
    expect(tx.outputs[1].assets).toEqual({ [POSITION]: { ['50' + DIGEST]: 1n } });
    expect(tx.outputs[1].datum?.kind).toBe('inline');
    expect(tx.totalCollateral).toBe(1271271n);
    expect(tx.collateralReturn?.lovelace).toBe(396861557n - 1271271n);
    expect(tx.auxiliaryData).not.toBeNull();
    expect(tx.vkeyWitnesses).toEqual([]);
    expect(tx.redeemers.map((r) => [r.purpose, r.index, r.mem, r.steps])).toEqual([
      ['spend', 1, 1666660n, 652683085n],
      ['spend', 2, 110787n, 37944510n],
      ['mint', 0, 97460n, 29861558n],
      ['withdraw', 0, 331793n, 119765932n],
    ]);
  });

  it('reads the witness the buyer signed with', () => {
    const signed = decodeTransaction(sale.signed);
    expect(signed.vkeyWitnesses).toEqual(['de118571ecf7e7e4956f7752054cf4b7a41dd0189d93b2cc1abc50fe']);
  });

  it('refuses bytes that are no transaction', () => {
    expect(() => decodeTransaction('83a0a0f5')).toThrow(InputError);
    expect(() => decodeTransaction(sale.prepared + '00')).toThrow(/trailing/);
    expect(() => decodeTransaction(sale.prepared.slice(0, -2))).toThrow(/end of CBOR/);
    expect(() => decodeTransaction('84a0a0f5ff')).toThrow(/break outside/);
  });
});

describe('spliceVkeyWitnesses', () => {
  it("turns the presented bytes and the wallet's witness set into the landed transaction", () => {
    expect(spliceVkeyWitnesses(sale.prepared, sale.witnessSet)).toBe(sale.signed);
  });

  it('keeps the body, so the id the buyer signed is the id that lands', () => {
    const signed = spliceVkeyWitnesses(sale.prepared, sale.witnessSet);
    expect(transactionId(signed)).toBe(sale.tx);
  });

  it('reads a witness set written as a tag-258 set', () => {
    const set = decodeCborItem(hexToBytes(sale.witnessSet));
    if (set.t !== 'map') throw new Error('the fixture witness set is no map');
    const tagged = encodeCborItem({ t: 'map', entries: [[set.entries[0][0], { t: 'tag', tag: 258n, item: set.entries[0][1] }]] });
    expect(spliceVkeyWitnesses(sale.prepared, bytesToHex(tagged))).toBe(sale.signed);
  });

  it('refuses a witness set carrying no vkey witness', () => {
    expect(() => spliceVkeyWitnesses(sale.prepared, 'a0')).toThrow(/no vkey witness/);
  });
});

describe('encodeTransaction', () => {
  it('writes the decoded sale back byte for byte', () => {
    const tx = decodeTransaction(sale.prepared);
    expect(bytesToHex(encodeTransaction(txViewOf(tx)))).toBe(sale.prepared);
    expect(draftId(txViewOf(tx))).toBe(sale.tx);
  });

  it('hashes the redeemers and the PlutusV3 cost model to the integrity hash the body carries', () => {
    const tx = decodeTransaction(sale.prepared);
    expect(scriptDataHash(tx.redeemers, PARAMS.costModelsV3)).toBe(tx.scriptDataHash);
  });

  it('refuses to draft a transaction it could not write back', () => {
    const tx = decodeTransaction(sale.prepared);
    expect(() => txViewOf({ ...tx, certificates: 1 })).toThrow(/no certificates/);
    expect(() => txViewOf({ ...tx, otherBodyKeys: [20] })).toThrow(/no body key 20/);
    expect(() => txViewOf({ ...tx, otherWitnessKeys: [7] })).toThrow(/no witness key 7/);
  });
});

describe('fees and min-UTxO', () => {
  const tx = decodeTransaction(sale.prepared);

  it('reads the decimal prices as the exact fractions they spell', () => {
    expect(PARAMS.priceMem).toEqual([577n, 10000n]);
    expect(PARAMS.priceSteps).toEqual([721n, 10000000n]);
    expect(PARAMS.refScriptCostPerByte).toEqual([15n, 1n]);
    expect(PARAMS.costModelsV3).toHaveLength(cli.response.costModels.PlutusV3.length);
    expect(() => protocolParamsFromCli({ ...cli.response, executionUnitPrices: undefined })).toThrow(/prices/);
    expect(() => protocolParamsFromCli({ ...cli.response, txFeePerByte: 44.5 })).toThrow(/whole/);
  });

  it('asks the collateral the relay put up for the fee', () => {
    expect(requiredCollateral(tx.fee, PARAMS)).toBe(tx.totalCollateral);
  });

  it("prices the sale at the fee the relay settled for the insured's and a spare witness", () => {
    expect(minFee(txViewOf(tx), PARAMS, { witnesses: 2, referenceScriptBytes: REF_SCRIPT_BYTES })).toBe(847514n);
    expect(minFee(txViewOf(tx), PARAMS, { witnesses: 1, referenceScriptBytes: REF_SCRIPT_BYTES })).toBe(843070n);
  });

  it("sizes each output's min-UTxO as the ledger does", () => {
    expect(tx.outputs.map((o) => minUtxo(o, PARAMS))).toEqual([
      1073190n,
      2077420n,
      1780030n,
      1629180n,
      1137840n,
      978370n,
    ]);
  });
});

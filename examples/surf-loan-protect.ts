/**
 * D:\aegis\sdk\examples\surf-loan-protect.ts
 *
 * Example: one-click "add liquidation insurance" on a Surf loan, composed into
 * the SAME transaction the borrower already signs at loan setup — using the V4
 * pool-funded composer (@fluxpointstudios/aegis-sdk buildUnderwriteParts) + MeshJS.
 *
 * The eUTxO model lets Surf open the borrower's loan AND underwrite an Aegis
 * barrier policy against liquidation in one tx, one signature, one fee. The
 * Aegis pool funds the coverage; the borrower pays only the premium + the tiny
 * treasury donation + fees.
 *
 * Prerequisites:
 *   npm install @meshsdk/core @fluxpointstudios/aegis-sdk
 *
 * NOTE: MeshJS imports below are illustrative (not bundled with the SDK). The
 * @fluxpointstudios/aegis-sdk imports are real.
 */

// import { Transaction, BrowserWallet, BlockfrostProvider } from '@meshsdk/core';
import {
  aegisBindings,
  buildUnderwriteParts,
  quoteForPosition,
  decodePoolDatum,
  hexToBytes,
  type PoolDatum,
} from '@fluxpointstudios/aegis-sdk';

const AEGIS_API = 'https://api.aegis.fluxpointstudios.com';

/**
 * Splice Aegis liquidation cover into a Surf borrow transaction.
 *
 * @param wallet         connected MeshJS BrowserWallet
 * @param borrowerPkh    borrower payment key hash (56 hex)
 * @param collateralAda  the Surf loan collateral (drives the coverage amount)
 * @param surfFeedNft    the canonical Surf-event oracle NFT for this market
 */
export async function addSurfLiquidationCover(
  wallet: any,
  borrowerPkh: string,
  collateralAda: number,
  surfFeedNft: string,
) {
  const bindings = aegisBindings('mainnet');

  // 1. Pick the cover terms. For a Surf liquidation barrier the strike is the
  //    market's liquidation price; here we cover `collateralAda` ADA of value
  //    against a 25%-below-spot touch over 30 days.
  const coverageLovelace = BigInt(Math.round(collateralAda * 1_000_000));
  const spotScaled = 800_000n; // $0.80 spot (read from the Aegis price API)
  const strikeScaled = 600_000n; // $0.60 liquidation strike (25% below)
  const durationDays = 30;

  // 2. Fetch the authoritative premium from the Aegis API (the exact actuarial
  //    GBM price; the SDK does NOT re-derive it).
  const quote = await fetch(`${AEGIS_API}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      risk_class: 'barrier',
      coverage_lovelace: coverageLovelace.toString(),
      strike_price: Number(strikeScaled),
      spot_price: Number(spotScaled),
      days: durationDays,
      asset: 'ALT_LIQUID',
    }),
  }).then((r) => r.json());
  const premiumLovelace = BigInt(quote.premium_lovelace);

  // 3. Fail-fast: will the chain accept this exact policy? (Floor, dead-zone,
  //    premium<coverage, ratio — surfaced up front, not as an opaque reject.)
  const verdict = quoteForPosition({
    riskClass: 'Barrier',
    coverageLovelace,
    strikePriceScaled: strikeScaled,
    spotPriceScaled: spotScaled,
    durationDays,
    premiumLovelace,
  });
  if (!verdict.insurable) throw new Error(`not insurable: ${verdict.reason}`);

  // 4. Read the live Aegis pool UTxO (the singleton pinned by the pool NFT).
  //    Any provider works; here Blockfrost via MeshJS.
  // const provider = new BlockfrostProvider('<PROJECT_ID>');
  // const poolUtxos = await provider.fetchAddressUTxOs(bindings.poolAddress, bindings.poolNftPolicyId);
  // const poolUtxo = poolUtxos[0];
  const poolUtxo: any = /* poolUtxos[0] */ {} as any;
  const poolDatum: PoolDatum = decodePoolDatum(hexToBytes(poolUtxo.output.plutusData));

  // 5. Compose the pool-funded Underwrite parts.
  const parts = buildUnderwriteParts({
    bindings,
    pool: {
      utxoRef: { txHash: poolUtxo.input.txHash, index: poolUtxo.input.outputIndex },
      lovelace: BigInt(poolUtxo.output.amount.find((a: any) => a.unit === 'lovelace').quantity),
      datum: poolDatum,
    },
    insuredPkh: borrowerPkh,
    strikePriceScaled: strikeScaled,
    spotPriceScaled: spotScaled,
    coverageLovelace,
    premiumLovelace,
    durationDays,
    oraclePolicyId: surfFeedNft,
    oracleProvider: 'AegisSelf',
    riskClass: 'Barrier',
  });

  // 6. Splice the parts into the Surf borrow tx. (Pseudo-MeshJS — the same tx
  //    that opens the loan also carries the Aegis outputs.)
  //
  // const tx = new Transaction({ initiator: wallet })
  //   // ... Surf's own loan output(s) ...
  //   .redeemValue({ value: poolUtxo, script: poolRefScript, redeemer: { data: parts.poolRedeemerCbor } })
  //   .mintAsset(markerRefScript, { policyId: parts.mint.policyId, assetName: parts.mint.assetNameHex,
  //     assetQuantity: '1', redeemer: { data: parts.mint.redeemerCbor } })
  //   .sendValue({ address: parts.policyOutput.address, datum: { inline: parts.policyOutput.inlineDatumCbor } },
  //     [{ unit: 'lovelace', quantity: parts.policyOutput.lovelace.toString() },
  //      { unit: parts.policyOutput.marker.policyId + parts.policyOutput.marker.assetNameHex, quantity: '1' }])
  //   .sendValue({ address: parts.poolOutput.address, datum: { inline: parts.poolOutput.inlineDatumCbor } },
  //     [{ unit: 'lovelace', quantity: parts.poolOutput.lovelace.toString() },
  //      { unit: parts.poolOutput.poolNft.policyId + parts.poolOutput.poolNft.assetNameHex, quantity: '1' }])
  //   .sendLovelace(parts.teamOutput.address, parts.teamOutput.lovelace.toString())
  //   .setTxRefInputs([parts.references.poolValidator, parts.references.marker, /* live oracle UTxO */])
  //   .setValidityRange(...) // anchored to parts.validity
  //   .setDonation(parts.treasuryDonationLovelace.toString()); // Conway treasury_donation
  //
  // const unsigned = await tx.build();
  // const signed = await wallet.signTx(unsigned);
  // return wallet.submitTx(signed);

  return parts; // returned for inspection in this example
}

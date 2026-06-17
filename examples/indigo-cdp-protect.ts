/**
 * D:\aegis\sdk\examples\indigo-cdp-protect.ts
 *
 * Example: one-click "protect this CDP against liquidation" for an Indigo
 * iUSD CDP, using the V4 pool-funded composer (@fluxpointstudios/aegis-sdk
 * buildUnderwriteParts) + Lucid Evolution.
 *
 * Indigo collateral is ADA, so liquidation risk is an ADA barrier (the CDP is
 * liquidated when ADA falls far enough that the position breaches its minimum
 * collateral ratio). Aegis prices it via the iUSD-relay AegisSelf feed and the
 * pool funds the coverage; the user pays premium + treasury donation + fees.
 *
 * Prerequisites:
 *   npm install lucid-cardano @fluxpointstudios/aegis-sdk
 *
 * NOTE: Lucid imports below are illustrative. The @fluxpointstudios/aegis-sdk imports
 * are real.
 */

// import { Lucid, Blockfrost, Data, Constr } from 'lucid-cardano';
import {
  aegisBindings,
  buildUnderwriteParts,
  quoteForPosition,
  decodePoolDatum,
  hexToBytes,
  type PoolDatum,
} from '@fluxpointstudios/aegis-sdk';

const AEGIS_API = 'https://api.aegis.fluxpointstudios.com';
// The canonical Indigo iUSD relay AegisSelf feed NFT (release/mainnet.json).
const INDIGO_IUSD_RELAY_NFT = 'f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02';

/**
 * Compose Aegis liquidation cover for an Indigo CDP into a Lucid tx.
 *
 * @param lucid       initialised Lucid instance (wallet selected)
 * @param ownerPkh    CDP owner payment key hash (56 hex)
 * @param coverageAda how much ADA-value of liquidation loss to cover
 */
export async function protectIndigoCdp(lucid: any, ownerPkh: string, coverageAda: number) {
  const bindings = aegisBindings('mainnet');

  const coverageLovelace = BigInt(Math.round(coverageAda * 1_000_000));
  const spotScaled = 800_000n; // ADA/USD spot, 1e6-scaled (read from Aegis price API)
  const strikeScaled = 600_000n; // 25%-below-spot barrier (the CDP liquidation level)
  const durationDays = 30;

  // 1. Authoritative premium from the Aegis API (exact GBM price; ADA sigma).
  const quote = await fetch(`${AEGIS_API}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      risk_class: 'barrier',
      coverage_lovelace: coverageLovelace.toString(),
      strike_price: Number(strikeScaled),
      spot_price: Number(spotScaled),
      days: durationDays,
      asset: 'ADA',
    }),
  }).then((r) => r.json());
  const premiumLovelace = BigInt(quote.premium_lovelace);

  // 2. Fail-fast insurability + on-chain floor check.
  const verdict = quoteForPosition({
    riskClass: 'Barrier',
    coverageLovelace,
    strikePriceScaled: strikeScaled,
    spotPriceScaled: spotScaled,
    durationDays,
    premiumLovelace,
  });
  if (!verdict.insurable) throw new Error(`not insurable: ${verdict.reason}`);

  // 3. Read the live Aegis pool UTxO (singleton, pinned by the pool NFT).
  // const [poolUtxo] = await lucid.utxosAtWithUnit(
  //   bindings.poolAddress, bindings.poolNftPolicyId + asciiHex('AEGIS_POOL_V4'));
  const poolUtxo: any = /* [poolUtxo] */ {} as any;
  const poolDatum: PoolDatum = decodePoolDatum(hexToBytes(poolUtxo.datum));

  // 4. Compose the pool-funded Underwrite parts.
  const parts = buildUnderwriteParts({
    bindings,
    pool: {
      utxoRef: { txHash: poolUtxo.txHash, index: poolUtxo.outputIndex },
      lovelace: BigInt(poolUtxo.assets.lovelace),
      datum: poolDatum,
    },
    insuredPkh: ownerPkh,
    strikePriceScaled: strikeScaled,
    spotPriceScaled: spotScaled,
    coverageLovelace,
    premiumLovelace,
    durationDays,
    oraclePolicyId: INDIGO_IUSD_RELAY_NFT,
    oracleProvider: 'AegisSelf',
    riskClass: 'Barrier',
  });

  // 5. Splice into the Lucid tx that also opens/adjusts the Indigo CDP.
  //
  // const markerUnit = parts.mint.policyId + parts.mint.assetNameHex;
  // const poolNftUnit = parts.poolOutput.poolNft.policyId + parts.poolOutput.poolNft.assetNameHex;
  // const tx = await lucid.newTx()
  //   // ... Indigo's own CDP output(s) ...
  //   .collectFrom([poolUtxo], parts.poolRedeemerCbor)
  //   .mintAssets({ [markerUnit]: 1n }, parts.mint.redeemerCbor)
  //   .payToContract(parts.policyOutput.address,
  //     { inline: parts.policyOutput.inlineDatumCbor },
  //     { lovelace: parts.policyOutput.lovelace, [markerUnit]: 1n })
  //   .payToContract(parts.poolOutput.address,
  //     { inline: parts.poolOutput.inlineDatumCbor },
  //     { lovelace: parts.poolOutput.lovelace, [poolNftUnit]: 1n })
  //   .payToAddress(parts.teamOutput.address, { lovelace: parts.teamOutput.lovelace })
  //   .readFrom([/* poolValidator ref */, /* marker ref */, /* live oracle UTxO */])
  //   .validFrom(...).validTo(...)              // anchored to parts.validity
  //   .addDonation?.(parts.treasuryDonationLovelace) // Conway treasury_donation
  //   .complete();
  // const signed = await tx.sign().complete();
  // return signed.submit();

  return parts; // returned for inspection in this example
}

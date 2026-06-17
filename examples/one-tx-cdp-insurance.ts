/**
 * D:\aegis\sdk\examples\one-tx-cdp-insurance.ts
 *
 * Example: Atomic CDP creation + Aegis insurance in ONE transaction.
 *
 * This is the "killer feature" of Aegis on Cardano -- the eUTxO model
 * lets you create a CDP at a lending protocol AND buy insurance against
 * liquidation in a single transaction with one signature and one fee.
 *
 * This example shows the pattern with MeshJS. The same approach works
 * with Lucid, cardano-cli, or any transaction builder that supports
 * multiple outputs with inline datums.
 *
 * Prerequisites:
 *   npm install @meshsdk/core @fluxpointstudios/aegis-sdk
 */

import { AegisSDK, calculatePremium, LOVELACE_PER_ADA } from '../src';

// NOTE: MeshJS imports are illustrative -- uncomment when using in a real project
// import { Transaction, BrowserWallet } from '@meshsdk/core';

/**
 * Demonstrates the atomic CDP + insurance pattern.
 *
 * Transaction structure:
 *   Inputs:
 *     [0] User wallet UTxO (collateral + premium + fees)
 *
 *   Outputs:
 *     [0] CDP UTxO at lending protocol script address
 *         - Value: collateral amount
 *         - Datum: CDP datum (protocol-specific)
 *     [1] Aegis policy UTxO at policy validator address
 *         - Value: insurance premium
 *         - Datum: PolicyDatum (CBOR-encoded)
 *     [2] Change back to user wallet
 *
 *   Result: One signature, one fee, atomic execution.
 *   If either output fails validation, the entire transaction is rejected.
 */
async function atomicCdpAndInsurance() {
  // ----- Configuration -----

  const aegis = new AegisSDK();

  // Lending protocol parameters (these would come from the lending protocol's SDK)
  const CDP_SCRIPT_ADDRESS = 'addr_test1wz...'; // Lending protocol's script address
  const collateralAda = 3000;                     // 3000 ADA collateral for CDP
  const borrowedAmount = 1000;                     // Borrowing 1000 units of synthetic
  const liquidationThreshold = 1.5;                // 150% collateral ratio

  // Current market state (from oracle or API)
  const currentPriceUsd = 0.258;                   // Current ADA/USD
  const poolUtilization = 0.30;                     // 30% pool utilization

  // Insurance parameters
  const insuranceDurationDays = 30;

  // Calculate the liquidation price
  //   liquidation_price = (borrowed_value) / (collateral_ada * liquidation_threshold)
  //   For simplicity, assume borrowed_value is in USD terms
  const liquidationPrice = (borrowedAmount * currentPriceUsd) / (collateralAda * liquidationThreshold);

  // Set strike price 5% above liquidation price (buffer)
  const bufferPct = 0.05;
  const strikePrice = liquidationPrice * (1 + bufferPct);

  // Calculate coverage: the collateral value at risk near liquidation
  const riskFraction = 1.0 - (liquidationPrice / currentPriceUsd);
  const coverageAda = Math.max(collateralAda * riskFraction, 5);

  console.log('=== Atomic CDP + Insurance ===');
  console.log(`Collateral:          ${collateralAda} ADA`);
  console.log(`Borrowed:            ${borrowedAmount} units`);
  console.log(`Current price:       $${currentPriceUsd}`);
  console.log(`Liquidation price:   $${liquidationPrice.toFixed(4)}`);
  console.log(`Strike price:        $${strikePrice.toFixed(4)} (${bufferPct * 100}% buffer)`);
  console.log(`Coverage:            ${coverageAda.toFixed(2)} ADA`);

  // ----- Step 1: Preview the premium -----

  const premiumPreview = aegis.previewPremium({
    coverageAda,
    strikePrice,
    currentPrice: currentPriceUsd,
    durationDays: insuranceDurationDays,
    poolUtilization,
  });

  console.log(`\nInsurance premium:   ${Number(premiumPreview.premiumLovelace) / 1_000_000} ADA`);
  console.log(`  Base rate:         ${(premiumPreview.baseRate * 100).toFixed(2)}%`);
  console.log(`  Duration mult:     ${premiumPreview.durationMult.toFixed(2)}x`);
  console.log(`  Util factor:       ${premiumPreview.utilFactor.toFixed(2)}x`);
  console.log(`  Strike distance:   ${(premiumPreview.strikeDistance * 100).toFixed(1)}%`);

  // ----- Step 2: Build the Aegis policy output -----

  const userPkh = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

  const policyOutput = aegis.buildPolicyOutput({
    insuredPkh: userPkh,
    strikePrice,
    coverageAda,
    durationDays: insuranceDurationDays,
    currentPrice: currentPriceUsd,
    poolUtilization,
  });

  console.log(`\nPolicy output ready:`);
  console.log(`  Address: ${policyOutput.address}`);
  console.log(`  Amount:  ${policyOutput.amount} lovelace`);
  console.log(`  Datum:   ${policyOutput.datum.length} bytes CBOR`);

  // ----- Step 3: Build the MeshJS transaction with BOTH outputs -----
  //
  // const wallet = await BrowserWallet.enable('nami');
  // const tx = new Transaction({ initiator: wallet });
  //
  // // Output 0: CDP at lending protocol
  // tx.sendLovelace(
  //   {
  //     address: CDP_SCRIPT_ADDRESS,
  //     datum: { inline: cdpDatumHex },  // Protocol-specific CDP datum
  //   },
  //   (collateralAda * 1_000_000).toString()
  // );
  //
  // // Output 1: Aegis insurance policy
  // tx.sendLovelace(
  //   {
  //     address: policyOutput.address,
  //     datum: { inline: Buffer.from(policyOutput.datum).toString('hex') },
  //   },
  //   policyOutput.amount.toString()
  // );
  //
  // // Build, sign, submit -- one signature, one fee
  // const unsignedTx = await tx.build();
  // const signedTx = await wallet.signTx(unsignedTx);
  // const txHash = await wallet.submitTx(signedTx);
  //
  // console.log(`\nAtomic transaction submitted: ${txHash}`);
  // console.log('  CDP created + Insurance purchased in ONE tx!');

  // ----- Total cost summary -----

  const totalCostAda = collateralAda + Number(policyOutput.amount) / 1_000_000;
  console.log(`\n=== Total Cost ===`);
  console.log(`  CDP collateral:    ${collateralAda} ADA`);
  console.log(`  Insurance premium: ${Number(policyOutput.amount) / 1_000_000} ADA`);
  console.log(`  Total:             ${totalCostAda.toFixed(2)} ADA`);
  console.log(`  Insurance cost:    ${((Number(policyOutput.amount) / 1_000_000 / collateralAda) * 100).toFixed(2)}% of collateral`);

  return { policyOutput, premiumPreview };
}

// Run the example
atomicCdpAndInsurance()
  .then(() => console.log('\nExample completed successfully.'))
  .catch(console.error);

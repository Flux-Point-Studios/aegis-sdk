/**
 * D:\aegis\sdk\examples\meshjs-integration.ts
 *
 * Example: Creating an Aegis insurance policy using MeshJS.
 *
 * Shows how to use the @fluxpointstudios/aegis-sdk to build a policy output
 * and compose it into a MeshJS transaction. This is the simplest
 * integration path for MeshJS-based dApps.
 *
 * Prerequisites:
 *   npm install @meshsdk/core @fluxpointstudios/aegis-sdk
 */

// NOTE: These imports are illustrative. MeshJS types are not bundled with the SDK.
// import { Transaction, ForgeScript, BrowserWallet } from '@meshsdk/core';
import { AegisSDK } from '../src';

async function createInsurancePolicy() {
  // 1. Initialize the SDK (preprod is the default and only network for now)
  const aegis = new AegisSDK();

  // 2. Connect wallet (MeshJS browser wallet)
  // const wallet = await BrowserWallet.enable('nami');
  // const addresses = await wallet.getUsedAddresses();
  // const userAddress = addresses[0];

  // For this example, use a placeholder PKH
  const userPkh = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef01';

  // 3. Build the insurance policy output
  //    The SDK calculates the premium and encodes the datum -- no network calls needed
  const policyOutput = aegis.buildPolicyOutput({
    insuredPkh: userPkh,
    strikePrice: 0.20,        // Payout triggers if ADA drops below $0.20
    coverageAda: 500,          // Up to 500 ADA coverage
    durationDays: 30,          // 30-day policy
    currentPrice: 0.258,       // Current ADA/USD price from oracle
    poolUtilization: 0.3,      // 30% pool utilization
  });

  console.log('Policy output built:');
  console.log(`  Address: ${policyOutput.address}`);
  console.log(`  Amount:  ${policyOutput.amount} lovelace (${Number(policyOutput.amount) / 1_000_000} ADA)`);
  console.log(`  Premium breakdown:`);
  console.log(`    Base rate:       ${(policyOutput.premiumBreakdown.baseRate * 100).toFixed(2)}%`);
  console.log(`    Duration mult:   ${policyOutput.premiumBreakdown.durationMult.toFixed(2)}x`);
  console.log(`    Util factor:     ${policyOutput.premiumBreakdown.utilFactor.toFixed(2)}x`);
  console.log(`    Strike distance: ${(policyOutput.premiumBreakdown.strikeDistance * 100).toFixed(1)}%`);

  // 4. Build the MeshJS transaction
  //
  // const tx = new Transaction({ initiator: wallet });
  //
  // tx.sendLovelace(
  //   {
  //     address: policyOutput.address,
  //     datum: { inline: Buffer.from(policyOutput.datum).toString('hex') },
  //   },
  //   policyOutput.amount.toString()
  // );
  //
  // const unsignedTx = await tx.build();
  // const signedTx = await wallet.signTx(unsignedTx);
  // const txHash = await wallet.submitTx(signedTx);
  // console.log(`Policy created! TX: ${txHash}`);

  return policyOutput;
}

// Run the example
createInsurancePolicy()
  .then((output) => {
    console.log('\nSuccess! Policy output ready for transaction composition.');
  })
  .catch(console.error);

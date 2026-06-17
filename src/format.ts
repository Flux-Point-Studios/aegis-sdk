// Human-readable formatters for amounts and composed underwrite parts.
// Pure, zero-dep — for logs, confirmation dialogs, and debugging.

import type { UnderwriteParts } from './compose';

const LOVELACE_PER_ADA = 1_000_000n;

function group(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format lovelace as an ADA string: `2_000_000n → "2 ADA"`, trailing zeros
 *  trimmed, thousands grouped (`1_000_000_000n → "1,000 ADA"`). */
export function formatAda(lovelace: bigint): string {
  const neg = lovelace < 0n;
  const v = neg ? -lovelace : lovelace;
  const whole = group((v / LOVELACE_PER_ADA).toString());
  const frac = (v % LOVELACE_PER_ADA).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${frac ? `${whole}.${frac}` : whole} ADA`;
}

/** Format a 1e6-scaled USD price: `900_000n → "$0.90"` (min 2 decimals, up to 6). */
export function formatUsdScaled(scaled: bigint): string {
  const neg = scaled < 0n;
  const v = neg ? -scaled : scaled;
  const whole = (v / LOVELACE_PER_ADA).toString();
  let frac = (v % LOVELACE_PER_ADA).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

/** A multi-line, human-readable summary of a composed Underwrite — what the
 *  buyer pays, what the pool funds, and the parts that get spliced into the tx. */
export function formatParts(parts: UnderwriteParts): string {
  const d = parts.policyDatum;
  const days = Number((d.expiryTime - d.startTime) / 86_400_000n);
  const lines = [
    `Aegis ${d.riskClass} policy — ${parts.insurable ? 'insurable ✓' : `NOT insurable: ${parts.reason}`}`,
    `  coverage:   ${formatAda(parts.policyOutput.lovelace)} (pool-funded — paid by the Aegis pool)`,
    `  premium:    ${formatAda(d.premiumPaid)} (paid by the buyer)`,
    `  strike:     ${formatUsdScaled(d.strikePrice)}`,
    `  term:       ${days} days`,
    `  team fee:   ${formatAda(parts.teamOutput.lovelace)}`,
    parts.partnerOutput ? `  partner fee: ${formatAda(parts.partnerOutput.lovelace)} → ${parts.partnerOutput.address}` : '  partner fee: none',
    `  treasury:   ${formatAda(parts.treasuryDonationLovelace)} (Conway donation)`,
    `  policy out: ${formatAda(parts.policyOutput.lovelace)} + marker → ${parts.policyOutput.address}`,
    `  pool cont:  ${formatAda(parts.poolOutput.lovelace)} + pool NFT → ${parts.poolOutput.address}`,
    `  mint:       +${parts.mint.quantity} ${parts.mint.policyId}.${parts.mint.assetNameHex}`,
    `  validity:   start ${d.startTime}ms → expiry ${d.expiryTime}ms`,
  ];
  return lines.join('\n');
}

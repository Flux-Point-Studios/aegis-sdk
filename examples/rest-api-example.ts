/**
 * D:\aegis\sdk\examples\rest-api-example.ts
 *
 * Example: Using the Aegis REST API for the fastest integration path.
 *
 * The REST API handles all chain interaction server-side. Integrators
 * only need to make HTTP calls -- no Cardano libraries required.
 *
 * This is Layer 1 integration: minutes to integrate, works from any
 * language or platform.
 *
 * Prerequisites:
 *   - Aegis API running at http://localhost:3020
 *   - Node.js 18+ (for native fetch)
 */

const API_BASE = 'http://localhost:3020';

// ---------------------------------------------------------------------------
// Helper: typed fetch wrapper
// ---------------------------------------------------------------------------

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(`API ${method} ${path} failed: ${err.detail || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Example 1: Get current oracle price
// ---------------------------------------------------------------------------

async function getOraclePrice() {
  const data = await apiCall<{
    price: number;
    price_scaled: number;
    timestamp: number;
    expiry: number;
    fresh: boolean;
    feed: string;
  }>('GET', '/api/oracle/price');

  console.log('=== Oracle Price ===');
  console.log(`  ADA/USD: $${data.price}`);
  console.log(`  Fresh:   ${data.fresh}`);
  console.log(`  Feed:    ${data.feed}`);
  return data;
}

// ---------------------------------------------------------------------------
// Example 2: Preview premium (no transaction)
// ---------------------------------------------------------------------------

async function previewPremium() {
  const data = await apiCall<{
    premium_ada: number;
    premium_lovelace: number;
    coverage_ada: number;
    strike_price_usd: number;
    liquidation_price_usd: number;
    distance_to_strike_pct: number;
  }>('POST', '/api/lending/calculate-premium', {
    loan_amount_lovelace: 1000_000_000,    // 1000 ADA borrowed
    collateral_amount: 3000_000_000,        // 3000 ADA collateral
    liquidation_threshold: 1.5,             // 150% collateral ratio
    duration_days: 30,
    buffer_pct: 0.05,
  });

  console.log('\n=== Premium Preview ===');
  console.log(`  Premium:    ${data.premium_ada} ADA`);
  console.log(`  Coverage:   ${data.coverage_ada} ADA`);
  console.log(`  Strike:     $${data.strike_price_usd}`);
  console.log(`  Distance:   ${data.distance_to_strike_pct}%`);
  return data;
}

// ---------------------------------------------------------------------------
// Example 3: Create a policy (on-chain transaction)
// ---------------------------------------------------------------------------

async function createPolicy() {
  const data = await apiCall<{
    tx_hash: string;
    policy_id: string;
    premium_ada: number;
    premium_lovelace: number;
  }>('POST', '/api/policies/create', {
    strike_price: 0.20,
    coverage_ada: 500,
    duration_days: 30,
  });

  console.log('\n=== Policy Created ===');
  console.log(`  TX Hash:   ${data.tx_hash}`);
  console.log(`  Policy ID: ${data.policy_id}`);
  console.log(`  Premium:   ${data.premium_ada} ADA`);
  return data;
}

// ---------------------------------------------------------------------------
// Example 4: One-shot loan protection
// ---------------------------------------------------------------------------

async function protectLoan() {
  const data = await apiCall<{
    tx_hash: string;
    policy: {
      policy_id: string;
      strike_price_usd: number;
      coverage_ada: number;
      premium_ada: number;
    };
    liquidation_analysis: {
      liquidation_price: number;
      strike_price: number;
      distance_pct: number;
    };
  }>('POST', '/api/lending/protect-loan', {
    protocol: 'danogo',
    loan_amount_lovelace: 1000_000_000,
    collateral_amount: 3000_000_000,
    collateral_token: 'ADA',
    liquidation_threshold: 1.5,
    duration_days: 30,
    buffer_pct: 0.05,
  });

  console.log('\n=== Loan Protected ===');
  console.log(`  TX Hash:     ${data.tx_hash}`);
  console.log(`  Strike:      $${data.policy.strike_price_usd}`);
  console.log(`  Coverage:    ${data.policy.coverage_ada} ADA`);
  console.log(`  Premium:     ${data.policy.premium_ada} ADA`);
  return data;
}

// ---------------------------------------------------------------------------
// Example 5: Get pool state
// ---------------------------------------------------------------------------

async function getPoolState() {
  const data = await apiCall<{
    total_liquidity_ada: number;
    active_coverage_ada: number;
    available_liquidity_ada: number;
    utilization_pct: number;
  }>('GET', '/api/pool');

  console.log('\n=== Pool State ===');
  console.log(`  Total liquidity:  ${data.total_liquidity_ada} ADA`);
  console.log(`  Active coverage:  ${data.active_coverage_ada} ADA`);
  console.log(`  Available:        ${data.available_liquidity_ada} ADA`);
  console.log(`  Utilization:      ${data.utilization_pct}%`);
  return data;
}

// ---------------------------------------------------------------------------
// Run all examples
// ---------------------------------------------------------------------------

async function main() {
  console.log('Aegis REST API Integration Examples\n');

  await getOraclePrice();
  await getPoolState();
  // The following require the API server and chain connection:
  // await previewPremium();
  // await createPolicy();
  // await protectLoan();

  console.log('\nAll examples completed.');
}

main().catch(console.error);

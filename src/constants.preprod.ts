// AUTO-GENERATED from release/preprod.json — do not edit.
// Source manifest: release_commit=34e215b567e23919eb4993b40aa3eee768c91191
// Network: preprod
// Compiler: v1.1.22+39d6b04
// Frozen at: 2026-06-17T22:30:00Z
//
// Regenerate via:
//   python scripts/sync_sdk_constants_from_manifest.py \
//       --manifest release/preprod.json --out sdk/src/constants.preprod.ts


export const AEGIS_NETWORK = 'preprod';
export const AEGIS_POOL_ADDRESS = 'addr_test1wp5p7udv5m7mdfep39hqjhg7z0ws0525552tt5was486dgsfkvwv8';
export const AEGIS_POOL_NFT_POLICY_ID = 'da986312812002c71c24a04156c61e65b7e38bb2f81322618eff2725';
export const AEGIS_POOL_NFT_ASSET_NAME = 'AEGIS_POOL_12H_V1';

// Applied script hashes (live on-chain).
export const AEGIS_POLICY_VALIDATOR_HASH = 'ff7469ffe5f3598289ce06c687942790d1a115e0c01d58ed3036ccc2';
export const AEGIS_POOL_VALIDATOR_HASH = '681f71aca6fdb6a721896e095d1e13dd07d154a514b5d1dd854fa6a2';
export const AEGIS_POLICY_MARKER_HASH = 'b89348874aeddf60dd300200de714c104bd546e39f8a0f96a78ced17';
export const AEGIS_LP_TOKEN_HASH = '732dcebec69abcd76a69863f9b0d31bc2745af3a6b8e6f3a6934ab3b';

// Reference UTxOs (empty when ref script not yet published).
export const AEGIS_POLICY_REF_TX = '3398d40d3b7ee10e5112fa453c99dd23c4f5cffbbb208586e6491c35152549c6';
export const AEGIS_POLICY_REF_IDX = 0;
export const AEGIS_POLICY_REF_UTXO = '3398d40d3b7ee10e5112fa453c99dd23c4f5cffbbb208586e6491c35152549c6#0';
export const AEGIS_POOL_REF_TX = '56d366b0ac7596edffe41300be174922284eb28ebb72144a120f8d146dc0e619';
export const AEGIS_POOL_REF_IDX = 0;
export const AEGIS_POOL_REF_UTXO = '56d366b0ac7596edffe41300be174922284eb28ebb72144a120f8d146dc0e619#0';
export const AEGIS_MARKER_REF_TX = 'a0b9348b7f6b7ab0956c5246f1f07431dd1252c21155846ae31f3d44c8b176f7';
export const AEGIS_MARKER_REF_IDX = 0;
export const AEGIS_MARKER_REF_UTXO = 'a0b9348b7f6b7ab0956c5246f1f07431dd1252c21155846ae31f3d44c8b176f7#0';
export const AEGIS_LP_REF_TX = '77b51f0f64bd9acfd047ff898a06c2699dba3b0b77ac47af97fb2cd2dde8490f';
export const AEGIS_LP_REF_IDX = 0;
export const AEGIS_LP_REF_UTXO = '77b51f0f64bd9acfd047ff898a06c2699dba3b0b77ac47af97fb2cd2dde8490f#0';

// Economic constants (BigInt-typed; matches on-chain types.ak).
export const AEGIS_TEAM_ADDRESS = 'addr_test1qrph8epfa8dg6wjwmls873g0xllyjnlt3hh08nv9kcrw9ln40ur83k9c87dpxuar3jucqrg0sc54zvzmf53pu6due2eqa5m8d2';
export const AEGIS_MIN_PREMIUM = 2000000n;
export const AEGIS_TREASURY_SHARE_BPS = 2500n;

// Publisher.
export const AEGIS_PUBLISHER_VKH = '6096332c3f9c18805fdb1d189b74d54497049ffb254659cd45622152';
export const AEGIS_PUBLISHER_CANONICAL_NFTS: readonly string[] = ['d2f08410f9f999b2afff902ec4ef47cc7b1677709887d20e0f13938f.', 'ae304e27806536dbbc222115c2b543e845f99bd8c7a3a01669f2d7bd.', 'd80aa1a72a46813b5045e163751076d54551fac4a6f8d720e15807ad.', '860faa663d8a3ae3071d61f95464340c0e49c1f47f56db76441df7a0.', 'a4093bfc7758b86ca1b96df842367bce96cb954650a392020246c0cb.', '7b53817a1cda197ca26883a25adb51631f3368094c721751ae9ceb23.', '6ee32803e472cbc636bf0d7073f1f54ad0f73b536c69b1f0d6771fe4.', '485eea6e0f21b6eac798088f9ca8a2aca5bd88efd6f176d9b9a2a53f.', '544ddf337bdbbe27962de6d62c6177043b3ef6d229ee2b641c480025.'] as const;

// Oracles.
export const AEGIS_CHARLI3_ADA_USD_NFT = '886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e.4f7261636c6546656564';
export const AEGIS_ORCFAX_FSP_HASH = '0690081bc113f74e04640ea78a87d88abbd2f18831c44c4064524230';

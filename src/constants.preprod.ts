// AUTO-GENERATED from release/preprod.json — do not edit.
// Source manifest: release_commit=7f9bc19c6d873554e6eefb08ac5730858e4079bd
// Network: preprod
// Compiler: v1.1.22+39d6b04
// Frozen at: 2026-06-13T01:00:45Z
//
// Regenerate via:
//   python scripts/sync_sdk_constants_from_manifest.py \
//       --manifest release/preprod.json --out sdk/src/constants.preprod.ts


export const AEGIS_NETWORK = 'preprod';
export const AEGIS_POOL_ADDRESS = 'addr_test1wr6harrzp9wzdcaknmzmsz02zq22zx4qdvuk5kjqyd0xgegwkary8';
export const AEGIS_POOL_NFT_POLICY_ID = '35c08c6208244791f313db85a7734523b1f7d9bb76891f565611fe94';
export const AEGIS_POOL_NFT_ASSET_NAME = 'AEGIS_POOL_SURF_V1';

// Applied script hashes (live on-chain).
export const AEGIS_POLICY_VALIDATOR_HASH = 'd14c087823266a6148b66d1cbe9416520e318526edae283af420eaa5';
export const AEGIS_POOL_VALIDATOR_HASH = 'f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465';
export const AEGIS_POLICY_MARKER_HASH = '15a06a6aac5032456333d426f5a37c0bc31a8038ac8148af1a09b1ed';
export const AEGIS_LP_TOKEN_HASH = '3d80317808446ace1e574d596cd94a3cd5f6e884a27066d6388c22a9';

// Reference UTxOs (empty when ref script not yet published).
export const AEGIS_POLICY_REF_TX = '0bd1f3980cafa5020635a04b3a4d9ff5526d4f1d14fcb6a41f727cc8bd62fc36';
export const AEGIS_POLICY_REF_IDX = 0;
export const AEGIS_POLICY_REF_UTXO = '0bd1f3980cafa5020635a04b3a4d9ff5526d4f1d14fcb6a41f727cc8bd62fc36#0';
export const AEGIS_POOL_REF_TX = 'd3826d870b354a85918052fedaa8691b1f871d1cc0a5d591716fabf11fb009d0';
export const AEGIS_POOL_REF_IDX = 0;
export const AEGIS_POOL_REF_UTXO = 'd3826d870b354a85918052fedaa8691b1f871d1cc0a5d591716fabf11fb009d0#0';
export const AEGIS_MARKER_REF_TX = '5cf8891c17c790aa3b0d6e44cce205748220e83ef19187b7faf6d8204d13a267';
export const AEGIS_MARKER_REF_IDX = 0;
export const AEGIS_MARKER_REF_UTXO = '5cf8891c17c790aa3b0d6e44cce205748220e83ef19187b7faf6d8204d13a267#0';
export const AEGIS_LP_REF_TX = '9d7db8b03fc1fd95a9591c6fa8adfda5eeb111818d3cc4aaf4faf67702edea10';
export const AEGIS_LP_REF_IDX = 0;
export const AEGIS_LP_REF_UTXO = '9d7db8b03fc1fd95a9591c6fa8adfda5eeb111818d3cc4aaf4faf67702edea10#0';

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

// AUTO-GENERATED from release/preprod.json — do not edit.
// Source manifest: release_commit=7097ee152bc1a1e588ce6b6e4642ff289b4463e4
// Network: preprod
// Compiler: v1.1.22+39d6b04
// Frozen at: 2026-06-24T01:38:05Z
//
// Regenerate via:
//   python scripts/sync_sdk_constants_from_manifest.py \
//       --manifest release/preprod.json --out sdk/src/constants.preprod.ts


export const AEGIS_NETWORK = 'preprod';
export const AEGIS_POOL_ADDRESS = 'addr_test1wr2llz43u5yml0dpdwplufaw334a9khudnzjxg4cugelxest0ypjn';
export const AEGIS_POOL_NFT_POLICY_ID = '2b8d7869526eb5af6b7e7ff08c55b345f16e6eca9079e3f429325a05';
export const AEGIS_POOL_NFT_ASSET_NAME = 'AEGIS_POOL_V4';

// Applied script hashes (live on-chain).
export const AEGIS_POLICY_VALIDATOR_HASH = '9385ef135c98d3c0b2bf97899092af88a6054b7e48cf98001af0105a';
export const AEGIS_POOL_VALIDATOR_HASH = 'd5ff8ab1e509bfbda16b83fe27ae8c6bd2dafc6cc52322b8e233f366';
export const AEGIS_POLICY_MARKER_HASH = '9b62c8820f1d52e88792f5e171b58587d5ffd75ae5fc0304a8ff56e3';
export const AEGIS_LP_TOKEN_HASH = 'adf71eb2a4f4c8181e65cdacc7f3ad6299b2bc896d69192e12b8a16d';

// Reference UTxOs (empty when ref script not yet published).
export const AEGIS_POLICY_REF_TX = 'f7fa21385a1f56b4083a6b3e955ec8a89ec66f5300eae851d528161a5729b95c';
export const AEGIS_POLICY_REF_IDX = 0;
export const AEGIS_POLICY_REF_UTXO = 'f7fa21385a1f56b4083a6b3e955ec8a89ec66f5300eae851d528161a5729b95c#0';
export const AEGIS_POOL_REF_TX = '07752a5bbf09847505174b8fb938e08a5df353f94de3623a79dd5810fc47b24d';
export const AEGIS_POOL_REF_IDX = 0;
export const AEGIS_POOL_REF_UTXO = '07752a5bbf09847505174b8fb938e08a5df353f94de3623a79dd5810fc47b24d#0';
export const AEGIS_MARKER_REF_TX = 'd9fba00cd00c8d7e7007238b5413b4ce2f69494356cc2fb2473c8948df239e16';
export const AEGIS_MARKER_REF_IDX = 0;
export const AEGIS_MARKER_REF_UTXO = 'd9fba00cd00c8d7e7007238b5413b4ce2f69494356cc2fb2473c8948df239e16#0';
export const AEGIS_LP_REF_TX = '2ff3e3b89ec2f3ee7afeeecf75d5850295234ea0136539000ecb1bcee84a8691';
export const AEGIS_LP_REF_IDX = 0;
export const AEGIS_LP_REF_UTXO = '2ff3e3b89ec2f3ee7afeeecf75d5850295234ea0136539000ecb1bcee84a8691#0';

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

// AUTO-GENERATED from release/mainnet.json — do not edit.
// Source manifest: release_commit=45206a8b5bba90f1ceaf899d29e78e4b5a8847a7
// Network: mainnet
// Compiler: v1.1.22+39d6b04
// Frozen at: 2026-07-08T02:59:32Z
//
// Regenerate via:
//   python scripts/sync_sdk_constants_from_manifest.py \
//       --manifest release/mainnet.json --out sdk/src/constants.mainnet.ts


export const AEGIS_NETWORK = 'mainnet';
export const AEGIS_POOL_ADDRESS = 'addr1w9926sf0nqczu6494fwz00cq8jlzqds6kfm0h2geh7kd2qs70dmj2';
export const AEGIS_POOL_NFT_POLICY_ID = 'a48f89cf5a52226a2f8226b1af033507594ded136031575a3b028154';
export const AEGIS_POOL_NFT_ASSET_NAME = 'AEGIS_POOL_V7';

// Applied script hashes (live on-chain).
export const AEGIS_POLICY_VALIDATOR_HASH = 'ccd5f3330fe223c12131543e93fa10b5e6e4acb334e454efd25331b3';
export const AEGIS_POOL_VALIDATOR_HASH = '4aad412f98302e6aa5aa5c27bf003cbe20361ab276fba919bfacd502';
export const AEGIS_POLICY_MARKER_HASH = 'f3247570b5bb33abadfbba2fc6e9b9d4918194b9b4146debcf88ab3e';
export const AEGIS_LP_TOKEN_HASH = '80c13796e6933eeb7322b095f6453be1dcd10caded381af949754b08';

// Reference UTxOs (empty when ref script not yet published).
export const AEGIS_POLICY_REF_TX = 'd27c1dcab43bbffd91941fb87280711f800362483bc0f3560a336cb9801d8d92';
export const AEGIS_POLICY_REF_IDX = 0;
export const AEGIS_POLICY_REF_UTXO = 'd27c1dcab43bbffd91941fb87280711f800362483bc0f3560a336cb9801d8d92#0';
export const AEGIS_POOL_REF_TX = 'fff6be5a24fe27198ae3646335367d29a4d6e480b842939bbc3d66d66d56b34e';
export const AEGIS_POOL_REF_IDX = 0;
export const AEGIS_POOL_REF_UTXO = 'fff6be5a24fe27198ae3646335367d29a4d6e480b842939bbc3d66d66d56b34e#0';
export const AEGIS_MARKER_REF_TX = '539a186e872766ba7ead19f445b7a2e118b87ff2c3c977b8facdda46dde9092b';
export const AEGIS_MARKER_REF_IDX = 0;
export const AEGIS_MARKER_REF_UTXO = '539a186e872766ba7ead19f445b7a2e118b87ff2c3c977b8facdda46dde9092b#0';
export const AEGIS_LP_REF_TX = '3fb3d78475938273485999b8d4c58d630ef75f4599d47047887c7ca9216f78fd';
export const AEGIS_LP_REF_IDX = 0;
export const AEGIS_LP_REF_UTXO = '3fb3d78475938273485999b8d4c58d630ef75f4599d47047887c7ca9216f78fd#0';

// Economic constants (BigInt-typed; matches on-chain types.ak).
export const AEGIS_TEAM_ADDRESS = 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3';
export const AEGIS_MIN_PREMIUM = 20000000n;
export const AEGIS_TREASURY_SHARE_BPS = 2500n;

// Publisher.
export const AEGIS_PUBLISHER_VKH = 'bb09f43245759995440388db9ef3f8a614246e8da1dd9bd053261347';
export const AEGIS_PUBLISHER_CANONICAL_NFTS: readonly string[] = ['f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301.', '99e8fe4f9d2a4a85f5e3f20d37b10048ce54e4a03e56d9fd492163b3.', 'a8c5354a4813f2b3f60836839b8842a9422186f4f15511790ec95f9c.', 'a8231f0c10b514659fd590f6ee7420acf4e145cce36909a7f5fe1c5e.', '82a324a3de0be7bc9c4b8450db5350cf0479fa1393eb8eee2481c652.', 'f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02.', 'c2f62874c860e1fc87bae0043066e551153f30fcc5d9944a370e8f8d.', 'f4e78f3636248838c2d5c6578062cfb78f385482b0078de7aff5cc3b.', '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f.', '47c16934540cdead6045f947b1a7fd4b910bc0352a269b11800d0bed.', 'b99998ba0353f47137fb9499da624b63a855d60719d4902777312439.'] as const;

// Oracles.
export const AEGIS_CHARLI3_ADA_USD_NFT = '08c56c0fa73748a23c3bc1d9e6a60a4187416fc4ff8fe3475506990e.4f7261636c6546656564';
export const AEGIS_ORCFAX_FSP_HASH = '8793893b5dda6a513ba63c80e9d7b2d4f108060c11979bfc7d863ff0';

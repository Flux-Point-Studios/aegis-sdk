// AUTO-GENERATED from release/mainnet.json — do not edit.
// Source manifest: release_commit=9f4bfd6ee1cdf596644f14ae589db8d1711784ec
// Network: mainnet
// Compiler: v1.1.22+39d6b04
// Frozen at: 2026-06-15T02:35:36Z
//
// Regenerate via:
//   python scripts/sync_sdk_constants_from_manifest.py \
//       --manifest release/mainnet.json --out sdk/src/constants.mainnet.ts


export const AEGIS_NETWORK = 'mainnet';
export const AEGIS_POOL_ADDRESS = 'addr1w8qgahrl6xcg96fvj756a08k8fj8dz8vszf9s9jx6mlkvlclvfgtr';
export const AEGIS_POOL_NFT_POLICY_ID = '9a649b75a85f0088eb68c1b72c3529b41f874fcdc603031a1444abb3';
export const AEGIS_POOL_NFT_ASSET_NAME = 'AEGIS_POOL_V4';

// Applied script hashes (live on-chain).
export const AEGIS_POLICY_VALIDATOR_HASH = '1677dc4a0089047ee3136ca7bea0f36e49d6707468809f4f7d46dfb7';
export const AEGIS_POOL_VALIDATOR_HASH = 'c08edc7fd1b082e92c97a9aebcf63a647688ec8092581646d6ff667f';
export const AEGIS_POLICY_MARKER_HASH = 'd9d24db4e4dabdc1af6a568a4ecd691b81fae891afd70eb6cabc51e7';
export const AEGIS_LP_TOKEN_HASH = '5cb64f303517777710d28db50ad3be4bb9feda5f66d0fbffa68e212b';

// Reference UTxOs (empty when ref script not yet published).
export const AEGIS_POLICY_REF_TX = '3a96a5b3cedeeb3f2cdf6a89ebba0db73057b642c0b1fdfee54cdf3bd4f740cb';
export const AEGIS_POLICY_REF_IDX = 0;
export const AEGIS_POLICY_REF_UTXO = '3a96a5b3cedeeb3f2cdf6a89ebba0db73057b642c0b1fdfee54cdf3bd4f740cb#0';
export const AEGIS_POOL_REF_TX = '59a77925ad095c8a3a751c77d491f78adb3d1bd45068e66ba30a75e794988d2c';
export const AEGIS_POOL_REF_IDX = 0;
export const AEGIS_POOL_REF_UTXO = '59a77925ad095c8a3a751c77d491f78adb3d1bd45068e66ba30a75e794988d2c#0';
export const AEGIS_MARKER_REF_TX = 'b1243ac8169380b5cf994f55d48e835da2d6ec378cedea988f26f7547b7ed582';
export const AEGIS_MARKER_REF_IDX = 0;
export const AEGIS_MARKER_REF_UTXO = 'b1243ac8169380b5cf994f55d48e835da2d6ec378cedea988f26f7547b7ed582#0';
export const AEGIS_LP_REF_TX = '818da8a418ffbef81983f5aeb22fcebf1bff48995e2c52005ef0769e1c09083c';
export const AEGIS_LP_REF_IDX = 0;
export const AEGIS_LP_REF_UTXO = '818da8a418ffbef81983f5aeb22fcebf1bff48995e2c52005ef0769e1c09083c#0';

// Economic constants (BigInt-typed; matches on-chain types.ak).
export const AEGIS_TEAM_ADDRESS = 'addr1q9s6m9d8yedfcf53yhq5j5zsg0s58wpzamwexrxpfelgz2wgk0s9l9fqc93tyc8zu4z7hp9dlska2kew9trdg8nscjcq3sk5s3';
export const AEGIS_MIN_PREMIUM = 20000000n;
export const AEGIS_TREASURY_SHARE_BPS = 2500n;

// Publisher.
export const AEGIS_PUBLISHER_VKH = 'bb09f43245759995440388db9ef3f8a614246e8da1dd9bd053261347';
export const AEGIS_PUBLISHER_CANONICAL_NFTS: readonly string[] = ['f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301.', '99e8fe4f9d2a4a85f5e3f20d37b10048ce54e4a03e56d9fd492163b3.', 'a8c5354a4813f2b3f60836839b8842a9422186f4f15511790ec95f9c.', 'a8231f0c10b514659fd590f6ee7420acf4e145cce36909a7f5fe1c5e.', '82a324a3de0be7bc9c4b8450db5350cf0479fa1393eb8eee2481c652.', 'f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02.', 'c2f62874c860e1fc87bae0043066e551153f30fcc5d9944a370e8f8d.', 'f4e78f3636248838c2d5c6578062cfb78f385482b0078de7aff5cc3b.', '68a1b0c1dab38159e9aae015c2c577a8da3661f921410dbad6276b2f.', '47c16934540cdead6045f947b1a7fd4b910bc0352a269b11800d0bed.'] as const;

// Oracles.
export const AEGIS_CHARLI3_ADA_USD_NFT = '08c56c0fa73748a23c3bc1d9e6a60a4187416fc4ff8fe3475506990e.4f7261636c6546656564';
export const AEGIS_ORCFAX_FSP_HASH = '8793893b5dda6a513ba63c80e9d7b2d4f108060c11979bfc7d863ff0';

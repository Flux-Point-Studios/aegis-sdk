// The SDK's Node entry: what reads the local disk or the process, kept out of the main
// entry so a browser bundle never sees it.

export { walletDirSigner, openWalletDir } from './wallet_dir';
export type { Cip30Signer, WalletDir } from './wallet_dir';

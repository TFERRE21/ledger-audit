# First scan

The scanner uses standard Ethereum JSON-RPC read methods such as `eth_blockNumber` and `eth_getBlockByNumber` to inspect public chain data. citeturn0search0

If FROM_BLOCK and TO_BLOCK are both 0, the scanner automatically reads the current block height and inspects only the latest five blocks.

For a production scan, configure a real RPC endpoint and use bounded ranges. No signing, private keys or transaction broadcasting are used.

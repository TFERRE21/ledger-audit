# First scan

This scanner is read-only.

## Configuration

Copy .env.example to .env and provide:

- RPC_URL
- CHAIN
- FROM_BLOCK
- TO_BLOCK

Use a small block range during development.

Example concept:

FROM_BLOCK=latest_known_block
TO_BLOCK=latest_known_block_plus_small_range

The scanner only reads public RPC data and does not sign or broadcast transactions.

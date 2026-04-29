# NEAR Testnet Deploy

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single action.

## Description

This action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results back to your workflow.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `faucet-amount` | No | `100` | Amount of NEAR to request from faucet |
| `smoke-test-method` | No | — | Contract method to call as smoke test |
| `smoke-test-args` | No | `{}` | JSON arguments for the smoke test method |
| `network` | No | `testnet` | NEAR network RPC endpoint to target |

## Outputs

| Name | Description |
|------|-------------|
| `account-id` | The testnet account used for deployment |
| `transaction-hash` | Transaction hash of the deploy call |
| `contract-balance` | Account balance after faucet funding |
| `smoke-test-result` | Output returned by the smoke test method |
| `deploy-status` | Final status: `success` or `failure` |

## Usage

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build contract
        run: cargo build --target wasm32-unknown-unknown --release

      - name: Deploy to NEAR Testnet
        uses: your-org/near-testnet-deploy@v1
        with:
          account-id: myapp.testnet
          contract-path: target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_PRIVATE_KEY }}
          smoke-test-method: get_status
          smoke-test-args: '{"account_id": "myapp.testnet"}'

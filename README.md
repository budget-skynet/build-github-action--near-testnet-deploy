# NEAR Testnet Deploy

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single step.

## Description

This action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports results back to your workflow.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `faucet-amount` | No | `10` | Amount of NEAR tokens to request from faucet |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call after deploy |
| `network` | No | `testnet` | NEAR network RPC target |

## Outputs

| Name | Description |
|------|-------------|
| `account-id` | The testnet account used for deployment |
| `transaction-hash` | Transaction hash of the deploy call |
| `contract-balance` | Account balance after faucet funding |
| `smoke-test-results` | JSON string containing smoke test outcomes |
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
          account-id: mycontract.testnet
          contract-path: target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_TESTNET_PRIVATE_KEY }}
          smoke-test-methods: get_status,get_owner
        id: deploy

      - name: Print results
        run: echo "${{ steps.deploy.outputs.smoke-test-results }}"

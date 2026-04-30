# NEAR Testnet Deploy

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single GitHub Action step.

## Description

This action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results back to your workflow.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call |
| `faucet-url` | No | `https://helper.testnet.near.org` | Custom faucet endpoint URL |

## Outputs

| Output | Description |
|--------|-------------|
| `account-id` | The testnet account ID used for deployment |
| `contract-hash` | SHA256 hash of the deployed contract |
| `deployment-tx` | Transaction hash of the deployment |
| `smoke-test-status` | Result of smoke tests: `passed`, `failed`, or `skipped` |
| `account-balance` | Remaining account balance after deployment in NEAR |

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
          private-key: ${{ secrets.NEAR_TESTNET_PRIVATE_KEY }}
          run-smoke-tests: true
          smoke-test-methods: get_status,get_owner

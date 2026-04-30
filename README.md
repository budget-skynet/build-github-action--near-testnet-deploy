# NEAR Testnet Deploy Action

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single step.

## Description

This action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results back to your workflow.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `faucet-amount` | No | `200` | Amount of NEAR tokens to request from faucet |
| `network` | No | `testnet` | Target NEAR network |

## Outputs

| Output | Description |
|--------|-------------|
| `contract-address` | Deployed contract account ID |
| `transaction-hash` | Deployment transaction hash |
| `smoke-test-status` | Result of smoke tests (`passed` or `failed`) |
| `account-balance` | Account balance after faucet funding |

## Usage

name: Deploy to Testnet

on:
  push:
    branches:
      - develop

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
          contract-path: ./target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_TESTNET_PRIVATE_KEY }}
          run-smoke-tests: true
          faucet-amount: 200

## License

MIT
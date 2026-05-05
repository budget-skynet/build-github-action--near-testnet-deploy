# NEAR Testnet Deploy

GitHub Action for deploying smart contracts to NEAR testnet with automatic account creation, faucet funding, and smoke test execution.

## Description

Handles the complete NEAR testnet deployment workflow in a single step. Automatically creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports results.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID (e.g. `myapp.testnet`) |
| `contract-path` | Yes | — | Path to compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the deploying account |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `faucet-amount` | No | `100` | Amount of NEAR to request from faucet (in NEAR) |
| `network` | No | `testnet` | Target NEAR network |

## Outputs

| Name | Description |
|------|-------------|
| `account-id` | The testnet account used for deployment |
| `contract-hash` | SHA256 hash of the deployed contract |
| `transaction-id` | Deployment transaction ID |
| `smoke-test-status` | Result of smoke tests (`passed` or `failed`) |
| `explorer-url` | Link to the transaction on NEAR Explorer |

## Usage

name: Deploy to Testnet

on:
  push:
    branches:
      - main

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
          contract-path: ./target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_PRIVATE_KEY }}
          run-smoke-tests: true

## License

MIT
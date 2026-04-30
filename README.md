# NEAR Testnet Deploy

GitHub Action for deploying smart contracts to NEAR testnet with automatic account creation, faucet funding, and smoke test execution.

## Description

Handles the complete NEAR testnet deployment workflow in a single step. Automatically creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `master-key` | Yes | — | NEAR master account private key (store as secret) |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call as smoke tests |
| `gas` | No | `100000000000000` | Gas limit for deployment transaction |

## Outputs

| Name | Description |
|------|-------------|
| `account-id` | The testnet account ID used for deployment |
| `contract-hash` | Hash of the deployed contract |
| `transaction-id` | Deployment transaction ID |
| `faucet-funded` | Whether faucet funding was requested |
| `smoke-tests-passed` | Whether all smoke tests passed |

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
          account-id: mycontract.testnet
          contract-path: ./target/wasm32-unknown-unknown/release/contract.wasm
          master-key: ${{ secrets.NEAR_MASTER_KEY }}
          run-smoke-tests: true
          smoke-test-methods: get_status,get_owner

## License

MIT
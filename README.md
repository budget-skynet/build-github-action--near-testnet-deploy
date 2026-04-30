# NEAR Testnet Deploy Action

Automate your NEAR smart contract testnet deployments with automatic account creation, faucet funding, and smoke test execution in a single workflow step.

## Description

This GitHub Action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your compiled contract, runs basic smoke tests, and reports the results back to your workflow.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-wasm` | Yes | — | Path to the compiled `.wasm` contract file |
| `master-account` | No | `testnet` | Master account used for sub-account creation |
| `smoke-test-methods` | No | `""` | Comma-separated list of view methods to call after deploy |
| `faucet-amount` | No | `200` | Amount of NEAR tokens to request from faucet |
| `fail-on-smoke-test` | No | `true` | Fail the workflow if any smoke test returns an error |

## Outputs

| Output | Description |
|--------|-------------|
| `account-id` | The testnet account ID that was deployed to |
| `transaction-hash` | Deployment transaction hash |
| `account-created` | Whether a new account was created (`true` or `false`) |
| `smoke-test-results` | JSON string containing results of each smoke test method |

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
          contract-wasm: target/wasm32-unknown-unknown/release/contract.wasm
          smoke-test-methods: get_status,get_owner
          faucet-amount: 200

## License

MIT
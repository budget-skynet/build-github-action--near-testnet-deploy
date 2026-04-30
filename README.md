# NEAR Testnet Deploy

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single step.

## Description

This action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports results — all without manual setup.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the deployment account |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call |
| `faucet-amount` | No | `200` | Amount of NEAR tokens to request from faucet |

## Outputs

| Name | Description |
|------|-------------|
| `contract-address` | Deployed contract account ID |
| `transaction-hash` | Hash of the deployment transaction |
| `account-created` | Whether a new account was created (`true` or `false`) |
| `smoke-tests-passed` | Whether all smoke tests passed (`true` or `false`) |
| `explorer-url` | NEAR Explorer link to the deployment transaction |

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
          run-smoke-tests: true
          smoke-test-methods: get_status,get_owner

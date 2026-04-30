# NEAR Testnet Deploy

GitHub Action for deploying smart contracts to NEAR testnet with automatic account creation, faucet funding, and smoke test execution.

## Description

Handles the complete NEAR testnet deployment workflow in a single step. Automatically creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports results back to your workflow.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID (e.g. `myapp.testnet`) |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `run-smoke-tests` | No | `true` | Execute basic smoke tests after deploy |
| `network` | No | `testnet` | NEAR network RPC endpoint alias |

## Outputs

| Output | Description |
|--------|-------------|
| `account-id` | The testnet account used for deployment |
| `contract-hash` | SHA256 hash of the deployed contract |
| `faucet-funded` | `true` if faucet funding was requested |
| `smoke-tests-passed` | `true` if all smoke tests passed |
| `deploy-tx-id` | Transaction ID of the deployment |

## Usage

jobs:
  deploy-testnet:
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

## Notes

- Faucet funding is skipped if the account balance exceeds 10 NEAR
- Smoke tests call `version` and `status` view methods by default
- Store `private-key` as an encrypted repository secret
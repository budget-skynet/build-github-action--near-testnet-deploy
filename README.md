# NEAR Testnet Deploy Action

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single workflow step.

## Description

This action handles the complete NEAR testnet deployment lifecycle. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `faucet-amount` | No | `100` | Amount of NEAR tokens to request from faucet |

## Outputs

| Output | Description |
|--------|-------------|
| `contract-address` | Full account ID where the contract was deployed |
| `transaction-hash` | Deployment transaction hash |
| `smoke-test-result` | Pass or fail status of smoke tests |
| `account-created` | Whether a new testnet account was created |

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
          contract-path: ./target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_PRIVATE_KEY }}
          run-smoke-tests: true

## Notes

- Account IDs must end with `.testnet`
- Store your private key in GitHub Actions secrets
- Faucet funding is only requested when account balance is below the threshold
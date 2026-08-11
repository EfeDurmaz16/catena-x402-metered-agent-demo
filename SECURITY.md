# Security

This demo is testnet only: it pays Base Sepolia USDC from a sandbox Catena
account. Never point it at a mainnet account or put a mainnet key on the
machine that runs it.

Secrets live in the Catena CLI profile, never in this repo. `.env` holds an
account id and a profile name, nothing signable, and it is gitignored.

Report a vulnerability by opening a private security advisory on
[the repository](https://github.com/EfeDurmaz16/catena-x402-metered-agent-demo/security/advisories).

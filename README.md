# Solana Rent Reclaim (CLI)

Close every empty token account in a Solana wallet and get back the SOL locked in each one for rent. One small Node.js script, no build step.

> Prefer a web app? **[Solstack Rent Reclaim](https://solstack.xyz/tools/reclaim-solana-rent)** does this from any wallet, and also burns dust tokens and NFTs so their accounts can be closed too. For many wallets at once: [Wallet Cleaner](https://solstack.xyz/tools/solana-wallet-cleaner). Guide: [How to reclaim Solana rent](https://solstack.xyz/docs/reclaim-solana-rent).

## Why there's SOL to reclaim

Every token a wallet has ever held gets its own token account, and each account holds a rent deposit (about 0.0015 SOL for an SPL Token account, a little more on Token-2022). Selling or sending away the last token leaves the account open and the deposit locked. Closing it sends the deposit back to you. Wallets that trade memecoins often have hundreds of these. More on how rent works: [Solana rent explained](https://solstack.xyz/blog/solana-rent-explained).

## What it does

- Finds every empty account in both token programs (**SPL Token** and **Token-2022**), including empty wrapped-SOL accounts.
- Closes up to 27 per transaction and sends the rent to your wallet, or to `--to <address>`.
- Handles Token-2022 accounts that still hold **withheld transfer fees**: it moves those fees to their mint in the same transaction (anyone is allowed to), then closes the account.
- Skips accounts it can't close and says why: frozen accounts, accounts whose close authority is someone else, confidential-transfer accounts. If one account in a batch fails for any other reason, the batch is retried one account at a time so the rest still close.
- **Dry run by default.** Nothing is signed until you add `--send`.
- Never touches accounts that still hold tokens.

## Quick start

Needs [Node.js](https://nodejs.org) 18.11 or newer and the wallet's keypair file (the [Solana CLI](https://solana.com/docs/intro/installation) one at `~/.config/solana/id.json` is used by default).

```sh
git clone https://github.com/solstackxyz/solana-rent-reclaim.git
cd solana-rent-reclaim
npm install

# see what can be closed on mainnet, sends nothing
node reclaim.mjs --cluster mainnet-beta --keypair ~/my-wallet.json

# close them
node reclaim.mjs --cluster mainnet-beta --keypair ~/my-wallet.json --send
```

## Options

| Option | What it does |
|---|---|
| `--keypair <path>` | Wallet keypair file (default `~/.config/solana/id.json`) |
| `--to <address>` | Where the reclaimed SOL goes (default: the wallet itself) |
| `--cluster <name>` | `devnet` (default), `mainnet-beta` or `testnet` |
| `--rpc <url>` | Your own RPC endpoint; overrides `--cluster` |
| `--priority-fee <n>` | Priority fee in micro-lamports per compute unit (default 0) |
| `--send` | Close the accounts. Without it, nothing is sent |
| `--yes` | Skip the "type yes" prompt on mainnet |

## Example

A real devnet run:

```text
$ node reclaim.mjs --keypair a.json --send --priority-fee 1000

Network          devnet (https://api.devnet.solana.com)
Wallet           79o36ZBByMEF12iX7c1EQ1C2Jw7bQbDzVNLoW2fEzgvs
Empty accounts   2 can be closed, 0.00297688 SOL of rent back
Transactions     1 (network fees 0.000005 SOL plus priority fees)
Still holding    1 token account with a balance; send or burn the tokens first to close it

[1/1] closed 2  XXVteY92GUjnQBjirf89GjMeuKCLszb4xu5Eu2mRrBTr443mzzf88anPFYQpSG7wfEofehuiQgCYK3KpmpDEFVP

Done: 2 accounts closed, 0.00297688 SOL back to 79o36ZBByMEF12iX7c1EQ1C2Jw7bQbDzVNLoW2fEzgvs.
```

## Costs

0.000005 SOL network fee per transaction (each closes up to 27 accounts), plus any priority fee you set. The script itself is free.

## Accounts with tokens still in them

This script only closes empty accounts. To close accounts that hold dust or worthless tokens, send or burn the tokens first: the web [Rent Reclaim](https://solstack.xyz/tools/reclaim-solana-rent) burns and closes in one step, and [Token Burner](https://solstack.xyz/tools/burn-solana-tokens) burns a single token.

## More Solana tools

This script comes from [Solstack](https://solstack.xyz), a set of web tools for Solana tokens: [Wallet Cleaner](https://solstack.xyz/tools/solana-wallet-cleaner), [Multisender](https://solstack.xyz/tools/solana-multisender), [Token Inspector](https://solstack.xyz/tools/solana-token-inspector) and [more](https://solstack.xyz/tools).

Other scripts: [solana-multisender](https://github.com/solstackxyz/solana-multisender) · [solana-holder-snapshot](https://github.com/solstackxyz/solana-holder-snapshot)

## License

MIT

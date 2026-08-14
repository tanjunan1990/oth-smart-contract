# hedera-deploy

Deploy a compiled smart contract to the Hedera Testnet via the Hedera JS SDK, and call it from the command line.

## Setup

Requires a `.env` file (not committed) with:

```
HEDERA_OPERATOR_ID=0.0.12345
HEDERA_OPERATOR_KEY=<ECDSA or ED25519 private key, hex or DER>
```
## Build
```
solc --bin --abi voting.sol -o build --overwrite
```

## Deploying

```
node deploy.js Ballot.bin [--gas 200000] [--memo "..."] [constructor args...]
```

Constructor args (comma-separated, no spaces, unless quoted per item):

| Flag                     | Type          |
| ------------------------ | ------------- |
| `--arg-string V`         | `string`      |
| `--arg-address 0.0.x\|0x..` | `address`  |
| `--arg-uint256 N`        | `uint256`     |
| `--arg-bool true\|false` | `bool`        |
| `--arg-string-array a,b,c`         | `string[]`  |
| `--arg-address-array 0.0.x,0x..`   | `address[]` |
| `--arg-uint256-array 1,2,3`        | `uint256[]` |

Example — generate a voting window, then deploy the `Voting` contract with it:

```
node -e "const n=Math.floor(Date.now()/1000); console.log('start', n+600, 'end', n+86400)"

node deploy.js ./build/Ballot.bin \
  --arg-string-array "Pizza,Sushi,Tacos" \
  --arg-address-array "" \
  --arg-uint256 <start> \
  --arg-uint256 <end> \
  --gas 3000000
```

## Calling a function

Pass it on the command line — no file editing needed:

```
node call.js --list                       # show every function in the ABI
node call.js state                        # which phase are we in?
node call.js results                      # the vote totals
node call.js vote 0                       # vote for topic 0
node call.js blockAccounts 0xaaa,0xbbb    # block accounts (admin, Setup only)
node call.js isBlocked 0xaaa              # is this account blocked?
node call.js hasVoted 0.0.12345           # 0.0.x ids are converted for you
node call.js admin                        # who deployed it
node call.js votingStart                  # shown as a timestamp AND a date
node call.js votingEnd
```

Argument types, query-vs-execute, and the return type are all read from `build/Voting.abi`, so there is nothing to configure. Array arguments are comma-separated with no spaces.

Options:

| Flag              | Effect                        |
| ------------------ | ------------------------------ |
| `--contract 0.0.x` | call a different contract      |
| `--gas N`          | override the gas limit         |
| `--abi PATH`       | use a different ABI file       |
| `--query`/`--execute` | force the mode              |

### Config-block equivalents

If you'd rather edit `call.js` directly instead of using CLI args, here's how each command maps to the config block:

| What you want                 | MODE      | METHOD_NAME      | buildParams()                          | RETURN_TYPE |
| ------------------------------ | --------- | ----------------- | --------------------------------------- | ----------- |
| Cast a vote                    | `execute` | `vote`             | `params.addUint256(0)` (topic index)    | `null`      |
| Block accounts (admin, Setup)  | `execute` | `blockAccounts`    | `params.addAddressArray(["0x..."])`     | `null`      |
| Which phase?                   | `query`   | `state`            | (empty)                                 | `uint8`     |
| Is X blocked?                  | `query`   | `isBlocked`        | `params.addAddress("0x...")`            | `bool`      |
| Did X vote?                    | `query`   | `hasVoted`         | `params.addAddress("0x...")`            | `bool`      |
| Who is admin?                  | `query`   | `admin`            | (empty)                                 | `address`   |
| When does it open?             | `query`   | `votingStart`      | (empty)                                 | `uint256`   |
| When does it close?            | `query`   | `votingEnd`        | (empty)                                 | `uint256`   |
| The vote totals                | `query`   | `results`          | (empty)                                 | see below   |

`state()` returns a number: `0 = Setup`, `1 = Voting`, `2 = Closed`.

### Reading `results()`

`results()` returns `(string name, uint256 voteCount)[]` — an array of structs. `call.js` decodes a single scalar only, so it cannot print this one. Three ways to read it instead:

1. **HashScan** — open the contract and use the read tab:
   `https://hashscan.io/testnet/contract/<CONTRACT_ID>`

2. **Mirror node**, free, no account needed:

   ```
   curl -X POST "https://testnet.mirrornode.hedera.com/api/v1/contracts/call" \
     -H "Content-Type: application/json" \
     -d '{"block":"latest","data":"0xa48bdb7c","to":"<contract EVM address>"}'
   ```

   `0xa48bdb7c` is the selector for `results()`. The reply is ABI-encoded hex; decode it with ethers:

   ```js
   ethers.AbiCoder.defaultAbiCoder().decode(
     ["tuple(string,uint256)[]"],
     "<hex from the response>"
   );
   ```

3. Read the totals one at a time from the `VoteCast` events on HashScan.

## Testing

`test/run-tests.js` deploys its own short-lived `Ballot` instance (a ~90-second
voting window) and drives it through every state and security rule using
several throwaway Testnet accounts — so it doesn't touch your real deployment
or wait 24 hours for a voting window to close.

```
node test/create-accounts.js   # one-time: creates & funds 5 test accounts
node test/run-tests.js         # deploys a test contract and runs the suite
```

It covers: one-vote-per-account, blocklist via the constructor arg *and* via
`blockAccounts()`, admin-only + Setup-only enforcement on `blockAccounts()`,
rejection outside the voting window, an invalid topic index, and `results()`
tallying correctly. Each check prints PASS/FAIL; a summary and a HashScan
link for the test contract are printed at the end.

## Voting as a different account

`call.js` reads one account from `.env`. To act as somebody else, swap the file:

```
cp .env .env.backup
cp .env.voter2 .env       # or wherever the other account's credentials live
node call.js
mv .env.backup .env       # restore afterwards — easy to forget
```

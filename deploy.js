/**
 * Deploy a compiled smart contract to the Hedera Testnet.
 *
 * Usage:
 *   node deploy.js <artifact-or-bin-file> [--gas 200000] [--memo "..."] [ABI-encoded constructor args...]
 *
 * Examples:
 *   node deploy.js ./artifacts/MyContract.json
 *   node deploy.js ./build/MyContract.bin --gas 300000
 *   node deploy.js ./artifacts/MyToken.json --arg-string "MyToken" --arg-string "MTK" --arg-uint256 1000000
 *   node deploy.js ./build/Voting.bin --arg-string-array "Pizza,Sushi,Tacos"
 *
 * Array args (comma-separated, no spaces around commas unless quoted per-item):
 *   --arg-string-array "a,b,c"        -> string[]
 *   --arg-address-array "0.0.1,0.0.2" -> address[] (Hedera ids or 0x hex, mixed is fine)
 *   --arg-uint256-array "1,2,3"       -> uint256[]
 *
 * Requires a .env file (see .env.example) with:
 *   HEDERA_OPERATOR_ID   e.g. 0.0.12345
 *   HEDERA_OPERATOR_KEY  ECDSA or ED25519 private key (hex or DER)
 */

import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  ContractCreateFlow,
  ContractFunctionParameters,
  Hbar,
} from "@hashgraph/sdk";

/* ------------------------------------------------------------------ */
/* 1. Read the compiled bytecode                                       */
/* ------------------------------------------------------------------ */

/**
 * Accepts either:
 *   - a raw .bin file containing the hex bytecode, or
 *   - a compiler artifact JSON (Hardhat / Foundry / solc) that carries the
 *     bytecode under one of the common field names.
 */
function loadBytecode(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();

  // Raw .bin / .hex file: just the bytecode string.
  if (filePath.endsWith(".bin") || filePath.endsWith(".hex")) {
    return normalizeHex(raw);
  }

  // JSON artifact from solc / Hardhat / Foundry.
  const artifact = JSON.parse(raw);

  // NOTE: deployedBytecode / runtime bytecode is deliberately NOT accepted as a
  // fallback. It is the code that remains *after* construction, with the
  // constructor stripped out, so deploying it would create a contract whose
  // constructor never ran — every state variable zero and every immutable
  // unset, with no error to tell you. Only creation bytecode belongs here.
  const candidate =
    artifact.bytecode ??                       // solc / Hardhat (string, or {object})
    artifact.data?.bytecode?.object ??         // solc standard-json output
    artifact.evm?.bytecode?.object;            // solc contract output

  if (!candidate) {
    throw new Error(
      `Could not find a bytecode field in ${filePath}. ` +
        `Expected one of: bytecode, bytecode.object, evm.bytecode.object.`
    );
  }
  return normalizeHex(typeof candidate === "string" ? candidate : candidate.object);
}

function normalizeHex(hex) {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length === 0) {
    throw new Error("Bytecode is empty.");
  }
  if (!/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new Error("Bytecode is not valid hex.");
  }
  return stripped;
}

/* ------------------------------------------------------------------ */
/* 2. Parse CLI args (gas, memo, constructor parameters)               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const [, , file, ...rest] = argv;
  if (!file) {
    console.error(
      "Usage: node deploy.js <artifact-or-bin-file> [--gas N] [--memo TEXT] " +
        "[--arg-string V] [--arg-address 0.0.x|0x..] [--arg-uint256 N] [--arg-bool true|false] " +
        "[--arg-string-array a,b,c] [--arg-address-array 0.0.x,0x..] [--arg-uint256-array 1,2,3]"
    );
    process.exit(1);
  }

  const opts = { file, gas: 200_000, memo: "", constructorArgs: [] };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    switch (token) {
      case "--gas":
        opts.gas = Number(rest[++i]);
        break;
      case "--memo":
        opts.memo = rest[++i];
        break;
      case "--arg-string":
        opts.constructorArgs.push(["addString", rest[++i]]);
        break;
      case "--arg-address":
        opts.constructorArgs.push(["addAddress", toEvmAddress(rest[++i])]);
        break;
      case "--arg-uint256":
        opts.constructorArgs.push(["addUint256", rest[++i]]);
        break;
      case "--arg-bool":
        opts.constructorArgs.push(["addBool", rest[++i] === "true"]);
        break;
      case "--arg-string-array":
        opts.constructorArgs.push(["addStringArray", splitList(rest[++i])]);
        break;
      case "--arg-address-array":
        opts.constructorArgs.push([
          "addAddressArray",
          splitList(rest[++i]).map(toEvmAddress),
        ]);
        break;
      case "--arg-uint256-array":
        opts.constructorArgs.push(["addUint256Array", splitList(rest[++i])]);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return opts;
}

/** Split a comma-separated CLI value into trimmed, non-empty items. */
function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Convert a Hedera 0.0.x id or a 0x EVM address to a solidity address. */
function toEvmAddress(value) {
  if (value.startsWith("0x")) return value;
  return AccountId.fromString(value).toSolidityAddress();
}

/** Build the ContractFunctionParameters object from parsed constructor args. */
function buildConstructorParams(argSpecs) {
  if (argSpecs.length === 0) return null;
  const params = new ContractFunctionParameters();
  for (const [method, value] of argSpecs) {
    params[method](value);
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* 3. Build the Hedera client for Testnet                              */
/* ------------------------------------------------------------------ */

/**
 * Parse a private key that may be DER-encoded or a raw ECDSA/ED25519 hex string.
 *
 * NOTE: PrivateKey.fromStringDer() does NOT throw on a non-DER string — it
 * silently falls back to a deprecated raw-key parser that defaults to
 * ED25519, producing the wrong key with no error. So DER-ness must be
 * checked explicitly; a try/catch around fromStringDer() is not safe here.
 */
function parsePrivateKey(raw) {
  if (PrivateKey.isDerKey(raw)) {
    return PrivateKey.fromStringDer(raw);
  }
  // Raw (non-DER) hex string. Hedera Portal testnet accounts default to
  // ECDSA ("HEX Encoded Private Key"); fall back to ED25519 for older/
  // HashPack-style raw keys.
  try {
    return PrivateKey.fromStringECDSA(raw);
  } catch {
    return PrivateKey.fromStringED25519(raw);
  }
}

function makeTestnetClient() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKeyRaw = process.env.HEDERA_OPERATOR_KEY;

  if (!operatorId || !operatorKeyRaw) {
    throw new Error(
      "Please set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in your environment (.env)."
    );
  }

  // Works for both ECDSA and ED25519 keys, DER- or hex-encoded.
  const operatorKey = parsePrivateKey(operatorKeyRaw);

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), operatorKey);
  // Cap accidental fee spend; adjust as needed.
  client.setDefaultMaxTransactionFee(new Hbar(20));
  return client;
}

/* ------------------------------------------------------------------ */
/* 4. Deploy                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv);
  const bytecode = loadBytecode(path.resolve(opts.file));
  const client = makeTestnetClient();

  console.log(`Deploying ${path.basename(opts.file)} to Hedera Testnet ...`);
  console.log(`  gas:  ${opts.gas}`);
  if (opts.memo) console.log(`  memo: ${opts.memo}`);

  // ContractCreateFlow uploads the bytecode to a file (chunked automatically
  // for large contracts) and creates the contract in one convenient step.
  const flow = new ContractCreateFlow()
    .setGas(opts.gas)
    .setBytecode(bytecode);

  if (opts.memo) flow.setContractMemo(opts.memo);

  const params = buildConstructorParams(opts.constructorArgs);
  if (params) flow.setConstructorParameters(params);

  const txResponse = await flow.execute(client);
  const receipt = await txResponse.getReceipt(client);

  const contractId = receipt.contractId;
  if (!contractId) {
    throw new Error(`Deployment failed with status: ${receipt.status.toString()}`);
  }

  const evmAddress = contractId.toSolidityAddress();

  console.log("\n✅ Contract deployed successfully");
  console.log(`  Contract ID : ${contractId.toString()}`);
  console.log(`  EVM address : 0x${evmAddress}`);
  console.log(`  HashScan    : https://hashscan.io/testnet/contract/${contractId.toString()}`);

  client.close();
  return contractId.toString();
}

main().catch((err) => {
  console.error("\n❌ Deployment error:", err.message ?? err);
  process.exit(1);
});

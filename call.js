/**
 * Call a method on a smart contract deployed on the Hedera Testnet.
 *
 * Two ways to use it:
 *
 * 1. FROM THE COMMAND LINE (easiest). Argument types, query-vs-execute and the
 *    return type are all read from the ABI, so you only name the function and
 *    give its arguments:
 *
 *      node call.js state
 *      node call.js results
 *      node call.js vote 0
 *      node call.js isBlocked 0x00000000000000000000000000000000000004d2
 *      node call.js blockAccounts 0xabc...,0xdef...      (arrays: comma-separated)
 *      node call.js hasVoted 0.0.12345                   (0.0.x ids are converted)
 *
 *    Run with no arguments to list every function in the ABI.
 *
 *    Options:
 *      --contract 0.0.x   call a different contract than CONTRACT_ID below
 *      --gas N            override the gas limit
 *      --abi PATH         use a different ABI file
 *      --query            force a read-only call
 *      --execute          force a state-changing transaction
 *
 * 2. BY EDITING THE CONFIG BLOCK below, then running `node call.js` with no
 *    arguments to it. This is the original behaviour and still works; the
 *    command line simply takes precedence when a function name is given.
 *
 * Requires a .env file with HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  ContractId,
  ContractExecuteTransaction,
  ContractCallQuery,
  ContractFunctionParameters,
  Hbar,
} from "@hashgraph/sdk";

/* ================================================================== */
/* CONFIG – used when no function name is given on the command line    */
/* ================================================================== */

// 1. The contract you want to call (e.g. "0.0.1234567").
const CONTRACT_ID = "0.0.10051911"; // Voting contract (deployed 2026-08-13)

// 2. "query"   -> read-only view/pure function (free, no state change)
//    "execute" -> state-changing function (costs gas, produces a receipt status)
const MODE = "execute";

// 3. Name of the Solidity function to call.
const METHOD_NAME = "vote";

// 4. Gas limit (needed for both a query result and an execute transaction).
const GAS = 100_000;

// 5. The single return type to decode. Use null (no quotes) if the method
//    returns nothing, as vote() and blockAccounts() do.
//    Supported: "string" | "bool" | "address" | "uint256" | "int256" |
//               "uint64" | "int64" | "uint32" | "int32" | "uint8" | "int8" |
//               "bytes" | "bytes32"
const RETURN_TYPE = null;

/** 6. Build the call arguments here, in the order the function expects. */
function buildParams() {
  const params = new ContractFunctionParameters();
  params.addUint256(0); // topic index
  return params;
}

/* ================================================================== */
/* Below this line is the reusable machinery — no changes needed       */
/* ================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ABI = path.join(HERE, "build", "Voting.abi");

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

function parseCli(argv) {
  const rest = argv.slice(2);
  const cli = { method: null, args: [], contract: null, gas: null, abi: null, mode: null, list: false };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    switch (token) {
      case "--contract": cli.contract = rest[++i]; break;
      case "--gas":      cli.gas = Number(rest[++i]); break;
      case "--abi":      cli.abi = rest[++i]; break;
      case "--query":    cli.mode = "query"; break;
      case "--execute":  cli.mode = "execute"; break;
      case "--list":
      case "--help":
      case "-h":         cli.list = true; break;
      default:
        if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
        if (cli.method === null) cli.method = token;
        else cli.args.push(token);
    }
  }
  return cli;
}

/** Canonical ABI type string, e.g. "uint256" or "tuple(string,uint256)[]". */
function typeName(item) {
  if (item.type.startsWith("tuple")) {
    const inner = item.components.map(typeName).join(",");
    return `tuple(${inner})${item.type.slice("tuple".length)}`; // keeps any [] suffix
  }
  return item.type;
}

function loadAbi(abiPath) {
  if (!fs.existsSync(abiPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(abiPath, "utf8"));
    return Array.isArray(parsed) ? parsed : parsed.abi ?? null;
  } catch {
    return null;
  }
}

function listFunctions(abi) {
  const fns = abi.filter((f) => f.type === "function");
  const reads = fns.filter((f) => f.stateMutability === "view" || f.stateMutability === "pure");
  const writes = fns.filter((f) => !reads.includes(f));

  const show = (f) => {
    const args = f.inputs.map((i) => typeName(i) + (i.name ? " " + i.name : "")).join(", ");
    const out = f.outputs.map(typeName).join(", ") || "nothing";
    return `    ${f.name}(${args})  ->  ${out}`;
  };

  console.log("Usage: node call.js <function> [args...] [--contract 0.0.x] [--gas N]\n");
  if (writes.length) console.log("  State-changing (a transaction, costs gas):");
  writes.forEach((f) => console.log(show(f)));
  if (reads.length) console.log("\n  Read-only (free query):");
  reads.forEach((f) => console.log(show(f)));
  console.log("\n  Arrays are comma-separated: node call.js blockAccounts 0xaaa...,0xbbb...");
  console.log("  Hedera 0.0.x ids are converted to EVM addresses automatically.");
}

/* ------------------------------------------------------------------ */
/* Turning CLI strings into ContractFunctionParameters                 */
/* ------------------------------------------------------------------ */

/** Convert a Hedera 0.0.x id or a 0x EVM address to a solidity address. */
function toEvmAddress(value) {
  if (value.startsWith("0x")) return value;
  return AccountId.fromString(value).toSolidityAddress();
}

function splitList(value) {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Numbers below 2^48 are safe as JS numbers; anything wider stays a string. */
function numeric(raw, bits) {
  return Number(bits) <= 48 ? Number(raw) : raw;
}

function addArgument(params, type, raw) {
  if (type.endsWith("[]")) {
    const base = type.slice(0, -2);
    const items = splitList(raw);
    if (base === "address") return params.addAddressArray(items.map(toEvmAddress));
    if (base === "string") return params.addStringArray(items);
    const arr = base.match(/^(u?int)(\d*)$/);
    if (arr) {
      const bits = arr[2] || "256";
      const fn = `add${arr[1] === "uint" ? "Uint" : "Int"}${bits}Array`;
      if (typeof params[fn] === "function") return params[fn](items.map((v) => numeric(v, bits)));
    }
    throw new Error(`Cannot build a command-line value for type ${type}. Use the CONFIG block.`);
  }

  if (type === "address") return params.addAddress(toEvmAddress(raw));
  if (type === "string") return params.addString(raw);
  if (type === "bool") {
    if (raw !== "true" && raw !== "false") throw new Error(`Expected true or false, got "${raw}".`);
    return params.addBool(raw === "true");
  }
  if (type === "bytes32") return params.addBytes32(Buffer.from(raw.replace(/^0x/, ""), "hex"));
  if (type === "bytes") return params.addBytes(Buffer.from(raw.replace(/^0x/, ""), "hex"));

  const num = type.match(/^(u?int)(\d*)$/);
  if (num) {
    const bits = num[2] || "256";
    const fn = `add${num[1] === "uint" ? "Uint" : "Int"}${bits}`;
    if (typeof params[fn] === "function") return params[fn](numeric(raw, bits));
  }
  throw new Error(`Cannot build a command-line value for type ${type}. Use the CONFIG block.`);
}

function buildParamsFromAbi(fn, values) {
  if (values.length !== fn.inputs.length) {
    const expected = fn.inputs.map((i) => typeName(i) + (i.name ? " " + i.name : "")).join(", ");
    throw new Error(
      `${fn.name}() expects ${fn.inputs.length} argument(s): ${expected || "(none)"} — got ${values.length}.`
    );
  }
  const params = new ContractFunctionParameters();
  fn.inputs.forEach((input, i) => addArgument(params, typeName(input), values[i]));
  return params;
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

/** Make BigNumber / Buffer / nested arrays printable. */
function plain(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return "0x" + Buffer.from(value).toString("hex");
  }
  if (typeof value === "object" && typeof value.toString === "function" && value._isBigNumber) {
    return value.toString();
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Decode using the ABI's declared output types (handles arrays and structs). */
function decodeWithAbi(result, outputs) {
  if (outputs.length === 0) return { value: undefined, type: "void" };
  const types = outputs.map(typeName);
  const decoded = result.getResult(types).map(plain);
  return {
    value: decoded.length === 1 ? decoded[0] : decoded,
    type: types.join(", "),
  };
}

/** Decode a single return value by name — used by the CONFIG-block path. */
function decodeReturn(result, type) {
  if (type === null || type === undefined || type === "null" || type === "void" || type === "") {
    return { value: undefined, type: "void" };
  }
  const decoders = {
    string: (r) => r.getString(0),
    bool: (r) => r.getBool(0),
    address: (r) => "0x" + r.getAddress(0),
    uint256: (r) => r.getUint256(0).toString(),
    int256: (r) => r.getInt256(0).toString(),
    uint64: (r) => r.getUint64(0).toString(),
    int64: (r) => r.getInt64(0).toString(),
    uint32: (r) => r.getUint32(0),
    int32: (r) => r.getInt32(0),
    uint8: (r) => r.getUint8(0),
    int8: (r) => r.getInt8(0),
    bytes: (r) => "0x" + Buffer.from(r.getBytes(0)).toString("hex"),
    bytes32: (r) => "0x" + Buffer.from(r.getBytes32(0)).toString("hex"),
  };
  const decoder = decoders[type];
  if (!decoder) {
    throw new Error(
      `Unsupported RETURN_TYPE "${type}". Supported: ${Object.keys(decoders).join(", ")}.`
    );
  }
  return { value: decoder(result), type };
}

/** Friendlier output for the shapes this contract actually returns. */
function report(methodName, decoded) {
  if (decoded.type === "void") {
    console.log("  Return value : (nothing)");
    return;
  }

  // results() -> array of [name, voteCount]
  if (methodName === "results" && Array.isArray(decoded.value)) {
    console.log("  Topics:");
    decoded.value.forEach((row, i) => console.log(`    [${i}] ${row[0]} — ${row[1]} vote(s)`));
    return;
  }

  if (methodName === "state") {
    const phases = ["Setup", "Voting", "Closed"];
    console.log(`  Return value : ${decoded.value} (${phases[Number(decoded.value)] ?? "?"})`);
    return;
  }

  if (methodName === "votingStart" || methodName === "votingEnd") {
    const asDate = new Date(Number(decoded.value) * 1000).toISOString();
    console.log(`  Return value : ${decoded.value}  (${asDate})`);
    return;
  }

  console.log(`  Return value : ${JSON.stringify(decoded.value)}`);
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
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
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), parsePrivateKey(operatorKeyRaw));
  client.setDefaultMaxTransactionFee(new Hbar(20));
  return client;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const cli = parseCli(process.argv);
  const abi = loadAbi(cli.abi ? path.resolve(cli.abi) : DEFAULT_ABI);

  if (cli.list) {
    if (!abi) throw new Error(`No ABI found at ${cli.abi ?? DEFAULT_ABI}.`);
    listFunctions(abi);
    return;
  }

  let methodName, mode, gas, contractId, params, abiFn = null;

  if (cli.method) {
    if (!abi) {
      throw new Error(
        `No ABI found at ${cli.abi ?? DEFAULT_ABI}. Pass --abi PATH, or use the CONFIG block.`
      );
    }
    const matches = abi.filter((f) => f.type === "function" && f.name === cli.method);
    if (matches.length === 0) {
      console.error(`No function called "${cli.method}" in the ABI.\n`);
      listFunctions(abi);
      process.exit(1);
    }
    abiFn = matches[0];

    methodName = abiFn.name;
    params = buildParamsFromAbi(abiFn, cli.args);
    const isRead = abiFn.stateMutability === "view" || abiFn.stateMutability === "pure";
    mode = cli.mode ?? (isRead ? "query" : "execute");
    gas = cli.gas ?? GAS;
    contractId = cli.contract ?? CONTRACT_ID;
  } else {
    methodName = METHOD_NAME;
    params = buildParams();
    mode = cli.mode ?? MODE;
    gas = cli.gas ?? GAS;
    contractId = cli.contract ?? CONTRACT_ID;
  }

  const client = makeTestnetClient();
  const target = ContractId.fromString(contractId);

  console.log(`Calling ${methodName}() on ${contractId} (mode: ${mode}) ...\n`);

  let decoded;
  let status;

  if (mode === "query") {
    const result = await new ContractCallQuery()
      .setContractId(target)
      .setGas(gas)
      .setFunction(methodName, params)
      .execute(client);

    decoded = abiFn ? decodeWithAbi(result, abiFn.outputs) : decodeReturn(result, RETURN_TYPE);
    status = "SUCCESS";
  } else if (mode === "execute") {
    const txResponse = await new ContractExecuteTransaction()
      .setContractId(target)
      .setGas(gas)
      .setFunction(methodName, params)
      .execute(client);

    const receipt = await txResponse.getReceipt(client);
    status = receipt.status.toString();

    // Fetching the record costs an extra query, so only do it when the function
    // actually returns something.
    const wantsReturn = abiFn ? abiFn.outputs.length > 0 : RETURN_TYPE !== null;
    if (wantsReturn) {
      const record = await txResponse.getRecord(client);
      decoded = record.contractFunctionResult
        ? abiFn
          ? decodeWithAbi(record.contractFunctionResult, abiFn.outputs)
          : decodeReturn(record.contractFunctionResult, RETURN_TYPE)
        : { value: undefined, type: "void" };
    } else {
      decoded = { value: undefined, type: "void" };
    }

    console.log(`  Transaction  : ${txResponse.transactionId.toString()}`);
  } else {
    throw new Error(`Unknown mode "${mode}". Use "query" or "execute".`);
  }

  console.log("Result");
  report(methodName, decoded);
  console.log(`  Call status  : ${status}`);

  client.close();
}

main().catch((err) => {
  console.error("\n❌ Call error:", err.message ?? err);
  process.exit(1);
});

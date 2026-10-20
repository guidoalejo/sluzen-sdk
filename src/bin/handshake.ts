#!/usr/bin/env node
/**
 * Public compatibility trial kit: unpaid 402 check, or pay + buyer verify.
 * Proxy AgentClient path only. Facilitator is a different door (/legal#trust).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Wallet } from "xrpl";
import { decodeChallenge } from "../codec.js";
import { AgentClient } from "../client.js";
import {
  CALL_ID_HEADER,
  isXrpDropsCurrency,
  PAYMENT_REQUIRED_HEADER,
  type AgentResponse,
  type AgentSignedChallenge,
  type X402Challenge,
} from "../types.js";
import {
  verifyBuyerPayment,
  type BuyerPaymentVerdict,
  type VerifyBuyerPaymentOptions,
} from "../verify.js";

export const DEFAULT_API = "https://api.sluzen.network";
export const DEFAULT_PATH = "/api/v1/investor-demo";

export const HANDSHAKE_USAGE = `Usage: sluzen-handshake <command> [options]

Commands:
  check   Unpaid GET only. Proves the 402 contract. Spends 0 XRP.
  pay     Pay with AgentClient, then verifyBuyerPayment on XRPL_NODE.
          Spends the route price + ledger fee.

Options:
  --api URL     API base (default: SLUZEN_API_URL or ${DEFAULT_API})
  --path PATH   Proxy path (default: SLUZEN_HANDSHAKE_PATH or ${DEFAULT_PATH})
  --help        Show this help and exit 0

Env for pay:
  XRPL_NODE                         Required. Rippled WebSocket URL.
  CLIENT_WALLET_SEED or DEMO_CLIENT_SEED
                                    Required. Never printed.

Facilitator resources use a different door (issuer origin + /legal#trust).
This kit is proxy AgentClient only.
`;

export type ParseHandshakeArgsResult =
  | { action: "help" }
  | { action: "unknown"; message: string }
  | { action: "error"; message: string }
  | { action: "check" | "pay"; api: string; path: string };

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

/**
 * Parse argv after the binary name (process.argv.slice(2)).
 * Rejects unknown commands (exit 2) and extra positionals.
 */
export function parseHandshakeArgs(args: string[]): ParseHandshakeArgsResult {
  if (args.length === 0 || args.every((a) => isHelpFlag(a))) {
    return { action: "help" };
  }

  if (args.some((a) => isHelpFlag(a))) {
    return { action: "help" };
  }

  const command = args[0];
  if (command !== "check" && command !== "pay") {
    return {
      action: "unknown",
      message: `Unknown command: ${command ?? "(none)"}\n\n${HANDSHAKE_USAGE}`,
    };
  }

  let api = process.env.SLUZEN_API_URL?.trim() || DEFAULT_API;
  let routePath = process.env.SLUZEN_HANDSHAKE_PATH?.trim() || DEFAULT_PATH;

  const rest = args.slice(1);
  let i = 0;
  while (i < rest.length) {
    const token = rest[i]!;
    if (token === "--api") {
      const value = rest[i + 1];
      if (value == null || value.startsWith("-")) {
        return { action: "error", message: "--api requires a URL" };
      }
      api = value.replace(/\/$/, "");
      i += 2;
      continue;
    }
    if (token === "--path") {
      const value = rest[i + 1];
      if (value == null || value.startsWith("-")) {
        return { action: "error", message: "--path requires a path" };
      }
      routePath = value.startsWith("/") ? value : `/${value}`;
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      return { action: "error", message: `Unknown option: ${token}` };
    }
    return {
      action: "error",
      message: `Unexpected argument: ${token}`,
    };
  }

  return { action: command, api: api.replace(/\/$/, ""), path: routePath };
}

function isClassicAddress(value: string): boolean {
  return typeof value === "string" && value.startsWith("r") && value.length >= 25;
}

function bodyCallId(data: unknown): string | undefined {
  if (data == null || typeof data !== "object") {
    return undefined;
  }
  const id = (data as { callId?: unknown }).callId;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  return undefined;
}

export type CheckSuccess = {
  ok: true;
  mode: "check";
  callId?: string;
  amountDrops: number;
  destination: string;
  network: string;
  /** Retained for pay; not printed on the check success line. */
  challenge: AgentSignedChallenge & { network: string };
};

export type CheckFailure = {
  ok: false;
  mode: "check";
  cause: string;
};

export type CheckResult = CheckSuccess | CheckFailure;

/**
 * Unpaid GET. Validates 402 + PAYMENT-REQUIRED + challenge shape.
 * Spends 0 XRP. No wallet. No admin.
 */
export async function runCheck(options: {
  api: string;
  path: string;
  fetchFn?: typeof fetch;
}): Promise<CheckResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const base = options.api.replace(/\/$/, "");
  const pathPart = options.path.startsWith("/")
    ? options.path
    : `/${options.path}`;
  const url = `${base}${pathPart}`;

  let response: Response;
  try {
    response = await fetchFn(url, { method: "GET" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch_failed";
    return { ok: false, mode: "check", cause: `fetch_failed: ${message}` };
  }

  if (response.status !== 402) {
    return {
      ok: false,
      mode: "check",
      cause: `expected_402_got_${response.status}`,
    };
  }

  const paymentRequired = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (paymentRequired == null || paymentRequired.length === 0) {
    return {
      ok: false,
      mode: "check",
      cause: "missing_PAYMENT-REQUIRED",
    };
  }

  let challenge: X402Challenge;
  try {
    challenge = decodeChallenge(paymentRequired);
  } catch {
    return { ok: false, mode: "check", cause: "challenge_decode_failed" };
  }

  if (
    typeof challenge.nonce !== "string" ||
    challenge.nonce.length === 0
  ) {
    return { ok: false, mode: "check", cause: "missing_nonce" };
  }
  if (!isClassicAddress(challenge.destination ?? "")) {
    return { ok: false, mode: "check", cause: "invalid_destination" };
  }
  if (
    typeof challenge.amount !== "number" ||
    !Number.isInteger(challenge.amount) ||
    challenge.amount <= 0
  ) {
    return { ok: false, mode: "check", cause: "invalid_amount" };
  }
  if (
    typeof challenge.currency !== "string" ||
    !isXrpDropsCurrency(challenge.currency)
  ) {
    return { ok: false, mode: "check", cause: "currency_not_xrp" };
  }
  if (
    typeof challenge.network !== "string" ||
    challenge.network.length === 0
  ) {
    return { ok: false, mode: "check", cause: "missing_network" };
  }

  const headerCallId = response.headers.get(CALL_ID_HEADER) ?? undefined;
  let data: unknown;
  try {
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && text.length > 0) {
      data = JSON.parse(text) as unknown;
    } else {
      data = text.length > 0 ? text : undefined;
    }
  } catch {
    return { ok: false, mode: "check", cause: "body_parse_failed" };
  }

  const fromBody = bodyCallId(data);
  if (
    headerCallId &&
    challenge.callId &&
    headerCallId !== challenge.callId
  ) {
    return { ok: false, mode: "check", cause: "callId_mismatch_header" };
  }
  if (fromBody && challenge.callId && fromBody !== challenge.callId) {
    return { ok: false, mode: "check", cause: "callId_mismatch_body" };
  }

  const callId = challenge.callId ?? headerCallId ?? fromBody;
  const signed: AgentSignedChallenge & { network: string } = {
    nonce: challenge.nonce,
    destination: challenge.destination,
    amount: challenge.amount,
    currency: challenge.currency,
    network: challenge.network,
  };
  if (challenge.callId != null && challenge.callId.length > 0) {
    signed.callId = challenge.callId;
  }

  return {
    ok: true,
    mode: "check",
    ...(callId ? { callId } : {}),
    amountDrops: challenge.amount,
    destination: challenge.destination,
    network: challenge.network,
    challenge: signed,
  };
}

export type PaySuccess = {
  ok: true;
  mode: "pay";
  status: number;
  callId?: string;
  txHash: string;
  amountDrops: number;
};

export type PayFailure = {
  ok: false;
  mode: "pay";
  cause: string;
  status?: number;
  txHash?: string;
  verdictCause?: string;
};

export type PayResult = PaySuccess | PayFailure;

export type RunPayOptions = {
  api: string;
  path: string;
  seed: string;
  node: string;
  fetchFn?: typeof fetch;
  /** Test injection: skip AgentClient construction. */
  request?: (path: string) => Promise<AgentResponse>;
  /** Test injection for verifyBuyerPayment. */
  verify?: (
    options: VerifyBuyerPaymentOptions,
  ) => Promise<BuyerPaymentVerdict>;
};

/**
 * Unpaid checks first, then AgentClient.request + verifyBuyerPayment.
 * Exit success only when HTTP 2xx and verdict.ok.
 */
export async function runPay(options: RunPayOptions): Promise<PayResult> {
  const unpaid = await runCheck({
    api: options.api,
    path: options.path,
    fetchFn: options.fetchFn,
  });
  if (!unpaid.ok) {
    return { ok: false, mode: "pay", cause: `check_failed: ${unpaid.cause}` };
  }

  const challenge = unpaid.challenge;
  let result: AgentResponse;
  try {
    if (options.request) {
      result = await options.request(options.path);
    } else {
      const client = new AgentClient({
        baseUrl: options.api,
        walletSeed: options.seed,
        fetchFn: options.fetchFn,
      });
      result = await client.request(options.path);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    return { ok: false, mode: "pay", cause: `request_failed: ${message}` };
  }

  if (result.status < 200 || result.status > 299) {
    return {
      ok: false,
      mode: "pay",
      cause: `http_not_2xx: ${result.status}`,
      status: result.status,
    };
  }

  const txHash = result.paymentResponse;
  if (txHash == null || txHash.length === 0) {
    return {
      ok: false,
      mode: "pay",
      cause: "missing_PAYMENT-RESPONSE",
      status: result.status,
    };
  }

  const signed = result.challenge ?? {
    nonce: challenge.nonce,
    destination: challenge.destination,
    amount: challenge.amount,
    currency: challenge.currency,
    callId: challenge.callId,
  };

  let payer: string;
  try {
    payer = Wallet.fromSeed(options.seed).address;
  } catch {
    return { ok: false, mode: "pay", cause: "invalid_wallet_seed" };
  }

  const verifyFn = options.verify ?? verifyBuyerPayment;
  let verdict: BuyerPaymentVerdict;
  try {
    verdict = await verifyFn({
      txHash,
      node: options.node,
      expect: {
        destination: signed.destination,
        nonce: signed.nonce,
        minAmountDrops: signed.amount,
        payer,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "verify_failed";
    return {
      ok: false,
      mode: "pay",
      cause: `verify_failed: ${message}`,
      status: result.status,
      txHash,
    };
  }

  if (!verdict.ok) {
    return {
      ok: false,
      mode: "pay",
      cause: "verify_not_ok",
      status: result.status,
      txHash,
      verdictCause: verdict.cause,
    };
  }

  const callId =
    result.callId ?? signed.callId ?? unpaid.callId;

  return {
    ok: true,
    mode: "pay",
    status: result.status,
    ...(callId ? { callId } : {}),
    txHash,
    amountDrops: signed.amount,
  };
}

function printCheckSuccess(result: CheckSuccess): void {
  const line: Record<string, unknown> = {
    ok: true,
    mode: "check",
    amountDrops: result.amountDrops,
    destination: result.destination,
    network: result.network,
  };
  if (result.callId) {
    line.callId = result.callId;
  }
  console.log(JSON.stringify(line));
}

function printPaySuccess(result: PaySuccess): void {
  const line: Record<string, unknown> = {
    ok: true,
    mode: "pay",
    status: result.status,
    txHash: result.txHash,
    amountDrops: result.amountDrops,
  };
  if (result.callId) {
    line.callId = result.callId;
  }
  console.log(JSON.stringify(line));
}

function printFailure(
  mode: "check" | "pay",
  cause: string,
  extra?: Record<string, unknown>,
): void {
  console.error(JSON.stringify({ ok: false, mode, cause, ...extra }));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseHandshakeArgs(argv);

  if (parsed.action === "help") {
    console.log(HANDSHAKE_USAGE);
    return 0;
  }
  if (parsed.action === "unknown") {
    console.error(parsed.message);
    return 2;
  }
  if (parsed.action === "error") {
    console.error(JSON.stringify({ ok: false, cause: parsed.message }));
    return 1;
  }

  if (parsed.action === "check") {
    const result = await runCheck({ api: parsed.api, path: parsed.path });
    if (!result.ok) {
      printFailure("check", result.cause);
      return 1;
    }
    printCheckSuccess(result);
    return 0;
  }

  const seed =
    process.env.CLIENT_WALLET_SEED?.trim() ||
    process.env.DEMO_CLIENT_SEED?.trim() ||
    "";
  const node = process.env.XRPL_NODE?.trim() || "";
  if (!seed) {
    printFailure(
      "pay",
      "CLIENT_WALLET_SEED_or_DEMO_CLIENT_SEED_required",
    );
    return 1;
  }
  if (!node) {
    printFailure("pay", "XRPL_NODE_required");
    return 1;
  }

  const result = await runPay({
    api: parsed.api,
    path: parsed.path,
    seed,
    node,
  });
  if (!result.ok) {
    printFailure("pay", result.cause, {
      ...(result.status != null ? { status: result.status } : {}),
      ...(result.txHash ? { txHash: result.txHash } : {}),
      ...(result.verdictCause ? { verdictCause: result.verdictCause } : {}),
    });
    return 1;
  }
  printPaySuccess(result);
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ ok: false, cause: message }));
      process.exit(1);
    });
}

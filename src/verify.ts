import { Client, decode, hashes } from "xrpl";
import { CHALLENGE_NONCE_MEMO_TYPE } from "./types.js";

/** XRPL Payment flag: tfPartialPayment */
const TF_PARTIAL_PAYMENT = 0x00020000;

export type BuyerVerifyCause =
  | "invalid_tx_blob"
  | "not_payment"
  | "iou_not_supported"
  | "missing_nonce"
  | "nonce_mismatch"
  | "destination_mismatch"
  | "payer_mismatch"
  | "amount_too_low"
  | "partial_payment"
  | "not_validated"
  | "not_success"
  | "tx_not_found"
  | "node_error";

export type BuyerPaymentExpect = {
  /** Issuer classic address. Required. */
  destination: string;
  /** Minimum drops (endpoint price). Paid amount must be >= this. */
  minAmountDrops: string | number | bigint;
  /** Challenge nonce from decoded PAYMENT-REQUIRED. Required. */
  nonce: string;
  /** Payer classic address. Required for the you-paid check (Account on the tx). */
  payer: string;
};

export type BuyerPaymentVerdict =
  | {
      ok: true;
      hash: string;
      payer: string;
      destination: string;
      amountDrops: string;
      nonce: string;
      ledgerIndex?: number;
    }
  | { ok: false; cause: BuyerVerifyCause; hash?: string };

export type DecodedSignedPayment = {
  hash: string;
  account: string;
  destination: string;
  amountDrops: string;
  nonce: string | undefined;
  transactionType: string;
};

export type VerifyBuyerPaymentOptions = {
  /** Exactly one of txHash or txBlob. */
  txHash?: string;
  /** Exactly one of txHash or txBlob. */
  txBlob?: string;
  /** Default `process.env.XRPL_NODE`. Required when this function creates the client. */
  node?: string;
  expect: BuyerPaymentExpect;
  /** Injected client (tests). When set, this function does not disconnect it. */
  client?: Pick<Client, "connect" | "request" | "disconnect">;
  /** Injected `tx` lookup (tests). Skips WebSocket entirely. */
  requestTx?: (hash: string) => Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function hexToUtf8(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}

function xrpDropsFromAmount(amount: unknown): string | null {
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
    return null;
  }
  return amount;
}

function extractNonceFromMemos(memos: unknown): string | undefined {
  if (!Array.isArray(memos)) return undefined;
  for (const entry of memos) {
    if (entry == null || typeof entry !== "object") continue;
    const memoWrapper = entry as {
      Memo?: { MemoType?: string; MemoData?: string };
    };
    const memo = memoWrapper.Memo;
    if (!memo?.MemoType || !memo.MemoData) continue;
    try {
      const type = hexToUtf8(memo.MemoType);
      if (type === CHALLENGE_NONCE_MEMO_TYPE) {
        return hexToUtf8(memo.MemoData);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function isTxnNotFound(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const record = error as {
    data?: { error?: string };
    message?: string;
    name?: string;
  };
  if (record.data?.error === "txnNotFound") return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /txnNotFound|Transaction not found/i.test(message);
}

/**
 * Offline decode of a signed Payment blob. No network.
 * Throws Error with message `iou_not_supported` when Amount is an IOU object.
 * Throws Error for an undecodable blob.
 */
export function decodeSignedPayment(txBlob: string): DecodedSignedPayment {
  let decoded: Record<string, unknown>;
  try {
    decoded = decode(txBlob) as Record<string, unknown>;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to decode transaction";
    throw new Error(`invalid_tx_blob: ${message}`);
  }

  let hash: string;
  try {
    hash = hashes.hashSignedTx(txBlob);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid signed transaction blob";
    throw new Error(`invalid_tx_blob: ${message}`);
  }

  const amount = decoded.Amount;
  if (amount != null && typeof amount === "object") {
    throw new Error("iou_not_supported");
  }
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
    throw new Error("iou_not_supported");
  }

  return {
    hash,
    account: typeof decoded.Account === "string" ? decoded.Account : "",
    destination:
      typeof decoded.Destination === "string" ? decoded.Destination : "",
    amountDrops: amount,
    nonce: extractNonceFromMemos(decoded.Memos),
    transactionType:
      typeof decoded.TransactionType === "string"
        ? decoded.TransactionType
        : "",
  };
}

function parseTxEnvelope(raw: unknown): {
  result: Record<string, unknown>;
  txJson: Record<string, unknown>;
  meta: Record<string, unknown> | null;
} | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  const result = asRecord(envelope.result) ?? envelope;
  if (!result) return null;
  const txJson = asRecord(result.tx_json) ?? result;
  const meta = asRecord(result.meta);
  return { result, txJson, meta };
}

function creditedDrops(
  txJson: Record<string, unknown>,
  meta: Record<string, unknown> | null,
): { ok: true; drops: string } | { ok: false; cause: BuyerVerifyCause } {
  const amount = txJson.Amount;
  if (amount != null && typeof amount === "object") {
    return { ok: false, cause: "iou_not_supported" };
  }
  const signed = xrpDropsFromAmount(amount);
  if (signed == null) {
    return { ok: false, cause: "iou_not_supported" };
  }

  const flags =
    typeof txJson.Flags === "number"
      ? txJson.Flags
      : typeof txJson.Flags === "string" && /^[0-9]+$/.test(txJson.Flags)
        ? Number(txJson.Flags)
        : 0;
  const partialFlag = (flags & TF_PARTIAL_PAYMENT) !== 0;
  const delivered = xrpDropsFromAmount(meta?.delivered_amount);

  if (partialFlag) {
    if (delivered == null) {
      return { ok: false, cause: "partial_payment" };
    }
    return { ok: true, drops: delivered };
  }

  if (delivered != null && BigInt(delivered) < BigInt(signed)) {
    return { ok: true, drops: delivered };
  }

  return { ok: true, drops: signed };
}

function verdictFromLedger(
  raw: unknown,
  expect: BuyerPaymentExpect,
  fallbackHash: string,
): BuyerPaymentVerdict {
  const parsed = parseTxEnvelope(raw);
  if (!parsed) {
    return { ok: false, cause: "tx_not_found", hash: fallbackHash };
  }

  const { result, txJson, meta } = parsed;
  const hash =
    (typeof result.hash === "string" ? result.hash : undefined) ??
    (typeof txJson.hash === "string" ? txJson.hash : undefined) ??
    fallbackHash;

  if (result.validated !== true) {
    return { ok: false, cause: "not_validated", hash };
  }

  const engine =
    typeof meta?.TransactionResult === "string"
      ? meta.TransactionResult
      : undefined;
  if (engine !== "tesSUCCESS") {
    return { ok: false, cause: "not_success", hash };
  }

  const transactionType =
    typeof txJson.TransactionType === "string" ? txJson.TransactionType : "";
  if (transactionType !== "Payment") {
    return { ok: false, cause: "not_payment", hash };
  }

  const destination =
    typeof txJson.Destination === "string" ? txJson.Destination : "";
  if (destination !== expect.destination) {
    return { ok: false, cause: "destination_mismatch", hash };
  }

  const payer = typeof txJson.Account === "string" ? txJson.Account : "";
  if (payer !== expect.payer) {
    return { ok: false, cause: "payer_mismatch", hash };
  }

  const nonce = extractNonceFromMemos(txJson.Memos);
  if (nonce == null || nonce.length === 0) {
    return { ok: false, cause: "missing_nonce", hash };
  }
  if (nonce !== expect.nonce) {
    return { ok: false, cause: "nonce_mismatch", hash };
  }

  const credited = creditedDrops(txJson, meta);
  if (!credited.ok) {
    return { ok: false, cause: credited.cause, hash };
  }

  let min: bigint;
  try {
    min = BigInt(expect.minAmountDrops);
  } catch {
    return { ok: false, cause: "amount_too_low", hash };
  }

  let paid: bigint;
  try {
    paid = BigInt(credited.drops);
  } catch {
    return { ok: false, cause: "amount_too_low", hash };
  }

  if (paid < min) {
    const flags =
      typeof txJson.Flags === "number"
        ? txJson.Flags
        : typeof txJson.Flags === "string" && /^[0-9]+$/.test(txJson.Flags)
          ? Number(txJson.Flags)
          : 0;
    const partialFlag = (flags & TF_PARTIAL_PAYMENT) !== 0;
    if (partialFlag) {
      return { ok: false, cause: "partial_payment", hash };
    }
    return { ok: false, cause: "amount_too_low", hash };
  }

  const ledgerIndex =
    typeof result.ledger_index === "number" ? result.ledger_index : undefined;

  return {
    ok: true,
    hash,
    payer,
    destination,
    amountDrops: credited.drops,
    nonce,
    ledgerIndex,
  };
}

/**
 * Buyer-side check against the caller's XRPL node.
 * Verdict comes from the ledger `tx` response, not from Sluzen HTTP or the issuer body.
 * `callId` is HTTP telemetry only; the memo nonce binds the Payment on-chain.
 */
export async function verifyBuyerPayment(
  options: VerifyBuyerPaymentOptions,
): Promise<BuyerPaymentVerdict> {
  const hasHash =
    typeof options.txHash === "string" && options.txHash.length > 0;
  const hasBlob =
    typeof options.txBlob === "string" && options.txBlob.length > 0;
  if (hasHash === hasBlob) {
    throw new Error("verifyBuyerPayment requires exactly one of txHash or txBlob");
  }

  let hash: string;
  if (hasBlob) {
    try {
      hash = decodeSignedPayment(options.txBlob!).hash;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "iou_not_supported" || message.startsWith("iou_not_supported")) {
        return { ok: false, cause: "iou_not_supported" };
      }
      return { ok: false, cause: "invalid_tx_blob" };
    }
  } else {
    const candidate = options.txHash!.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) {
      return { ok: false, cause: "invalid_tx_blob" };
    }
    hash = candidate.toUpperCase();
  }

  if (options.requestTx) {
    try {
      const raw = await options.requestTx(hash);
      return verdictFromLedger(raw, options.expect, hash);
    } catch (error) {
      if (isTxnNotFound(error)) {
        return { ok: false, cause: "tx_not_found", hash };
      }
      return { ok: false, cause: "node_error", hash };
    }
  }

  const ownedClient = !options.client;
  const node = options.node ?? process.env.XRPL_NODE;
  if (ownedClient && !node) {
    throw new Error("XRPL_NODE environment variable is required");
  }

  const client = options.client ?? new Client(node!);
  let connectedByUs = false;
  try {
    if (ownedClient) {
      await client.connect();
      connectedByUs = true;
    }
    let raw: unknown;
    try {
      raw = await client.request({ command: "tx", transaction: hash });
    } catch (error) {
      if (isTxnNotFound(error)) {
        return { ok: false, cause: "tx_not_found", hash };
      }
      return { ok: false, cause: "node_error", hash };
    }
    return verdictFromLedger(raw, options.expect, hash);
  } finally {
    if (connectedByUs) {
      await client.disconnect();
    }
  }
}

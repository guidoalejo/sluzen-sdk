import { CALL_ID_HEADER, PAYMENT_REQUIRED_HEADER } from "./types.js";

/** Challenge the issuer reads. No resource body. */
export interface FacilitatorChallenge {
  paymentRequired: string;
  callId?: string;
}

/** Check a signed payment. This does not consume the challenge or submit. */
export interface FacilitatorVerification {
  isValid: boolean;
  callId?: string;
  cause?: string;
}

/**
 * Handler result, released only after `/facilitator/settle` succeeds.
 * The handler value is not sent to Sluzen.
 */
export interface FacilitatorSettlement<T> {
  body: T;
  txHash: string;
  callId?: string;
  network: string;
}

export class FacilitatorRequestError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(message: string, status: number, reason: string) {
    super(message);
    this.name = "FacilitatorRequestError";
    this.status = status;
    this.reason = reason;
  }
}

interface FacilitatorCall {
  apiBase: string;
  resource: string;
  fetchFn?: typeof fetch;
}

function apiUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/$/, "")}${path}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function reasonOf(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.cause === "string" && body.cause.length > 0) {
    return body.cause;
  }
  if (typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  return fallback;
}

function callIdOf(
  response: Response,
  body: Record<string, unknown>,
): string | undefined {
  const header = response.headers.get(CALL_ID_HEADER);
  if (header != null && header.length > 0) {
    return header;
  }
  if (typeof body.callId === "string" && body.callId.length > 0) {
    return body.callId;
  }
  return undefined;
}

async function postJson(
  options: FacilitatorCall,
  path: string,
  payload: { resource: string; paymentSignature?: string },
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  return fetchFn(apiUrl(options.apiBase, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Ask Sluzen for a 402 challenge. Does not fetch the resource and does not settle.
 */
export async function facilitatorChallenge(
  options: FacilitatorCall,
): Promise<FacilitatorChallenge> {
  const response = await postJson(options, "/facilitator/challenge", {
    resource: options.resource,
  });
  const payload = await readJson(response);
  const paymentRequired = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (response.status !== 402 || paymentRequired == null || paymentRequired.length === 0) {
    throw new FacilitatorRequestError(
      "Facilitator challenge failed",
      response.status,
      reasonOf(payload, "challenge_failed"),
    );
  }
  const callId = callIdOf(response, payload);
  return callId ? { paymentRequired, callId } : { paymentRequired };
}

/**
 * Check the signed payment. Does not consume the challenge and does not submit.
 */
export async function facilitatorVerify(
  options: FacilitatorCall & { paymentSignature: string },
): Promise<FacilitatorVerification> {
  if (options.paymentSignature.trim().length === 0) {
    throw new FacilitatorRequestError(
      "Payment signature is required",
      400,
      "missing_payment_signature",
    );
  }
  const response = await postJson(options, "/facilitator/verify", {
    resource: options.resource,
    paymentSignature: options.paymentSignature,
  });
  const payload = await readJson(response);
  if (response.status !== 200 || typeof payload.isValid !== "boolean") {
    throw new FacilitatorRequestError(
      "Facilitator verify failed",
      response.status,
      reasonOf(payload, "verify_failed"),
    );
  }
  const callId = callIdOf(response, payload);
  const result: FacilitatorVerification = { isValid: payload.isValid };
  if (callId) {
    result.callId = callId;
  }
  if (!payload.isValid && typeof payload.cause === "string" && payload.cause.length > 0) {
    result.cause = payload.cause;
  }
  return result;
}

function isXrplNetworkId(network: unknown): network is string {
  return (
    typeof network === "string" &&
    (network === "XRPL" ||
      network === "xrpl:0" ||
      network === "xrpl:1" ||
      /^xrpl:\d+$/.test(network))
  );
}

function isSettlement(payload: Record<string, unknown>): payload is {
  success: true;
  txHash: string;
  network: string;
  callId?: string;
} {
  return (
    payload.success === true &&
    typeof payload.txHash === "string" &&
    payload.txHash.length > 0 &&
    isXrplNetworkId(payload.network)
  );
}

/**
 * Run the handler, then submit once. The handler body is returned only when
 * settle succeeds. A handler failure does not submit. The body is not posted.
 */
export async function facilitatorSettle<T>(
  options: FacilitatorCall & {
    paymentSignature: string;
    handler: () => T | Promise<T>;
  },
): Promise<FacilitatorSettlement<T>> {
  if (options.paymentSignature.trim().length === 0) {
    throw new FacilitatorRequestError(
      "Payment signature is required",
      400,
      "missing_payment_signature",
    );
  }
  const produced = await options.handler();
  const response = await postJson(options, "/facilitator/settle", {
    resource: options.resource,
    paymentSignature: options.paymentSignature,
  });
  const payload = await readJson(response);
  if (response.status !== 200 || !isSettlement(payload)) {
    throw new FacilitatorRequestError(
      "Facilitator settle failed",
      response.status,
      reasonOf(payload, "settle_failed"),
    );
  }
  const callId = callIdOf(response, payload);
  return callId
    ? {
        body: produced,
        txHash: payload.txHash,
        callId,
        network: payload.network,
      }
    : { body: produced, txHash: payload.txHash, network: payload.network };
}

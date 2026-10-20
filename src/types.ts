/** Live product currency. Payment Amount is native XRPL drops (string). IOU/RLUSD is not implemented. */
export const NATIVE_SETTLEMENT_CURRENCY = "XRP" as const;

export function isXrpDropsCurrency(currency: string): boolean {
  return currency.trim().toUpperCase() === NATIVE_SETTLEMENT_CURRENCY;
}

/** CAIP-2 XRPL (`xrpl:0` testnet, `xrpl:1` mainnet). Legacy `XRPL` may appear on older challenges. */
export type XrplNetworkId = "xrpl:0" | "xrpl:1" | "XRPL" | string;

export interface X402Accept {
  scheme: "exact";
  network: XrplNetworkId;
  asset: "XRP";
  payTo: string;
  /** Integer XRP drops, decimal string. */
  maxAmountRequired: string;
  extra: {
    nonce: string;
    callId?: string;
    memoType: "sluzen/challenge-nonce";
  };
}

export interface X402Challenge {
  network: string;
  currency: string;
  /** Integer XRP drops. Not USD microcents. */
  amount: number;
  destination: string;
  expiration: number;
  /** Server-issued challenge nonce; must appear in Payment Memos */
  nonce: string;
  /**
   * Generic x402 view of the same challenge. Callers that already read
   * `amount`, `destination`, and `nonce` can ignore this.
   */
  accepts?: X402Accept[];
  /**
   * Durable id of this attempt (`PaymentChallenge.id`).
   * The nonce still binds the Payment. This id is what settlement and delivery share.
   * Absent on challenges issued before the field existed.
   */
  callId?: string;
}

/** Challenge fields retained after a 402 negotiation (for buyer verify). */
export interface AgentSignedChallenge {
  nonce: string;
  destination: string;
  amount: number;
  currency: string;
  callId?: string;
}

export interface AgentResponse {
  status: number;
  data: unknown;
  paymentResponse?: string;
  /** Same id as the 402 challenge, when the server sent `SLUZEN-CALL-ID`. */
  callId?: string;
  /**
   * Challenge that was signed for this request.
   * Present only when an unsigned 402 with `PAYMENT-REQUIRED` was negotiated.
   */
  challenge?: AgentSignedChallenge;
}

export interface AgentClientOptions {
  baseUrl: string;
  walletSeed?: string;
  fetchFn?: typeof fetch;
}

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED" as const;
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE" as const;
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE" as const;
/** Durable attempt id. Present on the 402 and on the paid response. Not a payment memo. */
export const CALL_ID_HEADER = "SLUZEN-CALL-ID" as const;

/** XRPL MemoType ASCII for challenge binding */
export const CHALLENGE_NONCE_MEMO_TYPE = "sluzen/challenge-nonce" as const;

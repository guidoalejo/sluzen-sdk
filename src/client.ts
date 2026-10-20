import { Client, Wallet, type Payment } from "xrpl";
import { decodeChallenge } from "./codec.js";
import {
  CHALLENGE_NONCE_MEMO_TYPE,
  isXrpDropsCurrency,
  CALL_ID_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type AgentClientOptions,
  type AgentResponse,
  type X402Challenge,
} from "./types.js";

function utf8ToHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function readCallId(response: Response): string | undefined {
  const value = response.headers.get(CALL_ID_HEADER);
  if (value == null || value.length === 0) {
    return undefined;
  }
  return value;
}

export class AgentClient {
  private readonly baseUrl: string;
  private readonly walletSeed: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: AgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.walletSeed =
      options.walletSeed ?? process.env.CLIENT_WALLET_SEED ?? "";
    if (!this.walletSeed) {
      throw new Error("CLIENT_WALLET_SEED environment variable is required");
    }
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Negotiate a challenge only on unsigned 402 + PAYMENT-REQUIRED.
   * A 402 without that header is a settlement/bind failure, not a new quote.
   */
  async request(path: string, init?: RequestInit): Promise<AgentResponse> {
    const url = `${this.baseUrl}${path}`;
    const initialResponse = await this.fetchFn(url, init);

    if (initialResponse.status !== 402) {
      const data = await this.parseBody(initialResponse);
      return {
        status: initialResponse.status,
        data,
        paymentResponse:
          initialResponse.headers.get(PAYMENT_RESPONSE_HEADER) ?? undefined,
        callId: readCallId(initialResponse),
      };
    }

    const paymentRequired = initialResponse.headers.get(
      PAYMENT_REQUIRED_HEADER,
    );
    if (!paymentRequired) {
      throw new Error("402 response missing PAYMENT-REQUIRED header");
    }

    const challenge = decodeChallenge(paymentRequired);
    if (!challenge.nonce) {
      throw new Error("402 challenge missing nonce");
    }
    const txBlob = await this.signPayment(challenge);

    const headers = new Headers(init?.headers);
    headers.set(PAYMENT_SIGNATURE_HEADER, txBlob);

    const paidResponse = await this.fetchFn(url, { ...init, headers });
    const data = await this.parseBody(paidResponse);

    const signedChallenge: AgentResponse["challenge"] = {
      nonce: challenge.nonce,
      destination: challenge.destination,
      amount: challenge.amount,
      currency: challenge.currency,
    };
    if (challenge.callId != null && challenge.callId.length > 0) {
      signedChallenge.callId = challenge.callId;
    }

    return {
      status: paidResponse.status,
      data,
      paymentResponse:
        paidResponse.headers.get(PAYMENT_RESPONSE_HEADER) ?? undefined,
      callId: readCallId(paidResponse) ?? readCallId(initialResponse),
      challenge: signedChallenge,
    };
  }

  private async signPayment(challenge: X402Challenge): Promise<string> {
    if (!isXrpDropsCurrency(challenge.currency)) {
      throw new Error(
        `Issued currency ${challenge.currency} is not supported; Sluzen settles XRP drops only`,
      );
    }

    const wallet = Wallet.fromSeed(this.walletSeed);
    const node = process.env.XRPL_NODE;
    if (!node) {
      throw new Error("XRPL_NODE environment variable is required");
    }

    const client = new Client(node);
    const payment: Payment = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: challenge.destination,
      Amount: String(challenge.amount),
      Memos: [
        {
          Memo: {
            MemoType: utf8ToHex(CHALLENGE_NONCE_MEMO_TYPE),
            MemoData: utf8ToHex(challenge.nonce),
          },
        },
      ],
    };

    await client.connect();
    try {
      const prepared = await client.autofill(payment);
      return wallet.sign(prepared).tx_blob;
    } finally {
      await client.disconnect();
    }
  }

  private async parseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (contentType.includes("application/json") && text.length > 0) {
      return JSON.parse(text) as unknown;
    }

    return text;
  }
}

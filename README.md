# @sluzen/sdk

Client for **Sluzen** (x402 on the XRP Ledger).

Two sides. Callers use `AgentClient`. The issuer server for a facilitator resource uses `facilitatorChallenge`, `facilitatorVerify`, and `facilitatorSettle`. Issued currencies (IOU/RLUSD) are not supported. Amounts are XRP drops.

HTTP contract (proxy + facilitator + public telemetry): [sluzen.network/openapi.yaml](https://sluzen.network/openapi.yaml).

Evaluate without an issuer key (demo 402 → OpenAPI → Proof → settle): [sluzen.network/developers](https://sluzen.network/developers).

## HTTP 402

- **Challenge:** `402` **with** `PAYMENT-REQUIRED`. Only this is a quote to sign.
- **Settlement / bind failure:** `402` **without** that header (or `409` replay). Do not treat every 402 as “sign this header”. `AgentClient` only negotiates the unsigned 402 that carries `PAYMENT-REQUIRED`.

Full proxy wire walkthrough (decode, paid retry, failure modes, fixtures):
[sluzen.network/guides/http-402](https://sluzen.network/guides/http-402).

Issuers (correlate one attempt; export events by `callId`):
`GET /admin/calls` (Bearer issuer key; not an SDK HTTP client).

## Installation

```bash
npm i @sluzen/sdk
```

## Callers: `AgentClient`

Set `CLIENT_WALLET_SEED` (XRPL wallet seed) and `XRPL_NODE` (rippled WebSocket URL). The seed stays on the caller machine. Never paste it into sluzen.network.

On a proxy path, `baseUrl` is Sluzen and the path starts with `/`:

```typescript
import { AgentClient } from "@sluzen/sdk";

const client = new AgentClient({
  baseUrl: "https://api.sluzen.network",
});

const response = await client.request("/api/v1/harbor");
console.log(response.status, response.data, response.callId);
```

On a facilitator resource, point `AgentClient` at the issuer origin, not at Sluzen. That works when the issuer server sends `PAYMENT-REQUIRED` on the unpaid call and reads `PAYMENT-SIGNATURE` on the retry:

```typescript
const client = new AgentClient({
  baseUrl: "https://issuer.example",
});

const response = await client.request("/v1/tide");
```

The client receives HTTP 402 + `PAYMENT-REQUIRED`, signs the XRPL payment, resends, and returns the response plus any `PAYMENT-RESPONSE` hash. The same attempt id is on `SLUZEN-CALL-ID` (and `callId` in the 402 body). `AgentClient` returns it as `response.callId`. When a 402 was negotiated, `response.challenge` holds the fields that were signed (`nonce`, `destination`, `amount`, `currency`, optional `callId`). The nonce in the Payment memo stays the bind secret. It is not the durable id.

## Handshake

Public trial kit on the `@sluzen/sdk` binary only (not `sluzen start`). No issuer key. No invite.

```bash
# Unpaid. Proves the 402 contract. Spends 0 XRP.
npx --package=@sluzen/sdk sluzen-handshake check
# or: npx --package=@sluzen/sdk sluzen-handshake check --api https://api.sluzen.network --path /api/v1/investor-demo

# Pays the route price + ledger fee, then verifyBuyerPayment on your XRPL_NODE.
# Exit 0 only if HTTP 2xx and verdict.ok.
npx --package=@sluzen/sdk sluzen-handshake pay
```

| Flag / env | Default / note |
|------------|----------------|
| `--api` / `SLUZEN_API_URL` | `https://api.sluzen.network` |
| `--path` / `SLUZEN_HANDSHAKE_PATH` | `/api/v1/investor-demo` |
| `XRPL_NODE` | Required for `pay` only |
| `CLIENT_WALLET_SEED` or `DEMO_CLIENT_SEED` | Required for `pay` only; never printed |

`pay` spends XRP. Run `check` first. After settle, the kit calls [`verifyBuyerPayment`](#buyer-verify) against your node; it does not trust `PAYMENT-RESPONSE` alone. Facilitator resources are a different door ([/legal#trust](https://sluzen.network/legal#trust)).

## Buyer verify

`verifyBuyerPayment` reads the Payment from **your** `XRPL_NODE`. It does not call Sluzen HTTP and does not trust the seller body or `PAYMENT-RESPONSE` alone. Opt in after `AgentClient.request`; it is not run automatically.

Use `response.paymentResponse` as `txHash`, or the signed blob if you kept it. `expect` comes from `response.challenge` (or the decoded 402): `destination`, `amount` as `minAmountDrops`, `nonce`, plus your payer classic address. `callId` joins HTTP telemetry only; the memo nonce joins the ledger.

```typescript
import { AgentClient, verifyBuyerPayment } from "@sluzen/sdk";

const client = new AgentClient({ baseUrl: "https://api.sluzen.network" });
const response = await client.request("/api/v1/harbor");
const challenge = response.challenge!;
const verdict = await verifyBuyerPayment({
  txHash: response.paymentResponse!, // or txBlob: signedBlob
  expect: {
    destination: challenge.destination,
    minAmountDrops: challenge.amount,
    nonce: challenge.nonce,
    payer: yourClassicAddress,
  },
});
if (!verdict.ok) {
  // cause: not_validated | nonce_mismatch | amount_too_low | …
}
```

`decodeSignedPayment(txBlob)` is offline (hash, account, destination, drops, nonce). Causes on failure include `invalid_tx_blob`, `not_payment`, `iou_not_supported`, `missing_nonce`, `nonce_mismatch`, `destination_mismatch`, `payer_mismatch`, `amount_too_low`, `partial_payment`, `not_validated`, `not_success`, `tx_not_found`, `node_error`.

## Issuer server: facilitator

Use these three functions. A hand-written `fetch` to `/facilitator/settle` can charge a failed handler or return the body before the ledger confirms.

`facilitatorChallenge` asks Sluzen for the 402. It does not fetch your resource and it does not settle.

`facilitatorVerify` checks the signed payment. It does not consume the challenge and it does not submit.

`facilitatorSettle` runs your handler, then submits once. It returns `body` only when settle succeeds (`success: true`, `network: "XRPL"`). If the handler throws, it does not submit. The handler value is not sent to Sluzen. No issuer key and no wallet seed.

```typescript
import {
  facilitatorChallenge,
  facilitatorSettle,
  facilitatorVerify,
} from "@sluzen/sdk";

const apiBase = "https://api.sluzen.network";
const resource = "https://issuer.example/v1/tide";

const challenge = await facilitatorChallenge({ apiBase, resource });
// Unpaid response: HTTP 402 and header PAYMENT-REQUIRED = challenge.paymentRequired

const verified = await facilitatorVerify({
  apiBase,
  resource,
  paymentSignature,
});
if (!verified.isValid) {
  // HTTP 402. Do not run the handler. Do not settle.
}

const settled = await facilitatorSettle({
  apiBase,
  resource,
  paymentSignature,
  handler: () => yourHandler(request),
});
// HTTP 200 with settled.body, only after settle succeeds.
```

The pasteable server handler is on the issuer console after you price the https resource.

## Announced routes

`listAnnouncedRoutes` reads proxy routes an issuer chose to announce. It does not take a wallet seed. Facilitator resources are not in that list. The price that binds is still the 402 challenge, not the number in the list.

```typescript
import { listAnnouncedRoutes } from "@sluzen/sdk";

const routes = await listAnnouncedRoutes({
  baseUrl: "https://api.sluzen.network",
});
```

## License

ISC

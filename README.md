# Verdict

Evidence verification and merchant-approved dispute actions for PayPal merchants.

Verdict connects buyer evidence, shipment references, order snapshots, and transaction records so a merchant can understand a refund request before acting. It separates risk signals from missing evidence, explains its recommendation, and requires merchant confirmation before executing an action. AI extracts structured observations; deterministic rules produce the recommendation.

The runnable Next.js application is in [`verdict/`](verdict/). [中文开发与运行说明](verdict/README.md) · [Demo script and recording plan](verdict/docs/DEMO.md) · [Submission copy and release checklist](verdict/docs/SUBMISSION.md).

## Run the judge demo

Use Node.js **22.13 or later** and npm on a desktop computer. No PayPal account, AI key, payment, or cloud deployment is required for the offline demo.

From the repository root:

```bash
cd verdict
npm ci
npm run demo
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). On the first visit, the server terminal prints a one-time `/setup?token=...` link. Open that link and create a merchant owner with a name, email, and password of at least 10 characters. The account is local; no email is sent. If the login page says there is no account, use the link in the **server terminal**, not the login form.

`npm run demo` starts a fresh isolated data directory each time and disables external PayPal and AI calls, even if `.env.local` already contains credentials. Stop with Ctrl+C and restart to get a clean set of 18 cases. Ordinary development data in `verdict/.data/` is preserved. To use another local port, run `DEMO_PORT=3001 npm run demo` (macOS/Linux), or set `DEMO_PORT` in your shell.

For a production build of the same demo:

```bash
npm run build
npm run demo -- --production
```

Use `npm run dev` for ordinary persistent development or the optional integrations below. That command uses `.data/` and honors `.env.local`; the isolated demo command deliberately does neither.

## A two-minute walkthrough

These labels identify the relevant controls and cases:

| Task | Labels to click | Expected result |
| --- | --- | --- |
| Review a legitimate request | Claims → Genuine damage | Low risk, matching shipment identity, suggested refund |
| Confirm an action | Recommended refund button → Confirm | Local simulated refund succeeds; the case closes; an audit entry identifies the confirmation |
| Inspect reused evidence | Claims → Photo reused from another order | High risk; under Findings, local perceptual hashing shows this claim's photo beside the earlier order's photo with the hash distance |
| Review an existing PayPal dispute | Claims → Not received, but delivered | A medium-risk recommendation to submit fulfillment evidence, rather than assume delivery proves receipt |
| Submit dispute evidence | Recommended evidence button → Confirm | The simulator records the evidence and generated report PDF; success is shown |
| Export a report | Verification report → Download PDF or Preview PayPal version | Merchant and PayPal-facing report variants |
| Try the buyer flow | Orders & references → an order → Create claim link → Open buyer page | An order-bound buyer page with problem types, required shots, challenge codes, and submission |

On each claim page, the right column shows the verdict, the R score on a scale centered at zero (negative: evidence supports the claim; positive: evidence contradicts it; ticks mark the medium and high thresholds), and the recommended action. Hard rules and evidence sufficiency can also set the level, so it is not read from R alone.

You can open the buyer link in a separate private window without a merchant login. If you cannot take photos, use "Can't take photos now? Submit what you have", add a description, and submit. A new claim without enough evidence remains insufficient; it does not inherit a prepared case's recommendation.

## What runs and what is replayed

| Component | Demo behavior |
| --- | --- |
| Rules, R/Q/M scores, explanation and audit trail | Executed locally |
| Image provenance | Byte-level presence checks for C2PA/AIGC markers; signatures are **not** verified |
| Image reuse | Local 256-bit perceptual hashing against this merchant's evidence history |
| Visual observations and AI detector outputs in the 18 prepared cases | Recorded fixtures, labeled Recorded replay; the pictures are generated illustrations |
| PayPal actions in prepared cases | Local simulator; no real money moves |
| Shipping facts | Simulated; no live carrier integration |
| Newly uploaded images without AI configuration | Local checks run; unavailable model checks are disclosed and the report marks verification incomplete |
| AI-generated report writing | Reports and action drafts use deterministic templates |

The synthetic cases exercise the product workflow; they are not an independent benchmark of AI accuracy. Risk scores are weighted signal scores, not fraud probabilities. A suspicious result is a reason for merchant review, not proof that the buyer committed fraud.

## Optional PayPal sandbox integration

The sandbox adapter uses OAuth, Orders v2, Payments v2 refunds, and Customer Disputes APIs. It supports checkout/capture, dispute synchronization, messages, evidence, offers, and follow-up actions. Only sandbox endpoints are supported; `PAYPAL_ENV=live` is rejected. Prepared cases always use the local simulator.

1. Create a sandbox merchant app at [PayPal Developer](https://developer.paypal.com/) and enable Customer Disputes. Have a sandbox Business merchant and Personal buyer.
2. Copy `verdict/.env.example` to `verdict/.env.local` and set:

   ```dotenv
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-secret
   ```

3. Run `npm run dev`. Open Settings → PayPal → Check connection.
4. In Orders & references, create a sandbox test order and complete checkout with the sandbox buyer. The previous development notes recommend the sandbox Visa funding source; pending eCheck payments can restrict the available dispute/refund actions.
5. Open a nonreceipt or significantly-not-as-described dispute in the [sandbox buyer dashboard](https://www.sandbox.paypal.com/disputes/dashboard/). Return to Verdict and sync it. Sandbox state changes may take several minutes; do not depend on creating a new dispute during a short recording.
6. Act only on the controls currently allowed by PayPal. A result marked unknown requires reconciliation before another action; the application does not blindly retry a potentially completed dispute action.

Polling runs every minute. Webhooks are optional for local use and require a reachable HTTPS endpoint and `PAYPAL_WEBHOOK_ID`. The November 10 preflight verified sandbox OAuth, required scopes, and dispute reads. The detailed Chinese README separately records earlier sandbox write tests; those writes were not repeated in this check. Use your own sandbox credentials; no shared credentials or secrets are shipped.

## Optional AI vision integration

In `.env.local`, set `LLM_PROVIDER=anthropic` and `LLM_API_KEY`, optionally `LLM_MODEL`, then use `npm run dev`. Newly uploaded evidence images are sent to Anthropic for structured extraction, such as counts, serial numbers, visible damage, and screenshot text. Buyer submission discloses this processor. This adapter's default model is `claude-opus-5-5` with server-side fallback enabled; the live path has **not been verified in this preflight**. Do not interpret fixture results as live model validation. Independent synthetic-image detector services and SynthID are not connected.

## PDF and video prerequisites

- PDF export embeds a Chinese font. macOS generally provides a supported font. On Debian/Ubuntu, install `fonts-noto-cjk`, or set `VERDICT_REPORT_FONT` to a supported local font; TTC collections also need `VERDICT_REPORT_FONT_FAMILY`. Without a font, export gives a clear 503 response and evidence submission can continue without the PDF.
- Video extraction needs `ffmpeg` and `ffprobe` on PATH, or `FFMPEG_PATH` and `FFPROBE_PATH`. Video files can still be retained without them, but frame-dependent checks are disclosed as unavailable. This is optional for the image-only walkthrough.
- The desktop buyer camera works on localhost. A physical phone needs a reachable HTTPS URL; `npm run dev:phone` is the experimental local HTTPS option. Physical-phone capture has not been verified in this check.

## Validation

Run inside `verdict/`:

```bash
npm test
npm run typecheck
npm run build
npm run eval
```

The November 11, 2026 check passed 320 tests in 13 files, type checking, and a production build. On the 18 synthetic tuning cases, legitimate-case flags were 0/7; four image transformations preserved the grade in 15/16 applicable cases each. These are regression results, not measured real-world fraud performance. [Remaining submission steps](verdict/docs/SUBMISSION.md#release-checklist).

## Scope and license

This is a single-merchant, single-process MVP using Next.js, React, TypeScript, Node's SQLite, local files, sharp, PDFKit, and optional ffmpeg. It does not include production PayPal support, multi-merchant isolation, live carrier data, or calibrated real-world fraud detection.

Source code is under the [MIT License](LICENSE). Dependencies retain their own licenses. No hosted demo URL is currently supplied; the local setup above is the functional demo path.

# Verdict submission copy

English copy for the submission form. The release checklist below must be completed before submitting; the presence of these drafts does not mean the repository or video has been published.

## Project name

Verdict

## Tagline

Evidence verification and merchant-approved dispute handling for PayPal sellers.

## Inspiration

A refund request can include a convincing photo without establishing what happened to this order. The image may have been edited, reused from another transaction, or paired with an inaccurate description. Sellers can also make mistakes: a shipment can contain the wrong item, a tracking number can be unrelated, or a product description can change after purchase.

Verdict helps a PayPal merchant review those possibilities with evidence, rather than rely on a single image score.

## What it does

Verdict provides a buyer claim page, a merchant console, explainable verification reports, and a merchant-approved path to PayPal actions.

Buyers receive signed, order-bound links and guided shot lists with one-time challenge codes. Merchants can compare submissions against shipment reference photos, serial numbers, order snapshots, messages, and available logistics records. The application distinguishes suspicious evidence from insufficient evidence and shows why a recommendation was made.

A merchant can review a draft, inspect the amount and attachments, and confirm the next action. The sandbox adapter supports refunds, dispute messages, fulfillment evidence, offers and follow-up operations. Action outcomes and confirmations are recorded, and ambiguous results block further actions until reconciled.

## How it was built

The MVP uses Next.js App Router, React, TypeScript, Node's built-in SQLite, local file storage, sharp for image processing, PDFKit for reports, and optional ffmpeg for video frame extraction.

Nine analyzer modules contribute structured signals. Local components scan provenance markers, compare image hashes with merchant evidence history, and cross-check records. An optional Anthropic vision adapter extracts attributes such as counts, serial numbers, screenshot text and visible damage. A deterministic engine combines the signals into risk, evidence-confidence and merchant-risk scores, findings, and suggested actions.

PayPal is integrated through sandbox OAuth, Orders v2, Payments v2, and Customer Disputes APIs. Analysis does not call payment write operations directly; the action executor validates the merchant's confirmation, permissions, current verdict and available PayPal operations.

## Challenges

Image authenticity is different from proving an order-level claim. Missing metadata does not establish authenticity, a delivery scan does not prove the buyer personally received the parcel, and a serial-number mismatch can indicate a merchant fulfillment error.

Another challenge is action uncertainty. A network timeout can occur after a dispute action has already reached PayPal. Verdict records uncertain results and requires reconciliation instead of blindly repeating the action.

## Accomplishments

The application connects evidence intake, verification, explanations, report generation and confirmed actions in one runnable prototype. The current local check passed 320 automated tests across 13 files, type checking, and a production build. Browser checks covered all 18 prepared cases, simulated refund confirmation and replay protection, report export, simulated dispute evidence submission, and a separate mobile buyer submission.

The sandbox connection check also verified OAuth, the required scopes, and reading disputes. Those checks do not imply that every sandbox write or live AI path was exercised in this preflight.

## What was learned

The most useful explanation identifies what a piece of evidence can prove, what it cannot prove, and what additional evidence would help. Combining order records and image observations makes the next step more concrete than an unexplained fraud score.

## What's next

Validate live vision against independently labeled samples, calibrate the local matching and decision thresholds, connect carrier records, and complete the remaining sandbox follow-up tests before a merchant pilot. Shared storage, durable jobs and merchant isolation are further work beyond this single-merchant MVP.

## Tools and AI disclosure

- **PayPal:** sandbox OAuth; Orders v2 creation and capture; Payments v2 refunds; Customer Disputes synchronization and merchant-confirmed actions. Production endpoints are not supported.
- **Anthropic SDK:** optional structured vision extraction for newly uploaded evidence. No live model call was verified in the current preflight.
- **Prepared demo cases:** generated illustrations with recorded visual and detector outputs, labeled in the interface. Local matching, provenance presence checks and the rules still run. The demo launcher uses a local PayPal simulator.
- **Reports and action drafts:** deterministic templates. External synthetic-image detectors, SynthID, reverse image search and live carrier services are not connected.
- **Development tools:** add only the coding tools you actually used. Do not list a sponsor tool merely because it appeared on the hackathon website.

## Testing instructions for the form

Clone the public repository, run `cd verdict`, `npm ci`, then `npm run demo` with Node.js 22.13 or later. Open `http://127.0.0.1:3000` and use the one-time link printed by the server to create a local owner. No external account, API key or payment is needed for this offline walkthrough. Follow the English walkthrough and Chinese label translations in the root README. Each launch starts fresh isolated practice data. Optional sandbox and AI configuration instructions are also in the root README.

## Release checklist

Official requirements were checked on November 10, 2026. Submission closes **November 12, 2026 at 12:00 p.m. Pacific / 2:00 p.m. America/Chicago (CST)**. Use the official site if the schedule changes. [Requirements](https://paypalaihackathon.devpost.com/) · [Official rules](https://paypalaihackathon.devpost.com/rules).

- [ ] Commit and push the reviewed version, then merge it into `main`. On November 11 the working branch was five commits ahead of its remote, with uncommitted changes including the interface redesign, the root `README.md` and `LICENSE`; `origin/main` still held only the initial commit. Verify the final branch and remote state again.
- [ ] Make the intended submission repository public after reviewing its files and history. It was private when checked on November 11. A scan of tracked files and history found no credentials. The tracked `review-work/` folder (an unpacked copy of the development document, with a local file path in `state.json`) is not part of the product; decide whether to remove it before publishing. Ensure the submitted URL opens without signing in and that the default branch contains this build and its root README.
- [ ] Ensure the root MIT `LICENSE` is present on the submitted branch and GitHub recognizes the license.
- [ ] Run the root README instructions from a fresh checkout on the submitted branch. Include Chinese fonts for PDF if the judge platform lacks them; video extraction is optional for the image walkthrough.
- [ ] Paste the English description and accurate tool disclosures into the form. The Chinese development document is supplemental; the root README and walkthrough supply the English testing instructions.
- [ ] Record the functioning app using the English script, or provide an English translation/captions. Verify that shown results match the simulator/sandbox labels. Do not describe replayed observations as a live AI inference.
- [ ] Upload a video under three minutes to YouTube with **public** visibility, paste its URL into the submission, and test it signed out. A video has not been recorded or uploaded as part of this preparation.
- [ ] Enter the repository link and either the runnable setup instructions or a functioning hosted demo link. Do not invent a deployment URL.
- [ ] Keep the submitted build available through the judging period, which the current rules list as ending December 15, 2026.
- [ ] Check all required Devpost fields and submit before the deadline; a saved draft is not a submitted entry.

## Short project description

Verdict helps PayPal merchants verify refund and dispute evidence before acting. It combines guided buyer submissions, local image reuse checks, order and shipment comparisons, an optional AI vision adapter, and explainable rules. Merchants review the evidence and confirm actions; reports and action outcomes stay in an audit trail. The runnable offline demo uses clearly labeled synthetic cases, recorded model observations, and simulated PayPal calls. A separate sandbox adapter connects the workflow to PayPal checkout, refunds, synchronization and dispute APIs.

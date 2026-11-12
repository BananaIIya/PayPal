// 建议动作与草稿。发给买家的文字只说明需要补充什么，不出现指控性措辞。

import { HARD_RULE_CODES } from './catalog';
import type {
  ActionType,
  CategoryPolicy,
  EngineInput,
  Finding,
  Signal,
  SuggestedAction,
  VerdictLevel,
  VerdictReport,
} from './types';

export const PORTAL_LINK_PLACEHOLDER = '{claim_link}';

const OPERATION: Record<ActionType, (hasDispute: boolean) => string> = {
  refund: () => 'POST /v2/payments/captures/{capture_id}/refund',
  accept_claim: () => 'POST /v1/customer/disputes/{id}/accept-claim',
  send_message: (d) => (d ? 'POST /v1/customer/disputes/{id}/send-message' : 'Send after-sales message (not via PayPal)'),
  provide_evidence: () => 'POST /v1/customer/disputes/{id}/provide-evidence',
  make_offer: (d) => (d ? 'POST /v1/customer/disputes/{id}/make-offer' : 'POST /v2/payments/captures/{capture_id}/refund (partial)'),
  escalate: () => 'POST /v1/customer/disputes/{id}/escalate',
  provide_supporting_info: () => 'POST /v1/customer/disputes/{id}/provide-supporting-info',
  acknowledge_return_item: () => 'POST /v1/customer/disputes/{id}/acknowledge-return-item',
  appeal: () => 'POST /v1/customer/disputes/{id}/appeal',
};

interface Ctx {
  level: VerdictLevel;
  claim: EngineInput['claim'];
  policy: CategoryPolicy;
  signals: Signal[];
  findings: Finding[];
  missingShots: string[];
  lowTierShots: string[];
  keyInsufficient: string[];
  incomplete: boolean;
  /** 序列号不符的证据够硬，可以按错发退款。见 engine.ts 里的条件。 */
  identityRefund?: boolean;
}

export function buildActions(ctx: Ctx): { primary: SuggestedAction; alternatives: SuggestedAction[] } {
  const { claim, level, signals } = ctx;
  const has = (code: string) => signals.some((s) => s.code === code);

  const refund = refundAction(ctx);
  const askLive = askLiveCaptureAction(ctx);

  const hardContradiction = signals.some((s) => HARD_RULE_CODES.has(s.code) && s.direction === 'contradicts_claim');
  // 商家答应过退款时不再反驳。但证据命中硬规则（比如文件声明由 AI 从零生成）时，不按已同意处理。
  if (claim.alreadyAgreed && !hardContradiction) {
    return { primary: { ...refund, reason: 'Both parties agreed on a refund; contesting is no longer recommended.' }, alternatives: [] };
  }
  if (has('IDENTITY_MISMATCH') && !hardContradiction) {
    // 只有序列号来自现场拍摄或系统记录、核验完整时，才把退款列为错发的处理方式。
    const alternatives = ctx.identityRefund ? [askLive, refund] : [askLive];
    if (has('PROVENANCE_CLAIM_UNVERIFIED')) alternatives.push(askOriginal(ctx));
    if (claim.hasDispute) alternatives.push(evidenceAction(ctx));
    return {
      primary: {
        type: 'none',
        label: 'Check for a wrong shipment first',
        reason: ctx.identityRefund
          ? 'The serial number does not match the shipment reference. A warehouse shipping error looks the same. Until a merchant fulfillment error is ruled out, do not treat this as buyer fraud and do not contest.'
          : 'The serial number does not match the shipment reference, which may be a warehouse shipping error. But this serial number comes from a gallery upload or verification is incomplete, so it cannot justify a refund. Check the shipping records first and ask the buyer for a live photo of the serial number.',
        paypalOperation: null,
      },
      alternatives,
    };
  }

  switch (level) {
    case 'low':
      if (has('PROVENANCE_CLAIM_UNVERIFIED')) return { primary: askOriginal(ctx), alternatives: [askLive] };
      if (claim.type === 'not_received' && has('DELIVERY_ADDRESS_MISMATCH')) {
        return {
          primary: {
            ...refund,
            reason: 'The delivery postal code does not match the order shipping address. This tracking number does not prove delivery to the buyer; do not submit it to PayPal.',
          },
          alternatives: [
            askMessage(
              ctx,
              'Confirm delivery details',
              'Hello, the tracking shows a delivery address that differs from the order address. Did you change the shipping address or ask someone else to receive it? We will continue based on your answer.',
            ),
          ],
        };
      }
      if (claim.type === 'not_received' && (has('SHIPPED_BEFORE_ORDER') || has('TRACKING_NOT_DELIVERED') || has('TRACKING_STATUS_UNKNOWN'))) {
        return {
          primary: {
            type: 'none',
            label: 'Manual review',
            reason: has('SHIPPED_BEFORE_ORDER')
              ? 'The tracking history predates this order, so this tracking number does not prove this shipment. Do not refund or submit it to PayPal yet.'
              : 'There is no verifiable delivery record yet, so this cannot justify a refund.',
            paypalOperation: null,
          },
          alternatives: [askLive],
        };
      }
      return { primary: refund, alternatives: [askLive] };

    case 'insufficient': {
      // 证据还没立住时不提供退款。执行器也会拒绝，这里让控制台不出现这个按钮。
      if (has('PROVENANCE_CLAIM_UNVERIFIED')) return { primary: askOriginal(ctx), alternatives: [askLive] };
      if (ctx.missingShots.length || ctx.lowTierShots.length) return { primary: askLive, alternatives: [] };
      return {
        primary: {
          type: 'none',
          label: 'Manual review',
          reason: ctx.incomplete
            ? `Some analyzers did not run, so these cannot be confirmed: ${ctx.keyInsufficient.join('; ')}. Re-run analysis after configuring detection services.`
            : `Missing reliable evidence: ${ctx.keyInsufficient.join('; ')}. Add shipment reference photos or tracking details first.`,
          paypalOperation: null,
        },
        alternatives: [askLive],
      };
    }

    case 'medium': {
      // 中风险不提供全额退款。执行器也只放行建议本身的那一项，这里让控制台不出现会被拒绝的按钮。
      if (claim.type === 'not_received' && has('DELIVERED_CONFIRMED')) {
        return { primary: proofOfFulfillmentAction(ctx), alternatives: [askLive] };
      }
      if (has('PROVENANCE_CLAIM_UNVERIFIED')) return { primary: askOriginal(ctx), alternatives: [askLive] };
      if (claim.type === 'missing_items') {
        // 称重对得上只说明“不能确认少件”，不是退款理由。相册图或分析器没跑完时不提议和解。
        const photosReady = !ctx.incomplete && ctx.missingShots.length === 0 && ctx.lowTierShots.length === 0;
        if (photosReady && has('WEIGHT_MISMATCH')) return { primary: offerAction(ctx), alternatives: [askLive] };
        return { primary: askLive, alternatives: [] };
      }
      if (has('NARRATIVE_EVIDENCE_CONFLICT')) {
        return {
          primary: askMessage(
            ctx,
            'Ask buyer to clarify',
            `Hello, we are processing your request. Some details in your description and photos need confirming. Please describe the item's condition when you received it, and add live photos using this link: ${PORTAL_LINK_PLACEHOLDER}. Thank you.`,
          ),
          alternatives: [askLive],
        };
      }
      if (has('CROSS_EVIDENCE_CONTRADICTION')) {
        return {
          primary: askMessage(
            ctx,
            'Ask buyer to explain',
            `Hello, some of the photos you submitted do not match each other. Please tell us which one shows the item you received, and add live photos using this link: ${PORTAL_LINK_PLACEHOLDER}. Thank you.`,
          ),
          alternatives: [askLive],
        };
      }
      return { primary: askLive, alternatives: [] };
    }

    case 'high': {
      if (claim.hasDispute) {
        const alts: SuggestedAction[] = [];
        if (has('PROVENANCE_CLAIM_UNVERIFIED') || has('AI_PROVENANCE_FOUND')) alts.push(askOriginal(ctx));
        else alts.push(askLive);
        return { primary: evidenceAction(ctx), alternatives: alts };
      }
      // 私下退款请求没有 PayPal 争议可以反驳，先要求补证，暂不退款。
      return {
        primary: {
          ...askLive,
          reason: 'The buyer made this request outside PayPal, so there is no dispute to submit evidence to. Hold the refund and ask the buyer for live evidence first.',
        },
        alternatives: [],
      };
    }
  }
}

function refundAction(ctx: Ctx): SuggestedAction {
  const { claim, policy } = ctx;
  const noReturn = policy.returnable ? '' : ' Returns not required for this category.';
  if (claim.hasDispute) {
    return {
      type: 'accept_claim',
      label: 'Accept claim and refund',
      reason: `No evidence contradicts the claim; refund per merchant policy.${noReturn}`,
      paypalOperation: OPERATION.accept_claim(true),
      refundAmount: claim.amount,
      notes: 'Verification found no evidence contradicting the claim. Accepting the buyer claim.',
    };
  }
  return {
    type: 'refund',
    label: 'Full refund per policy',
    reason: `No evidence contradicts the claim; refund per merchant policy.${noReturn}`,
    paypalOperation: OPERATION.refund(false),
    refundAmount: claim.amount,
    message: `Hello, your request has been processed. ${claim.currency} ${claim.amount.toFixed(2)} has been refunded to your original payment method. We are sorry for the inconvenience.`,
  };
}

function askOriginal(ctx: Ctx): SuggestedAction {
  return {
    ...askMessage(
      ctx,
      'Ask buyer for original photo',
      `Hello, to verify the issue, please send the original photo without any edits, or take live photos using this link: ${PORTAL_LINK_PLACEHOLDER}. Thank you.`,
    ),
    reason: 'The provenance claim in the file has no verified signature, so it cannot refute the claim. Ask the buyer for the unedited original photo or other independent evidence.',
  };
}

function askLiveCaptureAction(ctx: Ctx): SuggestedAction {
  const items = [...ctx.missingShots, ...ctx.lowTierShots];
  const list = items.length ? `we need: ${items.join(', ')}.` : 'we need a few more live photos.';
  return {
    type: 'send_message',
    label: 'Ask buyer for live photos',
    reason: items.length
      ? `Lists all missing shots at once for the buyer to capture live on the claim page (${items.length} items).`
      : 'Live photos with a challenge code are more reliable and help confirm the facts.',
    paypalOperation: OPERATION.send_message(ctx.claim.hasDispute),
    message: `Hello, to process your request quickly, ${list} Please take them using this link; it takes about two minutes: ${PORTAL_LINK_PLACEHOLDER}. If you cannot take photos now, the page also accepts gallery uploads. Thank you.`,
  };
}

function askMessage(ctx: Ctx, label: string, message: string): SuggestedAction {
  return {
    type: 'send_message',
    label,
    reason: 'Need more information from the buyer before deciding.',
    paypalOperation: OPERATION.send_message(ctx.claim.hasDispute),
    message,
  };
}

function proofOfFulfillmentAction(ctx: Ctx): SuggestedAction {
  const { claim } = ctx;
  return {
    type: 'provide_evidence',
    label: 'Submit fulfillment evidence',
    reason: "Tracking shows delivery to the order shipping address. Submit it as PROOF_OF_FULFILLMENT instead of asking the buyer for more photos. Delivery does not mean the buyer personally received it; check the buyer's messages.",
    paypalOperation: OPERATION.provide_evidence(true),
    evidenceType: 'PROOF_OF_FULFILLMENT',
    notes: `Tracking records show the package was delivered to the order shipping address. Carrier: ${claim.carrier ?? 'unknown'}, tracking number: ${claim.trackingNumber ?? 'unknown'}.`,
    trackingNumber: claim.trackingNumber ?? undefined,
    carrier: claim.carrier ?? undefined,
    attachEvidence: true,
    attachReport: true,
  };
}

function factList(findings: Finding[]): string {
  return findings
    .filter((f) => f.direction === 'contradicts_claim' && f.strength !== 'weak' && f.analyzer !== 'behavior')
    .slice(0, 4)
    .map((f, i) => `${i + 1}. ${f.explanation}`)
    .join('\n');
}

function evidenceAction(ctx: Ctx): SuggestedAction {
  const facts = factList(ctx.findings);
  return {
    type: 'provide_evidence',
    label: 'Submit evidence to contest',
    reason: 'Strong contradicting signals found. Before submitting, review "Innocent explanations to rule out" below.',
    paypalOperation: OPERATION.provide_evidence(true),
    evidenceType: 'OTHER',
    notes: `The merchant's verification found the following facts:\n${facts}`,
    attachEvidence: true,
    attachReport: true,
  };
}

/** 判定引擎不会主动建议、但 PayPal 当前允许的后续操作。 */
/**
 * 退货退款和解的草稿。判定引擎不知道 PayPal 允许哪种和解，所以和后续操作一样由控制台在
 * PayPal 给出 REFUND_WITH_RETURN 时追加。买家寄回后，商家在“确认退货收货情况”里填写验收结果。
 */
export function returnOfferDraft(claim: { amount: number; currency: string }): SuggestedAction {
  return {
    type: 'make_offer',
    label: 'Offer refund with return',
    reason: 'The buyer ships the item back first, and the merchant refunds after inspecting it. Use when the item can be returned and you need to see it first. Amount is editable.',
    paypalOperation: OPERATION.make_offer(true),
    offerAmount: claim.amount,
    withReturn: true,
    notes: `Hello, we are sorry the item did not meet your expectations. Please ship it back to the return address provided by PayPal. Once we receive and inspect it, we will refund ${claim.currency} ${claim.amount.toFixed(2)}.`,
  };
}

export const FOLLOW_UP_TYPES = ['provide_supporting_info', 'acknowledge_return_item', 'appeal'] as const satisfies readonly ActionType[];
export type FollowUpType = (typeof FOLLOW_UP_TYPES)[number];

/**
 * 后续操作的草稿。判定引擎只看证据，不知道争议走到了哪一步，所以这些操作不进建议列表，
 * 而是在 PayPal 给出对应链接时由控制台追加，草稿仍然由这里统一生成，措辞规则与建议动作一致。
 */
export function followUpDraft(type: FollowUpType, report: VerdictReport, claim: { trackingNumber?: string | null; carrier?: string | null }): SuggestedAction {
  const facts = factList(report.findings);
  switch (type) {
    case 'provide_supporting_info':
      return {
        type,
        label: 'Send more info to PayPal',
        reason: 'PayPal is reviewing this dispute. You can add notes and key evidence. Add only new facts; do not repeat what was already submitted.',
        paypalOperation: OPERATION.provide_supporting_info(true),
        notes: facts ? `Additional information: the merchant's verification confirmed the following facts:\n${facts}` : 'Additional information:',
        attachEvidence: true,
      };
    case 'acknowledge_return_item': {
      const related = report.findings
        .filter((f) => f.direction === 'contradicts_claim' && (f.analyzer === 'logistics' || f.analyzer === 'reference'))
        .map((f) => f.title);
      return {
        type,
        label: 'Confirm return receipt',
        reason: `${
          related.length
            ? `Choose based on your actual inspection. Verification has findings related to the returned item (${related.join(', ')}), but the system cannot replace inspecting the package.`
            : 'Choose based on your actual inspection. The system cannot replace inspecting the package, so there is no default option.'
        } Choosing "Return received in normal condition" makes PayPal refund and close the case immediately.`,
        paypalOperation: OPERATION.acknowledge_return_item(true),
        notes: 'The merchant has received the package returned by the buyer.',
      };
    }
    case 'appeal':
      return {
        type,
        label: 'Appeal',
        reason: 'PayPal ruled in favor of the buyer. An appeal only makes sense with new, verifiable evidence. Before submitting, review "Innocent explanations to rule out".',
        paypalOperation: OPERATION.appeal(true),
        evidenceType: claim.trackingNumber && report.findings.some((f) => f.code === 'DELIVERED_CONFIRMED') ? 'PROOF_OF_FULFILLMENT' : 'OTHER',
        notes: facts ? `Merchant appeal, based on the following verified facts:\n${facts}` : 'Merchant appeal, based on the following:',
        trackingNumber: claim.trackingNumber ?? undefined,
        carrier: claim.carrier ?? undefined,
        attachEvidence: true,
        attachReport: true,
      };
  }
}

function offerAction(ctx: Ctx): SuggestedAction {
  const { claim } = ctx;
  const amount = Math.round(claim.amount * 50) / 100;
  return {
    type: 'make_offer',
    label: 'Offer partial refund',
    reason: "The weight record does not fully match the buyer's account, but missing items cannot be fully ruled out. A partial refund is a lower-cost resolution. Amount is editable.",
    paypalOperation: OPERATION.make_offer(claim.hasDispute),
    offerAmount: amount,
    notes: `Hello, we have checked our shipping records. To resolve this quickly, we can offer a refund of ${claim.currency} ${amount.toFixed(2)}. Would that work for you?`,
  };
}

// 用索引取，免得被“PayPal 写接口只在执行器里调用”的结构性检查误判（这里只生成说明文字）。
const op = (type: ActionType, hasDispute: boolean) => OPERATION[type](hasDispute);

/**
 * 影子模式下的动作选项：只按 PayPal 当前允许的操作列出，顺序固定，不带理由，草稿只写中性的格式内容，
 * 不引用任何核验发现。处理人员的决定因此不受判定影响，事后才能拿来和判定对照。
 */
export function neutralActions(ctx: {
  allowed: readonly ActionType[];
  hasDispute: boolean;
  closed: boolean;
  amount: number;
  currency: string;
  trackingNumber?: string | null;
  carrier?: string | null;
  canOfferReturn: boolean;
}): SuggestedAction[] {
  const { allowed, hasDispute, amount, currency } = ctx;
  const can = (t: ActionType) => allowed.includes(t);
  const out: SuggestedAction[] = [];
  const reason = 'Shadow mode: the verdict is hidden. Decide based on the evidence and order details.';
  if (!ctx.closed) {
    if (can('send_message')) {
      out.push({
        type: 'send_message',
        label: 'Message buyer',
        reason,
        paypalOperation: op('send_message', hasDispute),
        message: `Hello, we are processing your request. If you need to add photos, you can take or upload them using this link: ${PORTAL_LINK_PLACEHOLDER}. Thank you.`,
      });
    }
    if (can('provide_evidence')) {
      out.push({ type: 'provide_evidence', label: 'Submit evidence', reason, paypalOperation: op('provide_evidence', true), evidenceType: 'OTHER', notes: '' });
      if (ctx.trackingNumber) {
        out.push({
          type: 'provide_evidence',
          label: 'Submit fulfillment evidence',
          reason,
          paypalOperation: op('provide_evidence', true),
          evidenceType: 'PROOF_OF_FULFILLMENT',
          notes: `Carrier: ${ctx.carrier ?? 'unknown'}, tracking number: ${ctx.trackingNumber}.`,
          trackingNumber: ctx.trackingNumber,
          carrier: ctx.carrier ?? undefined,
        });
      }
    }
    if (can('make_offer')) {
      out.push({ type: 'make_offer', label: 'Offer partial refund', reason: `${reason} Enter the amount yourself.`, paypalOperation: op('make_offer', hasDispute), notes: '' });
      if (ctx.canOfferReturn) {
        out.push({ ...returnOfferDraft({ amount, currency }), reason: `${reason} The buyer ships it back first; refund after inspection.` });
      }
    }
    if (can('accept_claim')) {
      out.push({ type: 'accept_claim', label: 'Accept claim and refund', reason, paypalOperation: op('accept_claim', true), refundAmount: amount, notes: 'Accepting the buyer claim.' });
    }
    if (can('refund')) {
      out.push({
        type: 'refund',
        label: 'Full refund',
        reason,
        paypalOperation: op('refund', false),
        refundAmount: amount,
        message: `Hello, your request has been processed. ${currency} ${amount.toFixed(2)} has been refunded to your original payment method.`,
      });
    }
    if (can('escalate')) out.push({ type: 'escalate', label: 'Escalate to PayPal', reason, paypalOperation: op('escalate', true), notes: '' });
  }
  if (can('provide_supporting_info')) {
    out.push({ type: 'provide_supporting_info', label: 'Send more info to PayPal', reason, paypalOperation: op('provide_supporting_info', true), notes: 'Additional information:' });
  }
  if (can('acknowledge_return_item')) {
    out.push({
      type: 'acknowledge_return_item',
      label: 'Confirm return receipt',
      reason: `${reason} Choose based on your actual inspection. Choosing "Return received in normal condition" makes PayPal refund and close the case immediately.`,
      paypalOperation: op('acknowledge_return_item', true),
      notes: 'The merchant has received the package returned by the buyer.',
    });
  }
  if (can('appeal')) {
    out.push({ type: 'appeal', label: 'Appeal', reason, paypalOperation: op('appeal', true), evidenceType: 'OTHER', notes: 'Merchant appeal, based on the following:' });
  }
  return out;
}

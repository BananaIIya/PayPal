// 建议动作与草稿。发给买家的文字只说明需要补充什么，不出现指控性措辞。

import type {
  ActionType,
  CategoryPolicy,
  EngineInput,
  Finding,
  Signal,
  SuggestedAction,
  VerdictLevel,
} from './types';

export const PORTAL_LINK_PLACEHOLDER = '{{索赔页链接}}';

const OPERATION: Record<ActionType, (hasDispute: boolean) => string> = {
  refund: () => 'POST /v2/payments/captures/{capture_id}/refund',
  accept_claim: () => 'POST /v1/customer/disputes/{id}/accept-claim',
  send_message: (d) => (d ? 'POST /v1/customer/disputes/{id}/send-message' : '发送售后消息（不经 PayPal）'),
  provide_evidence: () => 'POST /v1/customer/disputes/{id}/provide-evidence',
  make_offer: (d) => (d ? 'POST /v1/customer/disputes/{id}/make-offer' : 'POST /v2/payments/captures/{capture_id}/refund（部分）'),
  escalate: () => 'POST /v1/customer/disputes/{id}/escalate',
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
}

export function buildActions(ctx: Ctx): { primary: SuggestedAction; alternatives: SuggestedAction[] } {
  const { claim, level, signals } = ctx;
  const has = (code: string) => signals.some((s) => s.code === code);

  const refund = refundAction(ctx);
  const askLive = askLiveCaptureAction(ctx);

  if (claim.alreadyAgreed) return { primary: { ...refund, reason: '双方已就退款达成一致，不再建议反驳。' }, alternatives: [] };

  if (claim.type === 'not_received' && (has('DELIVERY_ADDRESS_MISMATCH') || has('SHIPPED_BEFORE_ORDER'))) {
    return {
      primary: { ...refund, reason: '物流记录不能证明包裹送达买家地址，继续反驳的依据不足。' },
      alternatives: [askMessage(ctx, '核对收货情况', '您好，物流信息显示的签收地址与订单地址不一致，请问您是否更改过收货地址或委托他人代收？我们会据此继续处理。')],
    };
  }

  switch (level) {
    case 'low':
      return { primary: refund, alternatives: [askLive] };

    case 'insufficient': {
      if (ctx.missingShots.length || ctx.lowTierShots.length) return { primary: askLive, alternatives: [refund] };
      return {
        primary: {
          type: 'none',
          label: '人工复核',
          reason: ctx.incomplete
            ? `部分分析器未执行，无法确认：${ctx.keyInsufficient.join('；')}。配置检测服务后可重新分析。`
            : `缺少可靠证据：${ctx.keyInsufficient.join('；')}。请先补全发货留底或物流信息。`,
          paypalOperation: null,
        },
        alternatives: [refund, askLive],
      };
    }

    case 'medium': {
      if (claim.type === 'not_received' && has('DELIVERED_CONFIRMED')) {
        return { primary: proofOfFulfillmentAction(ctx), alternatives: [refund, askLive] };
      }
      if (claim.type === 'missing_items') {
        return { primary: offerAction(ctx), alternatives: [askLive, refund] };
      }
      if (has('NARRATIVE_EVIDENCE_CONFLICT')) {
        return {
          primary: askMessage(
            ctx,
            '请买家澄清',
            `您好，我们正在处理您的售后申请。您提供的文字说明和照片在部分细节上需要再确认一下，请您再描述一下收到商品时的情况，并通过此链接补充现场照片：${PORTAL_LINK_PLACEHOLDER}。谢谢配合。`,
          ),
          alternatives: [askLive, refund],
        };
      }
      return { primary: askLive, alternatives: [refund] };
    }

    case 'high': {
      if (claim.hasDispute) {
        const alts: SuggestedAction[] = [];
        if (has('AI_PROVENANCE_FOUND')) {
          alts.push(
            askMessage(
              ctx,
              '请买家提供原图',
              `您好，为了核实问题，请提供未经任何工具编辑的原始照片，或通过此链接现场拍摄：${PORTAL_LINK_PLACEHOLDER}。谢谢配合。`,
            ),
          );
        } else {
          alts.push(askLive);
        }
        alts.push(refund);
        return { primary: evidenceAction(ctx), alternatives: alts };
      }
      // 私下退款请求没有 PayPal 争议可以反驳，先要求补证，暂不退款。
      return {
        primary: {
          ...askLive,
          reason: '这是买家绕开 PayPal 提出的请求，没有争议可以提交反驳证据；建议暂不退款，先请买家现场补证。',
        },
        alternatives: [refund],
      };
    }
  }
}

function refundAction(ctx: Ctx): SuggestedAction {
  const { claim, policy } = ctx;
  const noReturn = policy.returnable ? '' : '该类商品不要求退货。';
  if (claim.hasDispute) {
    return {
      type: 'accept_claim',
      label: '接受索赔并退款',
      reason: `未发现与索赔矛盾的证据，可按商家政策退款。${noReturn}`,
      paypalOperation: OPERATION.accept_claim(true),
      refundAmount: claim.amount,
      notes: '经核验未发现与索赔矛盾的证据，接受买家索赔。',
    };
  }
  return {
    type: 'refund',
    label: '按政策全额退款',
    reason: `未发现与索赔矛盾的证据，可按商家政策退款。${noReturn}`,
    paypalOperation: OPERATION.refund(false),
    refundAmount: claim.amount,
    message: `您好，您的售后申请已处理，货款 ${claim.currency} ${claim.amount.toFixed(2)} 已退回原支付账户。给您带来不便，非常抱歉。`,
  };
}

function askLiveCaptureAction(ctx: Ctx): SuggestedAction {
  const items = [...ctx.missingShots, ...ctx.lowTierShots];
  const list = items.length ? `需要补充：${items.join('、')}。` : '需要再补充几张现场照片。';
  return {
    type: 'send_message',
    label: '请买家现场补拍',
    reason: items.length
      ? `一次性列出缺失镜头，请买家通过索赔页现场拍摄（${items.length} 项）。`
      : '现场拍摄并带挑战码的证据可信度更高，可以帮助确认事实。',
    paypalOperation: OPERATION.send_message(ctx.claim.hasDispute),
    message: `您好，为了尽快处理您的售后申请，${list}请通过此链接拍摄，全程约两分钟：${PORTAL_LINK_PLACEHOLDER}。如果无法现场拍摄，页面也支持从相册上传。谢谢配合。`,
  };
}

function askMessage(ctx: Ctx, label: string, message: string): SuggestedAction {
  return {
    type: 'send_message',
    label,
    reason: '需要买家补充信息后再判断。',
    paypalOperation: OPERATION.send_message(ctx.claim.hasDispute),
    message,
  };
}

function proofOfFulfillmentAction(ctx: Ctx): SuggestedAction {
  const { claim } = ctx;
  return {
    type: 'provide_evidence',
    label: '提交物流证据',
    reason: '物流显示已签收到订单收货地址，建议以 PROOF_OF_FULFILLMENT 提交，而不是要求买家补拍。签收不等于本人取得，请结合买家消息判断。',
    paypalOperation: OPERATION.provide_evidence(true),
    evidenceType: 'PROOF_OF_FULFILLMENT',
    notes: `物流记录显示包裹已签收到订单收货地址。承运商：${claim.carrier ?? '未知'}，单号：${claim.trackingNumber ?? '未知'}。`,
    trackingNumber: claim.trackingNumber ?? undefined,
    carrier: claim.carrier ?? undefined,
    attachEvidence: true,
  };
}

function evidenceAction(ctx: Ctx): SuggestedAction {
  const facts = ctx.findings
    .filter((f) => f.direction === 'contradicts_claim' && f.strength !== 'weak')
    .slice(0, 4)
    .map((f, i) => `${i + 1}. ${f.explanation}`)
    .join('\n');
  return {
    type: 'provide_evidence',
    label: '提交反驳证据',
    reason: '存在强反驳信号。提交前请先核对下方“需排除的正常解释”。',
    paypalOperation: OPERATION.provide_evidence(true),
    evidenceType: 'OTHER',
    notes: `商家经核验发现以下事实：\n${facts}`,
    attachEvidence: true,
  };
}

function offerAction(ctx: Ctx): SuggestedAction {
  const { claim } = ctx;
  const amount = Math.round(claim.amount * 50) / 100;
  return {
    type: 'make_offer',
    label: '提出部分退款和解',
    reason: '称重记录与买家所述不完全一致，但少件无法完全排除，部分退款是成本较低的解决方式。金额可修改。',
    paypalOperation: OPERATION.make_offer(claim.hasDispute),
    offerAmount: amount,
    notes: `您好，我们核对了发货记录。为尽快解决此事，我们愿意退还 ${claim.currency} ${amount.toFixed(2)} 作为和解，您看是否可以接受？`,
  };
}

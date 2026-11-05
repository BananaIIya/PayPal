// 真实的 PayPal 沙箱客户端。请求格式对照官方 Disputes、Payments、Orders、Webhooks 文档。
// 接口地址写死，不提供环境变量覆盖：这个版本不可能连到正式环境，也就不可能动用真实资金。
import type { ActionType } from '@/core/types';
import { PayPalApiError, type DisputeView, type PayPalClient, type PayPalDocument, type PayPalWriteResult } from './client';
import { paypalConfig } from './config';

export const SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
export const SANDBOX_WEB_BASE = 'https://www.sandbox.paypal.com';

const TIMEOUT_MS = 30_000;
const DISPUTE_CACHE_MS = 15_000;
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'HUF', 'TWD']);
const REQUIRED_SCOPES = [
  'https://uri.paypal.com/services/disputes/read-seller',
  'https://uri.paypal.com/services/disputes/update-seller',
  'https://uri.paypal.com/services/payments/refund',
];

export function formatAmount(amount: number, currency: string): string {
  return amount.toFixed(ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2);
}

// 响应里只声明用到的字段。PayPal 的字段都可能缺失，所以全部可选。
interface RawMoney {
  currency_code?: string;
  value?: string;
}
interface RawLink {
  href?: string;
  rel?: string;
  method?: string;
}
interface RawDispute {
  dispute_id?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_life_cycle_stage?: string;
  seller_response_due_date?: string;
  dispute_amount?: RawMoney;
  dispute_outcome?: { outcome_code?: string };
  disputed_transactions?: {
    seller_transaction_id?: string;
    gross_amount?: RawMoney;
    buyer?: { name?: string };
    items?: { item_id?: string; item_name?: string; item_quantity?: string }[];
  }[];
  messages?: { posted_by?: string; time_posted?: string; content?: string }[];
  allowed_response_options?: {
    make_offer?: { offer_types?: string[] };
    accept_claim?: { accept_claim_types?: string[] };
  };
  links?: RawLink[];
}
export interface DisputeSummary {
  dispute_id: string;
  update_time?: string;
  reason?: string;
  status?: string;
}

function hasLink(links: RawLink[], segment: string): boolean {
  const rel = segment.replaceAll('-', '_');
  return links.some((l) => l.href?.split('?')[0].endsWith(`/${segment}`) || l.rel === rel || l.rel === segment);
}

/** 文档要求：动作必须出现在 HATEOAS 链接或 allowed_response_options 里才可执行。 */
function allowedFrom(raw: RawDispute): ActionType[] {
  const links = raw.links ?? [];
  const options = raw.allowed_response_options ?? {};
  const allowed: ActionType[] = [];
  if (hasLink(links, 'send-message')) allowed.push('send_message');
  if (hasLink(links, 'provide-evidence')) allowed.push('provide_evidence');
  if (hasLink(links, 'make-offer') || options.make_offer) allowed.push('make_offer');
  if (hasLink(links, 'accept-claim') || options.accept_claim) allowed.push('accept_claim');
  if (hasLink(links, 'escalate')) allowed.push('escalate');
  return allowed;
}

export function toDisputeView(raw: RawDispute): DisputeView {
  const links = raw.links ?? [];
  const transactions = raw.disputed_transactions ?? [];
  const first = transactions[0];
  const item = first?.items?.[0];
  const messages = (raw.messages ?? []).map((m) => ({
    postedBy: m.posted_by ?? 'UNKNOWN',
    at: m.time_posted ?? null,
    content: m.content ?? '',
  }));
  const money = raw.dispute_amount ?? first?.gross_amount;
  const amount = money?.value !== undefined ? Number(money.value) : NaN;
  return {
    id: raw.dispute_id ?? '',
    orderId: null,
    transactionIds: transactions.map((t) => t.seller_transaction_id).filter((t): t is string => !!t),
    reason: raw.reason ?? 'OTHER',
    status: raw.status ?? 'OTHER',
    stage: raw.dispute_life_cycle_stage ?? 'INQUIRY',
    dueAt: raw.seller_response_due_date ?? null,
    updatedAt: raw.update_time ?? null,
    buyerMessage: messages.find((m) => m.postedBy === 'BUYER')?.content ?? null,
    messages,
    amount: Number.isFinite(amount) ? amount : null,
    currency: money?.currency_code ?? null,
    buyerName: first?.buyer?.name ?? null,
    item: item ? { id: item.item_id ?? null, title: item.item_name ?? null, quantity: Number(item.item_quantity) || 1 } : null,
    allowedActions: allowedFrom(raw),
    offerTypes: raw.allowed_response_options?.make_offer?.offer_types ?? [],
    outcome: raw.dispute_outcome?.outcome_code ?? null,
    sandboxTools: { requireEvidence: hasLink(links, 'require-evidence'), adjudicate: hasLink(links, 'adjudicate') },
    log: [],
  };
}

interface RequestOptions {
  json?: unknown;
  /** 已经序列化好的 JSON。Webhook 验签要原样转发事件，不能经过 JSON.parse 再序列化。 */
  rawJson?: string;
  form?: FormData;
  requestId?: string;
  prefer?: 'return=representation';
  /** 服务端保证幂等的写操作（带 PayPal-Request-Id 的退款、捕获）可以安全地重试一次。 */
  safeToRetry?: boolean;
}

export interface CreatedPayPalOrder {
  id: string;
  approveUrl: string;
}

export interface CapturedPayPalOrder {
  captureId: string;
  status: string;
  buyerName: string | null;
  buyerEmail: string | null;
  address: { line1?: string; city?: string; postalCode?: string; country?: string } | null;
}

export class PayPalSandbox implements PayPalClient {
  readonly name = 'PayPal 沙箱';
  private token: { value: string; expiresAt: number; scope: string } | null = null;
  private pendingToken: Promise<{ value: string; expiresAt: number; scope: string }> | null = null;
  private disputeCache = new Map<string, { at: number; view: DisputeView | null }>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly webhookId: string | null,
  ) {}

  private async fetchToken() {
    let res: Response;
    try {
      res = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // 还没有发出业务请求，所以结果是确定的：什么都没发生。
      throw new PayPalApiError(`无法连接 PayPal 沙箱：${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 400 || res.status === 401) {
      throw new PayPalApiError('PayPal 拒绝了凭据，请检查 PAYPAL_CLIENT_ID 和 PAYPAL_CLIENT_SECRET 是否为沙箱应用的值。', { status: res.status });
    }
    if (!res.ok) throw new PayPalApiError(`获取 PayPal 令牌失败（HTTP ${res.status}）`, { status: res.status });
    const body = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
    return {
      value: body.access_token,
      // 提前一分钟过期，避免用到快失效的令牌。
      expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
      scope: body.scope ?? '',
    };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    this.token = await this.pendingToken;
    return this.token.value;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
    const canRetry = method === 'GET' || opts.safeToRetry === true;
    let attemptsLeft = canRetry ? 2 : 1;
    let refreshedToken = false;

    for (;;) {
      const token = await this.accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
      if (opts.prefer) headers.Prefer = opts.prefer;
      let body: BodyInit | undefined;
      if (opts.form) body = opts.form;
      else if (opts.rawJson !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = opts.rawJson;
      } else if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      }

      let res: Response;
      try {
        res = await fetch(`${SANDBOX_API_BASE}${path}`, { method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        attemptsLeft -= 1;
        if (attemptsLeft > 0) continue;
        throw new PayPalApiError(`PayPal 没有响应：${e instanceof Error ? e.message : String(e)}`, { indeterminate: method !== 'GET' });
      }

      // 401 说明请求没被处理，换个令牌重发是安全的。
      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.token = null;
        continue;
      }

      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;

      if (res.status >= 500) {
        attemptsLeft -= 1;
        if (attemptsLeft > 0) continue;
      }
      throw this.apiError(res.status, text, method);
    }
  }

  private apiError(status: number, text: string, method: string): PayPalApiError {
    let parsed: { name?: string; message?: string; debug_id?: string; details?: { issue?: string; description?: string }[] } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 不是 JSON，只用状态码 */
    }
    const detail = parsed.details?.[0];
    const issue = detail?.issue ?? parsed.name ?? null;
    const description = detail?.description ?? parsed.message ?? `HTTP ${status}`;
    const debug = parsed.debug_id ? `（debug_id ${parsed.debug_id}）` : '';
    return new PayPalApiError(`PayPal 返回错误 ${issue ?? status}：${description}${debug}`, {
      status,
      issue,
      debugId: parsed.debug_id ?? null,
      indeterminate: status >= 500 && method !== 'GET',
    });
  }

  private written(operation: string, requestId: string, extra: Record<string, unknown> = {}): PayPalWriteResult {
    return { simulated: false, environment: 'sandbox', operation, request_id: requestId, ...extra };
  }

  // ---------- 读 ----------

  async getDispute(id: string, opts: { fresh?: boolean } = {}): Promise<DisputeView | null> {
    const cached = this.disputeCache.get(id);
    if (!opts.fresh && cached && Date.now() - cached.at < DISPUTE_CACHE_MS) return cached.view;
    let view: DisputeView | null;
    try {
      view = toDisputeView(await this.request<RawDispute>('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`));
    } catch (e) {
      if (!(e instanceof PayPalApiError) || e.status !== 404) throw e;
      view = null;
    }
    this.disputeCache.set(id, { at: Date.now(), view });
    return view;
  }

  async listDisputes(input: { page: number; pageSize: number; updatedAfter?: string }) {
    const query = new URLSearchParams({ page: String(input.page), page_size: String(input.pageSize) });
    if (input.updatedAfter) query.set('update_time_after', input.updatedAfter);
    const body = await this.request<{ items?: DisputeSummary[]; links?: RawLink[] }>('GET', `/v1/customer/disputes?${query}`);
    return { items: body.items ?? [], hasNext: (body.links ?? []).some((l) => l.rel === 'next') };
  }

  /** 只读的连接检查：令牌、权限范围、争议列表，配置了 webhook ID 时再查 webhook。 */
  async checkConnection() {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    await this.accessToken();
    checks.push({ name: '凭据', ok: true, detail: 'PayPal 沙箱接受了这组 Client ID 和 Secret' });

    const scopes = this.token?.scope.split(' ') ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    checks.push({
      name: '应用权限',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? '已包含争议读写和退款权限'
          : `缺少 ${missing.map((s) => s.split('/services/')[1]).join('、')}。请在应用的 Features 里确认已启用 Customer disputes`,
    });

    try {
      const { items } = await this.listDisputes({ page: 1, pageSize: 1 });
      checks.push({ name: '争议接口', ok: true, detail: items.length ? '可以读取争议列表' : '可以读取争议列表（目前没有争议）' });
    } catch (e) {
      checks.push({ name: '争议接口', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    if (this.webhookId) {
      try {
        const hook = await this.request<{ url?: string; event_types?: { name?: string }[] }>(
          'GET',
          `/v1/notifications/webhooks/${encodeURIComponent(this.webhookId)}`,
        );
        const events = (hook.event_types ?? []).map((e) => e.name);
        const lacking = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'].filter(
          (name) => !events.includes(name) && !events.includes('*'),
        );
        checks.push({
          name: 'Webhook',
          ok: lacking.length === 0,
          detail: lacking.length === 0 ? `已订阅争议事件，回调地址 ${hook.url}` : `回调地址 ${hook.url}，还没有订阅 ${lacking.join('、')}`,
        });
      } catch (e) {
        checks.push({ name: 'Webhook', ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    } else {
      checks.push({ name: 'Webhook', ok: true, detail: '未配置 PAYPAL_WEBHOOK_ID，只靠定时同步拉取争议（本地开发足够）' });
    }
    return checks;
  }

  // ---------- 争议写接口 ----------

  async sendMessage(disputeId: string, message: string, requestId: string) {
    const op = `POST /v1/customer/disputes/${disputeId}/send-message`;
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/send-message`, { json: { message }, requestId });
    this.disputeCache.delete(disputeId);
    return this.written(op, requestId);
  }

  async provideEvidence(
    disputeId: string,
    input: { evidenceType: string; notes: string; documents: PayPalDocument[]; trackingNumber?: string; carrier?: string },
    requestId: string,
  ) {
    const evidence: Record<string, unknown> = { evidence_type: input.evidenceType, notes: input.notes };
    if (input.documents.length) evidence.documents = input.documents.map((d) => ({ name: d.name }));
    if (input.trackingNumber) {
      evidence.evidence_info = { tracking_info: [{ ...carrierFields(input.carrier), tracking_number: input.trackingNumber }] };
    }
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences: [evidence] })], { type: 'application/json' }));
    input.documents.forEach((d, i) => {
      form.append(`file${i + 1}`, new Blob([new Uint8Array(d.data)], { type: d.mime }), d.name);
    });
    const op = `POST /v1/customer/disputes/${disputeId}/provide-evidence`;
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, { form, requestId });
    this.disputeCache.delete(disputeId);
    return this.written(op, requestId, { documents: input.documents.map((d) => d.name) });
  }

  async makeOffer(disputeId: string, input: { amount: number; currency: string; note: string }, requestId: string) {
    const dispute = await this.getDispute(disputeId, { fresh: true });
    const types = dispute?.offerTypes ?? [];
    // 和解金额是退款，不要求退货。PayPal 没给这个选项时不要猜，让商家去后台处理。
    if (types.length > 0 && !types.includes('REFUND')) {
      throw new PayPalApiError(`这笔争议只接受 ${types.join('、')} 类型的和解，Verdict 目前只支持 REFUND，请到 PayPal 后台处理。`);
    }
    const op = `POST /v1/customer/disputes/${disputeId}/make-offer`;
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/make-offer`, {
      json: {
        note: input.note,
        offer_type: 'REFUND',
        offer_amount: { currency_code: input.currency, value: formatAmount(input.amount, input.currency) },
      },
      requestId,
    });
    this.disputeCache.delete(disputeId);
    return this.written(op, requestId, { amount: input });
  }

  async acceptClaim(disputeId: string, note: string, requestId: string) {
    const op = `POST /v1/customer/disputes/${disputeId}/accept-claim`;
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`, { json: { note }, requestId });
    this.disputeCache.delete(disputeId);
    return this.written(op, requestId);
  }

  async escalate(disputeId: string, note: string, requestId: string) {
    const op = `POST /v1/customer/disputes/${disputeId}/escalate`;
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/escalate`, { json: { note }, requestId });
    this.disputeCache.delete(disputeId);
    return this.written(op, requestId);
  }

  // ---------- 退款 ----------

  async refundCapture(captureId: string, input: { amount: number; currency: string }, requestId: string) {
    const op = `POST /v2/payments/captures/${captureId}/refund`;
    const body = await this.request<{ id?: string; status?: string }>('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      json: { amount: { value: formatAmount(input.amount, input.currency), currency_code: input.currency } },
      requestId,
      prefer: 'return=representation',
      safeToRetry: true,
    });
    if (body.status === 'FAILED' || body.status === 'CANCELLED') {
      throw new PayPalApiError(`PayPal 退款状态为 ${body.status}，资金没有退回。`);
    }
    return this.written(op, requestId, { refund_id: body.id, status: body.status, amount: input });
  }

  // ---------- 沙箱专用的测试接口 ----------

  async requireEvidence(disputeId: string, action: 'SELLER_EVIDENCE' | 'BUYER_EVIDENCE') {
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/require-evidence`, { json: { action } });
    this.disputeCache.delete(disputeId);
  }

  async adjudicate(disputeId: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR') {
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/adjudicate`, { json: { adjudication_outcome: outcome } });
    this.disputeCache.delete(disputeId);
  }

  // ---------- 测试订单（替代文档里的 demo-shop） ----------

  async createOrder(input: {
    invoiceId: string;
    localId: string;
    title: string;
    sku: string;
    amount: number;
    currency: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<CreatedPayPalOrder> {
    const value = formatAmount(input.amount, input.currency);
    const money = { currency_code: input.currency, value };
    const body = await this.request<{ id: string; links?: RawLink[] }>('POST', '/v2/checkout/orders', {
      json: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            invoice_id: input.invoiceId,
            custom_id: input.localId,
            description: input.title,
            amount: { ...money, breakdown: { item_total: money } },
            items: [{ name: input.title, sku: input.sku, quantity: '1', unit_amount: money, category: 'PHYSICAL_GOODS' }],
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              shipping_preference: 'GET_FROM_FILE',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      },
      requestId: `create-${input.localId}`,
      prefer: 'return=representation',
      safeToRetry: true,
    });
    const approve = body.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!approve) throw new PayPalApiError('PayPal 没有返回买家付款链接。');
    if (new URL(approve).hostname !== new URL(SANDBOX_WEB_BASE).hostname) {
      throw new PayPalApiError(`PayPal 返回的付款链接不是沙箱地址：${new URL(approve).hostname}`);
    }
    return { id: body.id, approveUrl: approve };
  }

  async captureOrder(paypalOrderId: string, requestId: string): Promise<CapturedPayPalOrder> {
    const body = await this.request<{
      payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
      purchase_units?: {
        shipping?: { address?: { address_line_1?: string; admin_area_2?: string; postal_code?: string; country_code?: string } };
        payments?: { captures?: { id?: string; status?: string }[] };
      }[];
    }>('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      json: {},
      requestId,
      prefer: 'return=representation',
      safeToRetry: true,
    });
    const unit = body.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (!capture?.id) throw new PayPalApiError('PayPal 的捕获响应里没有交易 ID。');
    if (capture.status === 'DECLINED' || capture.status === 'FAILED') {
      throw new PayPalApiError(`付款没有成功，PayPal 状态为 ${capture.status}。`);
    }
    const name = [body.payer?.name?.given_name, body.payer?.name?.surname].filter(Boolean).join(' ') || null;
    const address = unit?.shipping?.address;
    return {
      captureId: capture.id,
      status: capture.status ?? 'UNKNOWN',
      buyerName: name,
      buyerEmail: body.payer?.email_address ?? null,
      address: address
        ? { line1: address.address_line_1, city: address.admin_area_2, postalCode: address.postal_code, country: address.country_code }
        : null,
    };
  }

  // ---------- Webhook ----------

  async verifyWebhook(rawBody: string, headers: { get(name: string): string | null }): Promise<boolean> {
    if (!this.webhookId) return false;
    const fields = {
      auth_algo: headers.get('paypal-auth-algo'),
      cert_url: headers.get('paypal-cert-url'),
      transmission_id: headers.get('paypal-transmission-id'),
      transmission_sig: headers.get('paypal-transmission-sig'),
      transmission_time: headers.get('paypal-transmission-time'),
    };
    if (Object.values(fields).some((v) => !v)) return false;
    try {
      JSON.parse(rawBody);
    } catch {
      return false;
    }
    // 事件要原样转发。解析后再序列化可能改变数字和字段顺序，验签就会失败。
    // 上面已确认 rawBody 是合法 JSON，拼在值的位置不会破坏外层结构。
    const head = JSON.stringify({ ...fields, webhook_id: this.webhookId });
    const body = await this.request<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
      rawJson: `${head.slice(0, -1)},"webhook_event":${rawBody}}`,
      safeToRetry: true,
    });
    return body.verification_status === 'SUCCESS';
  }
}

const KNOWN_CARRIERS: Record<string, string> = { UPS: 'UPS', USPS: 'USPS', FEDEX: 'FEDEX', DHL: 'DHL' };

function carrierFields(carrier: string | undefined) {
  const code = KNOWN_CARRIERS[(carrier ?? '').toUpperCase().replace(/[^A-Z]/g, '')];
  return code ? { carrier_name: code } : { carrier_name: 'OTHER', carrier_name_other: carrier || 'UNKNOWN' };
}

const g = globalThis as unknown as { __verdictPayPalSandbox?: { key: string; client: PayPalSandbox } };

/** 没配置沙箱时返回 null。令牌缓存在实例上，所以同一组凭据共用一个实例。 */
export function getSandboxClient(): PayPalSandbox | null {
  const cfg = paypalConfig();
  if (cfg.state !== 'ready') return null;
  const key = `${cfg.clientId}:${cfg.clientSecret}:${cfg.webhookId ?? ''}`;
  if (g.__verdictPayPalSandbox?.key !== key) {
    g.__verdictPayPalSandbox = { key, client: new PayPalSandbox(cfg.clientId, cfg.clientSecret, cfg.webhookId) };
  }
  return g.__verdictPayPalSandbox.client;
}

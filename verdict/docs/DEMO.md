# Verdict demo recording plan

Target: **100–115 seconds**, with English narration and Chinese operating notes. The submission must remain under three minutes. The prepared cases use generated illustrations, replayed model observations, and a local PayPal simulator; keep those disclosures visible. This script demonstrates the current implementation without claiming a live AI call or a live sandbox write.

## Main narration

Read only the following paragraphs. The operating notes below are not part of the voiceover.

> Refund photos are easy to fake. Even a real photo can belong to the wrong order. Verdict helps PayPal merchants check the evidence before deciding what to do.
>
> Buyers receive an order-bound claim link, with a shot list and one-time challenge codes. Merchants review that evidence alongside shipment references, order records, and a clear explanation.
>
> In this prepared damaged-mug case, the evidence supports the request. Verdict recommends a refund. I review the amount and confirm. The refund succeeds, the case closes, and the action is recorded. Nothing moves money without merchant confirmation.
>
> Now compare this request. The photo looks plausible, but local perceptual hashing finds it in another order's claim, even after editing. Verdict shows the earlier evidence and flags the mismatch for review.
>
> For a PayPal nonreceipt dispute, Verdict prepares fulfillment evidence and a report. I check the package and confirm submission. The result appears in the action history.
>
> The vision adapter supplies structured observations; deterministic rules explain the recommendation. These prepared cases replay AI outputs, and the PayPal actions shown are simulated. A separate adapter connects to PayPal's sandbox.
>
> Verdict turns scattered evidence into a reviewable decision, while keeping the merchant in control.

## Timeline and clicks

| Time | Actual screen or action | Narration cue | 操作备注 |
| --- | --- | --- | --- |
| 0:00–0:12 | Claims list (KPI strip + table) | Refund photos… | 已登录，先展示产品。停在列表顶部，让指标卡和 R 刻度列入镜。不要在视频里安装依赖或创建账号。 |
| 0:12–0:25 | Buyer claim page → order confirmation → damaged item shot list | Buyers receive… | 从一个真实生成的链接打开买家页。只展示入口；接下来明确切到 prepared case，不能暗示刚才的新索赔自动变成低风险。 |
| 0:25–0:48 | Genuine damage → verdict card and R scale → refund confirmation → success | In this prepared… | 1440×900 下右栏一屏内就有判定卡、R 刻度和红色“Full refund per policy…”按钮，不用滚动。确认框停两秒，露出 USD 48.00、收件方和模拟环境；点“Confirm”，等“Succeeded / Closed”真正出现。 |
| 0:48–1:10 | Photo reused from another order → scroll the left column to Findings → Same image appears in another claim | Now compare… | 这条发现里并排显示“This claim VD-1003”和“Past evidence VD-1001”两张图，中间是感知哈希差异；停两秒让画面读得清。R 低于高风险阈值而等级是高风险，因为图片复用是硬规则；被问到时这样解释。高风险是线索，不把它说成“证实买家诈骗”。该案例没有 PayPal 争议，不要在这里说能提交 PayPal 反驳。 |
| 1:10–1:29 | Not received, but delivered → evidence confirmation → success | For a PayPal… | 展示 `PROOF_OF_FULFILLMENT`、报告 PDF、物流号，确认提交后露出动作记录。这个是另一笔已有争议。 |
| 1:29–1:44 | Right column: scroll to Analyzers; Recorded replay badge on a finding; then Action history | The vision adapter… | 分析器卡片在右栏最下面，鼠标放在右栏上滚动。保留“Recorded replay”和“Simulated call”标记，左下角“Demo environment”也保持在画面里。只有真的录到沙箱调用才换成 sandbox wording。 |
| 1:44–1:50 | Merchant report / completed action | Verdict turns… | 结束。预留至 1:55 的操作余量。 |

If delivery is slow, remove the separate report view and finish on the action history. Do not speed-read to fit more settings, metrics, or architecture into the recording.

## Screen landmarks

The interface is Chinese with English labels on navigation and section headings, so the narration can point at them by name.

| On screen | Where | Say it as |
| --- | --- | --- |
| Claims, KPI strip, R scale column | Claims list | the claims queue |
| Verdict card, Buyer risk R scale | Claim page, right column, top | the verdict and the risk scale |
| Recommended action, red or blue button | Claim page, right column | the recommended action |
| Findings, Checks | Claim page, left column, below the evidence | the findings |
| Action history, “Simulated call” | Bottom of the action card after confirming | the audit trail |
| Demo environment | Bottom of the left navigation | simulated environment |

## Before recording

From the repository root:

```bash
cd verdict
npm ci
npm run build
npm run demo -- --production
```

1. Open `http://127.0.0.1:3000`, use the server's setup link, and create a local owner. Keep setup links, passwords, `.env.local`, and sandbox credentials out of the recording.
2. Use a 1440×900 or 1440×1000 desktop window. Below 1180 px wide the claim page switches to a single column and the walkthrough no longer fits one screen. Close unrelated tabs and notifications; use the same browser zoom throughout.
3. Open separate tabs for **Genuine damage**, **Photo reused from another order**, and **Not received, but delivered**. Locate them by title; IDs change each time the demo starts.
4. On an order, generate a buyer link. Open it in another window and stop at the order confirmation screen. Generating this extra claim does not replace any prepared case.
5. On the reuse case, find the finding titled **Same image appears in another claim**. Practice scrolling to its side-by-side comparison (This claim / Past evidence) so both images are immediately readable.
6. On the nonreceipt case, verify the primary action can submit evidence and the confirmation includes **Verification report PDF**. If PDF export is unavailable, install/configure a Chinese font before recording.
7. Practice the full run once. Then stop and restart `npm run demo -- --production` for a fresh dataset and fresh account. Regenerate the tabs and buyer link; do not record cases already closed by rehearsal.
8. Record actual interactions and visible results. Trim only waiting and navigation pauses; preserve the correct order and environment labels. No music is needed.
9. Watch the exported video with sound and check that the UI text, cursor, confirmation, and success state are legible. Add English captions if speaking Chinese. Upload the video publicly to YouTube and test the link in a signed-out window.

## Optional real sandbox clip

The main script above is for the repeatable offline demo. To replace the simulated evidence-submission segment with a sandbox segment:

- Use `npm run dev` with your own sandbox credentials and an existing **actionable** sandbox dispute. This uses persistent development data, unlike `npm run demo`.
- Confirm that the case is marked **PayPal sandbox** and that the required action is currently allowed. Prepare it before recording; new disputes and later state transitions can take minutes.
- Record the confirmation, the resulting **Sandbox call** entry, and the matching sandbox dashboard result. Only then say “This action calls the PayPal sandbox using test funds.”
- Do not label a simulator result as a sandbox result. The current preflight repeated only OAuth, permission, and dispute-read checks against the sandbox.

## One-minute fallback narration

> A refund photo can look convincing and still belong to the wrong order. Verdict helps PayPal merchants verify the evidence before acting.
>
> This damaged-mug case supports a refund. I review the evidence, check the amount, and confirm. The action succeeds and stays in the audit history.
>
> In this second request, local image matching finds the photo in another order's claim. Verdict shows the comparison and asks for further review instead of treating the image as proof.
>
> For PayPal disputes, merchants can prepare and submit evidence with a verification report. This demo uses recorded AI observations and simulated PayPal actions; the project also includes a sandbox adapter.
>
> Evidence explained. Decisions confirmed by the merchant.

## 中文讲解提要

“照片看起来真”，不代表“属于这笔订单”。先用正常售后展示退款闭环，再用套图展示本地核验确实工作，最后展示争议证据和报告能进入动作执行流程。重点放在证据、理由、确认和结果；不要把小样本评估的 100% 当成模型准确率，也不要声称已经验证真实 AI 视觉调用。

## Questions to prepare for

| Question | Answer grounded in this build |
| --- | --- |
| What makes this more than an AI image detector? | It binds evidence to an order and compares it with shipment references, snapshots, messages, and logistics. Image authenticity alone does not establish the claim. |
| Where does AI make a decision? | The adapter extracts visual observations. Rules combine those observations with other signals and explain the recommendation. The merchant confirms an action. |
| What happens when a model is unavailable? | The report lists the checks that did not run and marks verification incomplete. New uploads without model configuration follow this path. |
| Are you automatically accusing buyers? | No. The product shows evidence gaps and competing explanations, including possible merchant errors. A risk label is not proof of fraud. |
| Is PayPal actually integrated? | A separate sandbox adapter implements checkout, capture, refunds, synchronization and dispute actions. This preflight verified OAuth, scopes and dispute reads; this recording's prepared cases use a simulator. |
| Are the accuracy numbers production results? | No. The 18 synthetic tuning scenarios are regression fixtures. Real-world claims need a separate labeled evaluation. |
| What is the next step? | Validate live vision on independent samples, calibrate thresholds, connect carrier records, and test the remaining sandbox follow-up flows before a merchant pilot. |

Official references: [submission requirements and judging criteria](https://paypalaihackathon.devpost.com/) · [rules, including English materials and video requirements](https://paypalaihackathon.devpost.com/rules).

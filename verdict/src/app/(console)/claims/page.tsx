import Link from 'next/link';
import { ClaimList } from '@/components/ClaimList';
import { PayPalSyncButton } from '@/components/PayPalSyncButton';
import { publicPayPalStatus } from '@/paypal/config';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { defaultMerchantId, listClaims } from '@/server/repo';
import { maskClaimList } from '@/server/shadow';

export const dynamic = 'force-dynamic';

export default async function ClaimsPage() {
  await ready();
  await pageUser();
  const { claims, shadow } = maskClaimList(defaultMerchantId(), listClaims());
  return (
    <>
      <div className="page-head">
        <div>
          <h1>索赔</h1>
          <p className="muted">
            {shadow
              ? '影子模式：判定在后台计算并存档，这里不显示。请按证据自己处理，店主事后在“影子对照”页看系统和人工决定的一致率。'
              : '默认按 PayPal 响应截止时间排序。系统只给判定和建议，每个资金动作都要你确认。'}
          </p>
        </div>
        <div className="row">
          {publicPayPalStatus().state === 'ready' && <PayPalSyncButton />}
          <Link className="btn" href="/orders">
            新建买家索赔链接
          </Link>
          <Link className="btn btn-primary" href="/claims/new">
            手动导入
          </Link>
        </div>
      </div>
      {!shadow && (
        <div className="intro">
          <div>
            <b>1. 看验收场景</b>
            <span className="muted">下面 18 笔索赔对应开发文档的验收表，点开任意一笔看判定、证据和建议动作。</span>
          </div>
          <div>
            <b>2. 走一遍买家流程</b>
            <span className="muted">
              到<Link href="/orders">订单页</Link>生成索赔链接，用摄像头现场拍摄并提交，回来看分析逐项更新。
            </span>
          </div>
          <div>
            <b>3. 试你自己的图片</b>
            <span className="muted">
              <Link href="/claims/new">手动导入</Link>一张 ChatGPT 生成的图或任意照片，本地分析器会真实运行。
            </span>
          </div>
        </div>
      )}
      <ClaimList claims={claims} shadow={shadow} />
    </>
  );
}

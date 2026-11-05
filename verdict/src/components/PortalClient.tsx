'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Shot {
  id: string;
  label: string;
  hint: string;
}
interface PortalData {
  order: { orderNo: string; product: string; quantity: number; amount: number; currency: string; addressTail: string };
  claim: { status: string; statusLabel: string; type: string; lockedType: boolean; submittedBefore: boolean };
  claimTypes: { type: string; label: string; shots: Shot[] }[];
  processors: string[];
  uploaded: { id: string; shot: string | null; source: string }[];
}
type Step = 'order' | 'type' | 'capture' | 'describe' | 'done';
const STEP_ORDER: Step[] = ['order', 'type', 'capture', 'describe', 'done'];

export function PortalClient({ token }: { token: string }) {
  const [data, setData] = useState<PortalData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('order');
  const [claimType, setClaimType] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'live' | 'album'>>({});
  const [activeShot, setActiveShot] = useState<Shot | null>(null);
  const [narrative, setNarrative] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/portal/${encodeURIComponent(token)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFatal(body.error ?? '链接无效');
      return null;
    }
    setData(body as PortalData);
    return body as PortalData;
  }, [token]);

  useEffect(() => {
    void load().then((d) => {
      if (d?.claim.lockedType) setClaimType(d.claim.type);
    });
  }, [load]);

  // 提交后的状态页：显示商家处理进度。这里的请求失败不影响买家已完成的提交，不切到错误页。
  useEffect(() => {
    if (step !== 'done') return;
    const refresh = async () => {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}`, { cache: 'no-store' });
      if (res.ok) setData((await res.json()) as PortalData);
    };
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [step, token]);

  if (fatal) {
    return (
      <div className="portal">
        <div className="portal-inner">
          <h1>无法打开这个链接</h1>
          <p className="muted">{fatal}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="portal">
        <div className="portal-inner muted">加载中…</div>
      </div>
    );
  }

  const shots = data.claimTypes.find((t) => t.type === claimType)?.shots ?? [];

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/portal/${encodeURIComponent(token)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimType, narrative }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? '提交失败，请重试');
      return;
    }
    setStep('done');
  }

  return (
    <div className="portal">
      <div className="portal-inner">
        <div className="portal-top">
          <strong>售后证据提交</strong>
          <span className="muted small">订单 {data.order.orderNo}</span>
        </div>
        <div className="steps" aria-hidden="true">
          {STEP_ORDER.slice(0, 4).map((s, i) => (
            <span key={s} className={STEP_ORDER.indexOf(step) >= i ? 'on' : ''} />
          ))}
        </div>

        {step === 'order' && (
          <>
            <h1>确认订单</h1>
            <p className="muted" style={{ marginBottom: 14 }}>
              请确认这是你要售后的订单。
            </p>
            <div className="order-box">
              <strong>
                {data.order.product}
                {data.order.quantity > 1 ? ` ×${data.order.quantity}` : ''}
              </strong>
              <div className="muted">
                订单号 {data.order.orderNo} · {data.order.currency} {data.order.amount.toFixed(2)}
              </div>
              <div className="muted">收货邮编后四位：{data.order.addressTail}</div>
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => setStep(data.claim.lockedType ? 'capture' : 'type')}>
              是这笔订单，继续
            </button>
          </>
        )}

        {step === 'type' && (
          <>
            <h1>遇到了什么问题？</h1>
            <div style={{ marginTop: 14 }}>
              {data.claimTypes.map((t) => (
                <button
                  key={t.type}
                  className="option"
                  aria-pressed={claimType === t.type}
                  onClick={() => {
                    setClaimType(t.type);
                    setStep(t.shots.length ? 'capture' : 'describe');
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'capture' && (
          <>
            <h1>拍摄照片</h1>
            <p className="muted" style={{ marginBottom: 10 }}>
              请用手机现场拍摄。每个镜头都有一个随机码，把它写在纸上放进画面，这样可以更快确认情况。
            </p>
            {shots.map((s) => (
              <div className="shot-row" key={s.id}>
                <span className={`shot-state ${done[s.id] ? 'done' : ''}`}>{done[s.id] ? '✓' : ''}</span>
                <div style={{ flex: 1 }}>
                  <strong>{s.label}</strong>
                  <div className="muted small">{done[s.id] === 'album' ? '已从相册上传' : s.hint}</div>
                </div>
                <button className="btn" onClick={() => setActiveShot(s)}>
                  {done[s.id] ? '重拍' : '开始'}
                </button>
              </div>
            ))}
            {shots.length === 0 && <p className="muted">这个问题类型不需要拍照。</p>}
            <button
              className="btn btn-primary btn-lg"
              style={{ marginTop: 16 }}
              disabled={shots.some((s) => !done[s.id])}
              onClick={() => setStep('describe')}
            >
              下一步
            </button>
            {shots.some((s) => !done[s.id]) && (
              <p className="muted small" style={{ marginTop: 8, textAlign: 'center' }}>
                还差 {shots.filter((s) => !done[s.id]).length} 个镜头
              </p>
            )}
            <div style={{ textAlign: 'center', marginTop: 10 }}>
              <button className="btn-link small" onClick={() => setStep('describe')}>
                暂时拍不了，先提交已有内容
              </button>
            </div>
          </>
        )}

        {step === 'describe' && (
          <>
            <h1>补充说明</h1>
            <label className="field" style={{ marginTop: 12 }}>
              描述一下情况（可选）
              <textarea rows={5} value={narrative} onChange={(e) => setNarrative(e.target.value)} placeholder="例如：收到时外箱一角压坏，杯身有裂纹。" />
            </label>
            <div className="order-box small">
              <strong>你的照片会如何处理</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                照片和说明会由商家及 Verdict 核验系统处理，用于判断售后申请。
                {data.processors.length > 0
                  ? ` 以下第三方也会处理这些内容：${data.processors.join('、')}。`
                  : ' 当前没有发送给任何第三方服务。'}
              </div>
            </div>
            {error && (
              <p className="notice notice-danger" style={{ marginBottom: 12 }}>
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-lg" disabled={busy} onClick={submit}>
              {busy ? '提交中…' : '提交'}
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <h1>已收到</h1>
            <p className="muted" style={{ marginBottom: 14 }}>
              商家会尽快处理，你不需要再做别的。如需补充材料，商家会联系你。
            </p>
            <div className="order-box">
              <div className="muted small">当前进度</div>
              <strong>{data.claim.statusLabel}</strong>
            </div>
          </>
        )}
      </div>

      {activeShot && (
        <CameraCapture
          token={token}
          shot={activeShot}
          onClose={() => setActiveShot(null)}
          onDone={(mode) => {
            setDone((d) => ({ ...d, [activeShot.id]: mode }));
            setActiveShot(null);
          }}
        />
      )}
    </div>
  );
}

/** 镜头还没出图时可能拍到黑帧。这只是拍摄时的提醒，不作为核验依据。 */
function isBlankFrame(video: HTMLVideoElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  const n = data.length / 4;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += luma;
    squares += luma * luma;
  }
  const mean = sum / n;
  return squares / n - mean * mean < 16;
}

function CameraCapture({
  token,
  shot,
  onClose,
  onDone,
}: {
  token: string;
  shot: Shot;
  onClose: () => void;
  onDone: (mode: 'live' | 'album') => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAt = useRef(Date.now());
  const [challenge, setChallenge] = useState<{ challengeId: string; code: string; action: string } | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('这个浏览器不支持现场拍摄，或页面不是 HTTPS。可以从相册上传。');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch {
      setCameraError('没有拿到摄像头权限，或设备没有摄像头。可以从相册上传。');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/challenges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shot: shot.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(body.error ?? '无法开始拍摄');
        return;
      }
      setChallenge(body);
      startedAt.current = Date.now();
      await startCamera();
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [token, shot.id, startCamera, stopStream]);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    if (isBlankFrame(video)) {
      setError('画面几乎是纯色，可能是镜头还没准备好。请稍等一下再拍。');
      return;
    }
    setError(null);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) setPreview({ url: URL.createObjectURL(blob), blob });
      },
      'image/jpeg',
      0.95,
    );
  }

  async function upload(file: Blob, withChallenge: boolean) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file, 'capture.jpg');
    form.append('shot', shot.id);
    if (withChallenge && challenge) {
      form.append('challengeId', challenge.challengeId);
      form.append('durationMs', String(Date.now() - startedAt.current));
    }
    const res = await fetch(`/api/portal/${encodeURIComponent(token)}/evidence`, { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? '上传失败，请重试');
      return;
    }
    stopStream();
    onDone(withChallenge ? 'live' : 'album');
  }

  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label={`拍摄：${shot.label}`}>
      <div className="camera-top">
        <div className="between">
          <strong>{shot.label}</strong>
          <button className="btn-link" style={{ color: '#fff' }} onClick={() => { stopStream(); onClose(); }}>
            关闭
          </button>
        </div>
        {challenge ? (
          <>
            <div className="small" style={{ marginTop: 6, opacity: 0.85 }}>把这串字符写在纸上放进画面：</div>
            <div className="camera-code">{challenge.code}</div>
            <div className="small">并且：{challenge.action}</div>
          </>
        ) : (
          <div className="small" style={{ marginTop: 6 }}>正在准备…</div>
        )}
      </div>

      <div className="camera-view">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview.url} alt="拍摄预览" />
        ) : (
          <video ref={videoRef} playsInline muted autoPlay />
        )}
        {cameraError && !preview && (
          <div style={{ position: 'absolute', padding: 24, textAlign: 'center' }}>
            <p style={{ marginBottom: 14 }}>{cameraError}</p>
          </div>
        )}
      </div>

      <div className="camera-bottom" style={{ flexDirection: 'column' }}>
        {error && <div className="notice notice-danger">{error}</div>}
        {preview ? (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => setPreview(null)}>
              重拍
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => upload(preview.blob, true)}>
              {busy ? '上传中…' : '使用这张'}
            </button>
          </div>
        ) : (
          <>
            {!cameraError && <button className="shutter" aria-label="拍照" onClick={capture} disabled={!challenge} />}
            <label style={{ textAlign: 'center', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', opacity: 0.9 }}>
              无法现场拍摄？从相册选择
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f, false);
                }}
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

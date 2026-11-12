'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brand } from './Brand';

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
const STEP_NAME = ['Order', 'Problem', 'Photos', 'Details'];

export function PortalClient({ token }: { token: string }) {
  const [data, setData] = useState<PortalData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('order');
  const [claimType, setClaimType] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'live' | 'album' | 'pending'>>({});
  const [activeShot, setActiveShot] = useState<Shot | null>(null);
  const [narrative, setNarrative] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/portal/${encodeURIComponent(token)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFatal(body.error ?? 'Invalid link');
      return null;
    }
    setData(body as PortalData);
    return body as PortalData;
  }, [token]);

  useEffect(() => {
    void load().then((d) => {
      if (d?.claim.lockedType) setClaimType(d.claim.type);
      // 买家中途刷新或重新打开链接时，已经上传过的镜头直接显示为完成，不用重拍。
      if (d?.uploaded.length) {
        const restored: Record<string, 'live' | 'album' | 'pending'> = {};
        for (const u of d.uploaded) {
          if (!u.shot) continue;
          restored[u.shot] = u.source === 'live_capture' ? 'live' : u.source === 'challenge_pending' ? 'pending' : 'album';
        }
        setDone((cur) => ({ ...restored, ...cur }));
      }
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
          <h1>Can't open this link</h1>
          <p className="muted">{fatal}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="portal">
        <div className="portal-inner muted">Loading…</div>
      </div>
    );
  }

  const shots = data.claimTypes.find((t) => t.type === claimType)?.shots ?? [];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimType, narrative }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Submission failed. Try again.');
        return;
      }
      setStep('done');
    } catch {
      setError('The request did not go through. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal">
      <header className="portal-bar">
        <div>
          <span className="brand">
            <Brand />
          </span>
          <span className="order-no">Claim evidence · Order {data.order.orderNo}</span>
        </div>
      </header>
      <div className="portal-inner">
        <div className="steps" aria-hidden="true">
          {STEP_ORDER.slice(0, 4).map((s, i) => (
            <span key={s} className={STEP_ORDER.indexOf(step) >= i ? 'on' : ''}>
              {STEP_NAME[i]}
            </span>
          ))}
        </div>

        {step === 'order' && (
          <>
            <h1>Confirm your order</h1>
            <p className="muted" style={{ marginBottom: 14 }}>
              Confirm this is the order you need help with.
            </p>
            <div className="order-box">
              <strong>
                {data.order.product}
                {data.order.quantity > 1 ? ` ×${data.order.quantity}` : ''}
              </strong>
              <div className="muted">
                Order {data.order.orderNo} · {data.order.currency} {data.order.amount.toFixed(2)}
              </div>
              <div className="muted">Last 4 of shipping ZIP: {data.order.addressTail}</div>
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => setStep(data.claim.lockedType ? 'capture' : 'type')}>
              Yes, this is my order
            </button>
          </>
        )}

        {step === 'type' && (
          <>
            <h1>What's the problem?</h1>
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
            <h1>Take photos</h1>
            <p className="muted" style={{ marginBottom: 10 }}>
              Take the photos live with your phone. Each shot has a challenge code: write it on paper and keep it in the frame so we can confirm things faster. You can also record a short video of up to 15 seconds.
            </p>
            <div className="shot-list">
            {shots.map((s) => (
              <div className="shot-row" key={s.id}>
                <span className={`shot-state ${done[s.id] ? 'done' : ''}`}>{done[s.id] ? '✓' : ''}</span>
                <div style={{ flex: 1 }}>
                  <strong>{s.label}</strong>
                  <div className="muted small">
                    {done[s.id] === 'album' ? 'Uploaded from gallery' : done[s.id] === 'live' ? 'Challenge code verified' : done[s.id] === 'pending' ? 'Captured, pending verification' : s.hint}
                  </div>
                </div>
                <button className="btn" onClick={() => setActiveShot(s)}>
                  {done[s.id] ? 'Retake' : 'Start'}
                </button>
              </div>
            ))}
            </div>
            {shots.length === 0 && <p className="muted">No photos needed for this problem type.</p>}
            <button
              className="btn btn-primary btn-lg"
              style={{ marginTop: 16 }}
              disabled={shots.some((s) => !done[s.id])}
              onClick={() => setStep('describe')}
            >
              Next
            </button>
            {shots.some((s) => !done[s.id]) && (
              <p className="muted small" style={{ marginTop: 8, textAlign: 'center' }}>
                {shots.filter((s) => !done[s.id]).length} {shots.filter((s) => !done[s.id]).length === 1 ? 'shot' : 'shots'} left
              </p>
            )}
            <div style={{ textAlign: 'center', marginTop: 10 }}>
              <button className="btn-link small" onClick={() => setStep('describe')}>
                Can't take photos now? Submit what you have
              </button>
            </div>
          </>
        )}

        {step === 'describe' && (
          <>
            <h1>Details</h1>
            <label className="field" style={{ marginTop: 12 }}>
              Describe what happened (optional)
              <textarea rows={5} value={narrative} onChange={(e) => setNarrative(e.target.value)} placeholder="For example: one corner of the box was crushed on arrival and the mug is cracked." />
            </label>
            <div className="order-box small">
              <strong>How your photos and videos are handled</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                Your photos, videos and description are processed by the merchant and the Verdict verification system to assess your claim.
                {data.processors.length > 0
                  ? ` These third parties also process this content: ${data.processors.join(', ')}.`
                  : ' Nothing is currently sent to any third-party service.'}
              </div>
            </div>
            {error && (
              <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-lg" disabled={busy} onClick={submit}>
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <div className="done-mark" aria-hidden="true">
              ✓
            </div>
            <h1>Received</h1>
            <p className="muted" style={{ marginBottom: 14 }}>
              The merchant will handle this soon. You don't need to do anything else. If more information is needed, the merchant will contact you.
            </p>
            <div className="order-box">
              <div className="muted small">Current status</div>
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

/** 索赔页录的短视频上限。 */
const MAX_RECORD_MS = 15_000;

/** 把视频当前画面缩成宽度不超过 maxWidth 的 JPEG data URL。 */
function snapshot(video: HTMLVideoElement, maxWidth: number): string | undefined {
  if (!video.videoWidth) return undefined;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/** 优先 MP4（Safari 和较新的 Chrome 支持，控制台各浏览器都能播），否则 WebM。 */
function recorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
}

function fileName(blob: Blob): string {
  if (blob.type.startsWith('video/')) return blob.type.includes('mp4') ? 'capture.mp4' : blob.type.includes('quicktime') ? 'capture.mov' : 'capture.webm';
  return 'capture.jpg';
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
  onDone: (mode: 'live' | 'album' | 'pending') => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAt = useRef(Date.now());
  const [challenge, setChallenge] = useState<{ challengeId: string; code: string; action: string } | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob; kind: 'image' | 'video'; poster?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [recordingMs, setRecordingMs] = useState<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canRecord = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined';

  const stopStream = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // 预览照片或视频时实时画面的 <video> 会被卸载，点“重拍/重录”后是一个新元素，要把摄像头流重新接上，否则画面全黑、快门无效。
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => undefined);
    }
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser doesn\'t support live capture, or the page isn\'t on HTTPS. You can upload from your gallery.');
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
      setCameraError('Camera permission was not granted, or the device has no camera. You can upload from your gallery.');
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
        setError(body.error ?? 'Can\'t start capture');
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
      setError('The image is almost a solid color. The camera may not be ready yet. Wait a moment and try again.');
      return;
    }
    setError(null);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) setPreview({ url: URL.createObjectURL(blob), blob, kind: 'image' });
      },
      'image/jpeg',
      0.95,
    );
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || !videoRef.current?.videoWidth) return;
    if (isBlankFrame(videoRef.current)) {
      setError('The image is almost a solid color. The camera may not be ready yet. Wait a moment and record again.');
      return;
    }
    setError(null);
    const mimeType = recorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
    } catch {
      setError('This browser can\'t record video. Take a photo instead.');
      return;
    }
    chunksRef.current = [];
    // 开录时的画面当预览封面。MediaRecorder 录的文件常常不写时长，有的浏览器在播放前只显示黑屏。
    const poster = snapshot(videoRef.current, 640);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      if (tickRef.current) clearInterval(tickRef.current);
      setRecordingMs(null);
      const blob = new Blob(chunksRef.current, { type: (recorder.mimeType || 'video/webm').split(';')[0] });
      if (blob.size) setPreview({ url: URL.createObjectURL(blob), blob, kind: 'video', poster });
    };
    recorderRef.current = recorder;
    const begin = Date.now();
    recorder.start(500);
    setRecordingMs(0);
    tickRef.current = setInterval(() => {
      const ms = Date.now() - begin;
      setRecordingMs(ms);
      if (ms >= MAX_RECORD_MS && recorder.state === 'recording') recorder.stop();
    }, 250);
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  async function upload(file: Blob, withChallenge: boolean) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file, fileName(file));
    form.append('shot', shot.id);
    if (withChallenge && challenge) {
      form.append('challengeId', challenge.challengeId);
      form.append('durationMs', String(Date.now() - startedAt.current));
    }
    const res = await fetch(`/api/portal/${encodeURIComponent(token)}/evidence`, { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? 'Upload failed. Try again.');
      return;
    }
    stopStream();
    onDone(withChallenge ? 'pending' : 'album');
  }

  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label={`Capture: ${shot.label}`}>
      <div className="camera-top">
        <div className="between">
          <strong>{shot.label}</strong>
          <button className="btn-link" style={{ color: '#fff' }} onClick={() => { stopStream(); onClose(); }}>
            Close
          </button>
        </div>
        {challenge ? (
          <>
            <div className="small" style={{ marginTop: 6, opacity: 0.85 }}>Write this code on paper and keep it in the frame:</div>
            <div className="camera-code">{challenge.code}</div>
            <div className="small">Also: {challenge.action}</div>
          </>
        ) : (
          <div className="small" style={{ marginTop: 6 }}>Getting ready…</div>
        )}
      </div>

      <div className="camera-view">
        {preview?.kind === 'video' ? (
          // key 不同，React 才不会复用实时画面那个 <video>：复用时 srcObject（摄像头流）还挂着，会盖过录好的视频。
          <video key="recorded" src={preview.url} poster={preview.poster} controls playsInline preload="auto" />
        ) : preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview.url} alt="Capture preview" />
        ) : (
          <video key="live" ref={attachVideo} playsInline muted autoPlay />
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
              {preview.kind === 'video' ? 'Re-record' : 'Retake'}
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => upload(preview.blob, true)}>
              {busy ? (preview.kind === 'video' ? 'Uploading and processing…' : 'Uploading…') : preview.kind === 'video' ? 'Use this video' : 'Use this photo'}
            </button>
          </div>
        ) : (
          <>
            {!cameraError && canRecord && recordingMs === null && (
              <div className="capture-modes" role="group" aria-label="Capture mode">
                <button aria-pressed={mode === 'photo'} onClick={() => setMode('photo')}>
                  Photo
                </button>
                <button aria-pressed={mode === 'video'} onClick={() => setMode('video')}>
                  Video
                </button>
              </div>
            )}
            {!cameraError && mode === 'photo' && <button className="shutter" aria-label="Take photo" onClick={capture} disabled={!challenge} />}
            {!cameraError && mode === 'video' && recordingMs === null && (
              <button className="shutter rec" aria-label="Start recording" onClick={startRecording} disabled={!challenge} />
            )}
            {recordingMs !== null && (
              <>
                <button className="shutter recording" aria-label="Stop recording" onClick={stopRecording} />
                <div className="rec-time" aria-live="polite">
                  Recording {Math.floor(recordingMs / 1000)} / {MAX_RECORD_MS / 1000} s. Tap the square to stop
                </div>
              </>
            )}
            <label style={{ textAlign: 'center', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', opacity: 0.9 }}>
              Can't take it live? Choose from gallery
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
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

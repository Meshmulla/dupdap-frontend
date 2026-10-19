'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Clock, CheckCircle, XCircle, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import { paymentsApi } from '@/lib/api';
import { formatUsd } from '@/lib/utils';
import type { Payment } from '@/lib/types';

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="w-8 h-8 text-yellow-500" />,
  confirmed: <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />,
  settling: <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />,
  settled: <CheckCircle className="w-8 h-8 text-green-500" />,
  failed: <XCircle className="w-8 h-8 text-red-500" />,
  expired: <XCircle className="w-8 h-8 text-gray-400" />,
};

const DEFAULT_STATUS_ICON = <Clock className="w-8 h-8 text-gray-400" />;

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24;
const POLL_MAX_BACKOFF_MS = 60_000;

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    : '');
const WS_RECONNECT_MAX_MS = 30_000;

function computeExpiresAt(payment: any): Date | null {
  if (payment?.expiresAt) return new Date(payment.expiresAt);
  if (payment?.expiryMinutes && payment?.createdAt) {
    return new Date(new Date(payment.createdAt).getTime() + payment.expiryMinutes * 60_000);
  }
  return null;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Expired';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function PayPage({ params }: { params: { paymentId: string } }) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string>('');
  const [liveConnected, setLiveConnected] = useState(false);
  const pollNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let pollAttempts = 0;
    let consecutiveFailures = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let wsReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let wsReconnectAttempts = 0;
    let wsActive = false;

    paymentsApi.getByReference(params.paymentId)
      .then(({ data }) => setPayment(data))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));

    const scheduleNext = () => {
      if (cancelled || wsActive) return;
      const backoff = Math.min(
        POLL_INTERVAL_MS * 2 ** consecutiveFailures,
        POLL_MAX_BACKOFF_MS,
      );
      timeout = setTimeout(poll, backoff);
    };

    const poll = () => {
      if (cancelled || wsActive) return;
      pollAttempts += 1;
      if (pollAttempts >= POLL_MAX_ATTEMPTS) {
        setPollWarning('Status checks are taking longer than expected.');
        return;
      }
      paymentsApi.getByReference(params.paymentId)
        .then(({ data }) => {
          consecutiveFailures = 0;
          setPollWarning('');
          setPayment(data);
          if (['settled', 'failed', 'expired'].includes(data.status)) return;
          scheduleNext();
        })
        .catch(() => {
          consecutiveFailures += 1;
          setPollWarning('We are having trouble checking your payment status right now.');
          scheduleNext();
        });
    };

    // Expose an immediate poll trigger so visibilitychange can refresh
    // without waiting for the next scheduled interval tick.
    pollNowRef.current = () => {
      if (cancelled) return;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      poll();
    };

    const stopPolling = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const connectWebSocket = () => {
      if (cancelled || !WS_URL) return;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        // WebSocket unavailable — keep polling as the fallback.
        return;
      }

      ws.onopen = () => {
        if (cancelled) return;
        wsReconnectAttempts = 0;
        ws?.send(JSON.stringify({ type: 'subscribe', room: `payment:${params.paymentId}` }));
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let payload: any;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!payload || payload.room !== `payment:${params.paymentId}`) return;
        const next = payload.data ?? payload.payment;
        if (!next) return;
        // A real-time status event arrived — stop polling and trust the socket.
        wsActive = true;
        setLiveConnected(true);
        stopPolling();
        setPollWarning('');
        setPayment((prev) => ({ ...(prev ?? {}), ...next } as Payment));
      };

      ws.onerror = () => {
        // Fall back to polling if the socket cannot be established.
        if (!wsActive) scheduleNext();
      };

      ws.onclose = () => {
        if (cancelled) return;
        setLiveConnected(false);
        if (wsActive) {
          // Lost a live connection — resume polling until we reconnect.
          wsActive = false;
          scheduleNext();
        }
        const delay = Math.min(1000 * 2 ** wsReconnectAttempts, WS_RECONNECT_MAX_MS);
        wsReconnectAttempts += 1;
        wsReconnectTimeout = setTimeout(connectWebSocket, delay);
      };
    };

    connectWebSocket();
    scheduleNext();

    return () => {
      cancelled = true;
      pollNowRef.current = null;
      if (timeout) clearTimeout(timeout);
      if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
    };
  }, [params.paymentId]);

  const expiresAt = payment ? computeExpiresAt(payment) : null;
  const isPending = payment?.status === 'pending';
  const remainingMs = expiresAt ? expiresAt.getTime() - now : 0;
  const isExpiredByClock = isPending && expiresAt ? remainingMs <= 0 : false;

  useEffect(() => {
    if (!isPending || !expiresAt) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [isPending, expiresAt]);

  // When the tab becomes visible again, background throttling may have left
  // `now` and the polled `payment` state out of sync. Recompute `now` and
  // trigger an immediate poll so the countdown matches the latest status.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      pollNowRef.current?.();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <XCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <p className="text-gray-600">
            {loadError ? 'Something went wrong loading this payment — try again' : 'Payment not found'}
          </p>
        </div>
      </div>
    );
  }

  const hasCryptoAmount = payment.amountXlm != null && payment.amountXlm > 0;
  const stellarUri = hasCryptoAmount
    ? `web+stellar:pay?destination=${encodeURIComponent(payment.stellarDepositAddress ?? '')}&amount=${encodeURIComponent(String(payment.amountXlm))}&memo=${encodeURIComponent(payment.stellarMemo)}&memo_type=text`
    : null;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-[92vw] xs:max-w-sm">
        <div className="p-4 xs:p-6 border-b border-gray-100 text-center">
          <p className="text-sm text-gray-500 font-medium">DupDub</p>
          <h1 className="text-3xl font-bold mt-1">{formatUsd(payment.amountUsd)}</h1>
          {payment.description && <p className="text-sm text-gray-500 mt-1 break-words">{payment.description}</p>}
        </div>

        <div className="p-4 xs:p-6">
          {isPending ? (
            <>
              {expiresAt && (
                <div className={`flex items-center justify-center gap-2 rounded-lg p-3 mb-4 text-sm font-semibold ${
                  isExpiredByClock ? 'bg-red-50 text-red-700 border border-red-200' : remainingMs < 60_000 ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-gray-100 text-gray-700 border border-gray-200'
                }`}>
                  {isExpiredByClock ? <AlertTriangle className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                  {isExpiredByClock ? 'This payment request has expired' : <>Expires in {formatRemaining(remainingMs)}</>}
                </div>
              )}

              <div className="flex items-center justify-center gap-2 mb-4 text-sm text-gray-500">
                <span className={`inline-block w-2 h-2 rounded-full ${liveConnected ? 'bg-green-500 animate-pulse' : 'bg-yellow-500 animate-pulse'}`} />
                <span>{liveConnected ? 'Live — waiting for payment...' : 'Waiting for payment...'}</span>
              </div>

              <div className="flex justify-center mb-4">
                {stellarUri ? (
                  <div
                    className="bg-white p-3 rounded-xl border border-gray-200"
                    role="img"
                    aria-label={`Stellar payment QR code for ${formatUsd(payment.amountUsd)}`}
                  >
                    <QRCodeSVG value={stellarUri} size={160} />
                  </div>
                ) : (
                  <div
                    data-testid="crypto-amount-pending"
                    className="bg-white p-6 rounded-xl border border-gray-200 flex flex-col items-center justify-center text-center space-y-2 w-44 h-44"
                  >
                    <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

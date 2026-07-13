'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type UazapiStatus = 'disconnected' | 'connecting' | 'connected';

interface UazapiConnectProps {
  /** Persisted status from the loaded whatsapp_config row. */
  initialStatus?: UazapiStatus;
  /** Paired number from the loaded row, if already connected. */
  initialWaNumber?: string | null;
  /** Called after a successful connect/disconnect so the parent can reload. */
  onChange?: () => void;
}

// Poll the live instance status this often while a pairing is in flight.
const STATUS_POLL_MS = 3000;
// UAZAPI QR codes expire after ~2 min; refresh well before that.
const QR_REFRESH_MS = 45000;

/** Normalize UAZAPI's qrcode field into a usable <img> src. */
function toQrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

/**
 * UAZAPI QR pairing panel. Self-contained: owns the connect → poll →
 * connected/disconnect lifecycle and talks only to /api/whatsapp/uazapi/*.
 * The Meta form is untouched; this renders in its place when the account's
 * provider is 'uazapi'.
 */
export function UazapiConnect({ initialStatus, initialWaNumber, onChange }: UazapiConnectProps) {
  const t = useTranslations('Settings.whatsapp');

  const [status, setStatus] = useState<UazapiStatus>(initialStatus ?? 'disconnected');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState<string | null>(initialWaNumber ?? null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Timers for the two independent loops (status poll + QR refresh). Kept
  // in refs so the cleanup effect can clear whatever is live.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopLoops = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    pollRef.current = null;
    qrTimerRef.current = null;
  }, []);

  // Clear timers on unmount.
  useEffect(() => stopLoops, [stopLoops]);

  const startConnect = useCallback(async (): Promise<boolean> => {
    const res = await fetch('/api/whatsapp/uazapi/connect', { method: 'POST' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || t('uazapiConnectFailed'));
      return false;
    }
    setQrCode(payload.qrCode ?? null);
    setStatus('connecting');
    return true;
  }, [t]);

  const pollStatus = useCallback(async () => {
    const res = await fetch('/api/whatsapp/uazapi/status');
    if (!res.ok) return;
    const payload = await res.json().catch(() => ({}));
    if (payload.status === 'connected') {
      stopLoops();
      setStatus('connected');
      setWaNumber(payload.waNumber ?? null);
      setQrCode(null);
      onChange?.();
    }
  }, [stopLoops, onChange]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const ok = await startConnect();
      if (!ok) return;
      stopLoops();
      // Loop 1: poll for the pairing to complete.
      pollRef.current = setInterval(pollStatus, STATUS_POLL_MS);
      // Loop 2: refresh the (short-lived) QR until connected.
      qrTimerRef.current = setInterval(() => {
        void startConnect();
      }, QR_REFRESH_MS);
    } finally {
      setConnecting(false);
    }
  }, [startConnect, pollStatus, stopLoops]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload?.error || 'Failed to disconnect.');
        return;
      }
      stopLoops();
      setStatus('disconnected');
      setQrCode(null);
      setWaNumber(null);
      onChange?.();
    } finally {
      setDisconnecting(false);
    }
  }, [stopLoops, onChange]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-foreground">{t('uazapiTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('uazapiDesc')}
            </CardDescription>
          </div>
          {status === 'connected' ? (
            <Badge className="bg-primary/15 text-primary border-primary/30">
              <CheckCircle2 className="size-3.5" />
              {t('uazapiConnected')}
            </Badge>
          ) : status === 'connecting' ? (
            <Badge variant="secondary">
              <Loader2 className="size-3.5 animate-spin" />
              {t('uazapiWaitingScan')}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {status === 'connected' ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
            <Smartphone className="size-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">{t('uazapiConnectedNumber')}</p>
              <p className="text-foreground font-medium">{waNumber || '—'}</p>
            </div>
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('uazapiDisconnecting')}
                </>
              ) : (
                t('uazapiDisconnect')
              )}
            </Button>
          </div>
        ) : (
          <>
            {qrCode ? (
              <div className="flex flex-col items-center gap-3 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={toQrSrc(qrCode)}
                  alt="WhatsApp QR code"
                  className="size-56 rounded-lg border border-border bg-white p-2"
                />
                <p className="text-sm text-muted-foreground text-center max-w-sm">
                  {t('uazapiScanHint')}
                </p>
                <Button variant="ghost" size="sm" onClick={handleConnect} disabled={connecting}>
                  <RefreshCw className="size-4" />
                  {t('uazapiRefreshQr')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 py-6">
                <QrCode className="size-12 text-muted-foreground" />
                <Button onClick={handleConnect} disabled={connecting}>
                  {connecting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('uazapiConnecting')}
                    </>
                  ) : (
                    <>
                      <QrCode className="size-4" />
                      {t('uazapiConnect')}
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

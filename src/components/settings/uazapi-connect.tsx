'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type UazapiStatus = 'disconnected' | 'connecting' | 'connected';

const MASKED_TOKEN = '••••••••••••••••';

interface UazapiConnectProps {
  initialStatus?: UazapiStatus;
  initialWaNumber?: string | null;
  initialBaseUrl?: string | null;
  hasSavedToken?: boolean;
  onChange?: () => void;
}

const STATUS_POLL_MS = 3000;
const QR_REFRESH_MS = 45000;

function toQrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

/**
 * UAZAPI QR pairing panel with per-account server config. Owns the
 * server-fields → save+connect → poll → connected/disconnect lifecycle,
 * talking only to /api/whatsapp/uazapi/*.
 */
export function UazapiConnect({
  initialStatus,
  initialWaNumber,
  initialBaseUrl,
  hasSavedToken,
  onChange,
}: UazapiConnectProps) {
  const t = useTranslations('Settings.whatsapp');

  const [status, setStatus] = useState<UazapiStatus>(initialStatus ?? 'disconnected');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState<string | null>(initialWaNumber ?? null);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? '');
  // Masked when a token is already saved; the user only re-enters it to change it.
  const [adminToken, setAdminToken] = useState(hasSavedToken ? MASKED_TOKEN : '');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopLoops = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    pollRef.current = null;
    qrTimerRef.current = null;
  }, []);

  useEffect(() => stopLoops, [stopLoops]);

  const startConnect = useCallback(async (): Promise<boolean> => {
    // Send credentials only when the user provided/changed them. A masked
    // token means "use the stored one" — never round-trip the secret.
    const payload: { baseUrl?: string; adminToken?: string } = {};
    if (baseUrl.trim()) payload.baseUrl = baseUrl.trim();
    if (adminToken && adminToken !== MASKED_TOKEN) payload.adminToken = adminToken;

    const res = await fetch('/api/whatsapp/uazapi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || t('uazapiConnectFailed'));
      return false;
    }
    setQrCode(data.qrCode ?? null);
    setStatus('connecting');
    return true;
  }, [baseUrl, adminToken, t]);

  const pollStatus = useCallback(async () => {
    const res = await fetch('/api/whatsapp/uazapi/status');
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.status === 'connected') {
      stopLoops();
      setStatus('connected');
      setWaNumber(data.waNumber ?? null);
      setQrCode(null);
      onChange?.();
    }
  }, [stopLoops, onChange]);

  const handleConnect = useCallback(async () => {
    // Require both fields when nothing is saved yet.
    if (!baseUrl.trim() || (!hasSavedToken && (!adminToken || adminToken === MASKED_TOKEN))) {
      toast.error(t('uazapiServerRequired'));
      return;
    }
    setConnecting(true);
    try {
      const ok = await startConnect();
      if (!ok) return;
      stopLoops();
      pollRef.current = setInterval(pollStatus, STATUS_POLL_MS);
      qrTimerRef.current = setInterval(() => {
        void startConnect();
      }, QR_REFRESH_MS);
    } finally {
      setConnecting(false);
    }
  }, [baseUrl, adminToken, hasSavedToken, startConnect, pollStatus, stopLoops, t]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to disconnect.');
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
              {baseUrl ? <p className="text-xs text-muted-foreground mt-1">{baseUrl}</p> : null}
            </div>
            <Button variant="outline" onClick={handleDisconnect} disabled={disconnecting}>
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
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="uazapi-base-url">{t('uazapiServerUrlLabel')}</Label>
                <Input
                  id="uazapi-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t('uazapiServerUrlPlaceholder')}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="uazapi-admin-token">{t('uazapiAdminTokenLabel')}</Label>
                <Input
                  id="uazapi-admin-token"
                  type="password"
                  value={adminToken}
                  onFocus={() => {
                    if (adminToken === MASKED_TOKEN) setAdminToken('');
                  }}
                  onChange={(e) => setAdminToken(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">{t('uazapiAdminTokenHint')}</p>
              </div>
            </div>

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
              <div className="flex justify-center py-2">
                <Button onClick={handleConnect} disabled={connecting}>
                  {connecting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('uazapiConnecting')}
                    </>
                  ) : (
                    <>
                      <QrCode className="size-4" />
                      {t('uazapiSaveAndConnect')}
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

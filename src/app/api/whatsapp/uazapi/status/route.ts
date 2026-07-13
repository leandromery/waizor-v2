import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Polled by the QR UI while pairing. Returns the live UAZAPI instance
 * status; on `connected`, persists `uazapi_status='connected'` and the
 * paired WhatsApp number so the Settings page reflects it after reload.
 *
 * Response: { status, waNumber?: string, profileName?: string }
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('provider, uazapi_base_url, uazapi_instance_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (
      !config ||
      config.provider !== 'uazapi' ||
      !config.uazapi_base_url ||
      !config.uazapi_instance_token
    ) {
      return NextResponse.json({ status: 'disconnected' })
    }

    const result = await getInstanceStatus({
      baseUrl: config.uazapi_base_url,
      token: decrypt(config.uazapi_instance_token),
    })

    const status = result.instance.status
    if (status === 'connected') {
      await supabase
        .from('whatsapp_config')
        .update({
          uazapi_status: 'connected',
          uazapi_wa_number: result.waNumber ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
    } else if (status === 'disconnected') {
      await supabase
        .from('whatsapp_config')
        .update({ uazapi_status: 'disconnected', updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
    }

    return NextResponse.json({
      status,
      waNumber: result.waNumber,
      profileName: result.instance.profileName,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

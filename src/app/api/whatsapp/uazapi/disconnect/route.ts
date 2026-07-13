import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { disconnectInstance } from '@/lib/whatsapp/uazapi-api'

/**
 * POST /api/whatsapp/uazapi/disconnect
 *
 * Logs the account's UAZAPI instance out of WhatsApp. Keeps the stored
 * instance id/token (so a later /connect can reuse it) but flips
 * uazapi_status to 'disconnected'. UAZAPI logout failures are non-fatal —
 * we still record the local disconnect.
 */
export async function POST() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('provider, uazapi_base_url, uazapi_instance_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config || config.provider !== 'uazapi') {
      return NextResponse.json({ error: 'No UAZAPI connection to disconnect.' }, { status: 400 })
    }

    if (config.uazapi_base_url && config.uazapi_instance_token) {
      try {
        await disconnectInstance({
          baseUrl: config.uazapi_base_url,
          token: decrypt(config.uazapi_instance_token),
        })
      } catch (err) {
        console.warn(
          '[uazapi/disconnect] UAZAPI logout failed (non-fatal):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const { error } = await supabase
      .from('whatsapp_config')
      .update({ uazapi_status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
    if (error) {
      console.error('[uazapi/disconnect] update failed:', error)
      return NextResponse.json({ error: 'Failed to update connection state.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

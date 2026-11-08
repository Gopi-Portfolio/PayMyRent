// The owner's UPI ID, saved once in the profile. Every tenant set to "UPI" pays this ID unless that tenant is given a different one.
// Changing it sends money somewhere new, so a new ID needs the one-time code; tenants who follow it are told.
import { useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { Button } from '@/components/Buttons';
import { useKnownUpi } from '@/components/PayHow';
import { ErrorBanner, Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { cleanUpi, upiValid } from '@/lib/upi';
import { brand } from '@/theme';

export function OwnerUpi() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const canEdit = me?.owner_accounts.find((o) => o.owner_account_id === owner)?.role === 'owner';
  const qc = useQueryClient();
  const q = useKnownUpi().data;
  const def = q?.default_upi_id ?? null;
  const [open, setOpen] = useState(false);
  const [upi, setUpi] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const isNew = upiValid(upi) && !(q?.upi_ids ?? []).includes(cleanUpi(upi));
  const ready = upiValid(upi) && cleanUpi(upi) !== def && (!isNew || otpReady(otp));

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/owner/upi-default', { method: 'PUT', ownerAccount: owner, body: { upi_id: cleanUpi(upi), otp_code: isNew ? otp : null } });
      setOpen(false); setUpi(''); setOtp('');
      qc.invalidateQueries({ queryKey: ['upi-ids'] });
      qc.invalidateQueries({ queryKey: ['tenancy'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Panel title={t('upiProfile.title')} icon="cellphone-check" tone="green">
      <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('upiProfile.explain')}</Text>
      <Text selectable style={{ fontWeight: '800', fontSize: 18, color: def ? brand.green600 : '#B45309' }} testID="profile-upi">{def ?? t('upiProfile.notSet')}</Text>
      {canEdit && !open ? <Button mode="outlined" icon="pencil-outline" onPress={() => setOpen(true)} testID="profile-upi-edit">{def ? t('payhow.change') : t('upiProfile.add')}</Button> : null}
      {open ? (
        <>
          <Field label={t('payhow.upiId')} value={upi} onChangeText={(v) => { setUpi(v.replace(/\s/g, '').toLowerCase()); setOtp(''); }} testID="profile-upi-input"
                 error={upi && !upiValid(upi) ? t('payhow.upiInvalid') : undefined} />
          {isNew ? <ActionOtp action="payout" code={otp} onChange={setOtp} ownerAccount={owner} /> : null}
          <ErrorBanner error={err} />
          <Button mode="contained" icon="check" onPress={save} loading={busy} disabled={busy || !ready} testID="profile-upi-save">{t('common.save')}</Button>
          <Button onPress={() => { setOpen(false); setErr(null); }}>{t('common.cancel')}</Button>
        </>
      ) : null}
    </Panel>
  );
}

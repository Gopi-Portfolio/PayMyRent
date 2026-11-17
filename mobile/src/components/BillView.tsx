// One compact monthly bill: previous dues + this month's lines − payments/credits = total due.
// Every number is the server's; the app only formats.
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { fmtDate, fmtMonth, monthEndIso } from '@/lib/dates';
import { Panel, StatusPill } from '@/components/ui';
import { ReliefSummary } from '@/components/RentRelief';
import { formatINR } from '@/lib/format';
import { brand, radius } from '@/theme';

const CATEGORY_ICON: Record<string, string> = {
  rent: 'home-city-outline', electricity: 'flash-outline', water: 'water-outline', maintenance: 'wrench-outline', misc: 'dots-horizontal-circle-outline',
};

export function BillView({ bill }: { bill: any }) {
  const { t } = useTranslation();
  if (!bill) return null;
  const s = bill.summary;
  const label = (c: string) => t(`bill.${c}`, { defaultValue: c });
  return (
    <View style={{ gap: 12 }}>
    <ReliefSummary bill={bill} />
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <View style={live.badge}><Icon source="receipt-text-outline" size={24} color={brand.teal700} /></View>
        <View style={{ flex: 1 }}>
          <Text variant="titleMedium" style={{ fontWeight: '800' }}>{t('bill.title', { month: fmtMonth(bill.period_month) })}</Text>
          <Text variant="bodySmall" style={{ color: brand.muted }}>{t('dates.period', { from: fmtDate(bill.period_month), to: fmtDate(monthEndIso(bill.period_month)) })}</Text>
          {bill.due_date ? <Text variant="bodySmall" style={{ color: brand.amber700, fontWeight: '700' }}>{t('dates.dueOn', { date: fmtDate(bill.due_date) })}</Text> : null}
          {bill.invoice_number ? <Text variant="bodySmall" style={{ color: brand.muted }}>{bill.invoice_number}</Text> : null}
        </View>
        <StatusPill status={bill.status} />
      </View>
      <View style={styles.rule} />
      {s.arrears_paise ? <Row icon="history" k={t('bill.arrears')} v={s.arrears_paise} /> : null}
      {bill.lines.map((l: any) => (
        <Row key={l.id} icon={CATEGORY_ICON[l.category] ?? 'cash'} k={`${label(l.category)}${l.kind !== 'charge' ? ` (${l.kind.replace('_', ' ')})` : ''}`} v={l.amount_paise}
             sub={l.description && l.description !== label(l.category) ? l.description : undefined} />
      ))}
      {s.later_months_open_paise ? <Row icon="calendar-clock" k={t('bill.later')} v={s.later_months_open_paise} /> : null}
      {s.paid_towards_this_month_paise ? <Row icon="check-circle-outline" k={t('bill.paid')} v={-s.paid_towards_this_month_paise} good /> : null}
      {s.advance_credit_paise ? <Row icon="piggy-bank-outline" k={t('bill.credit')} v={-s.advance_credit_paise} good /> : null}
      <View style={live.total}>
        <Text variant="titleMedium" style={{ fontWeight: '800' }}>{t('bill.totalDue')}</Text>
        <Text style={{ fontSize: 24, fontWeight: '800', color: s.total_due_paise > 0 ? brand.amber700 : brand.green600, fontVariant: ['tabular-nums'] }}>{formatINR(s.total_due_paise)}</Text>
      </View>
      {s.payable_now_paise !== undefined && s.payable_now_paise !== s.total_due_paise ? (
        <View style={{ marginTop: 8, gap: 2 }} testID="pay-now-split">
          <Row icon="cash-fast" k={t('relief.payNowRow')} v={s.payable_now_paise} strong />
          <Row icon="calendar-arrow-right" k={t('relief.laterRow')} v={s.total_due_paise - s.payable_now_paise} />
        </View>
      ) : null}
      {bill.submissions?.filter((x: any) => x.status === 'proposed').map((x: any) => (
        <View key={x.id} style={styles.proposed}>
          <Icon source="clock-outline" size={16} color={brand.amber700} />
          <Text variant="bodySmall" style={{ flex: 1 }}>{`${label(x.category)} ${formatINR(x.amount_paise)} — ${t('bill.proposed')}`}</Text>
        </View>
      ))}
    </Panel>
    </View>
  );
}

function Row({ k, v, sub, icon, good, strong }: { k: string; v: number; sub?: string; icon: string; good?: boolean; strong?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${k} ${formatINR(v)}`}>
      <View style={live.rowIcon}><Icon source={icon} size={18} color={good ? brand.green600 : brand.teal700} /></View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: strong ? '800' : '600' }}>{k}</Text>
        {sub ? <Text variant="bodySmall" style={{ color: brand.muted }}>{sub}</Text> : null}
      </View>
      <Text style={{ fontWeight: '800', color: good ? brand.green600 : brand.ink, fontVariant: ['tabular-nums'] }}>{formatINR(v)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rule: { height: 1, backgroundColor: brand.line, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: brand.line },
  proposed: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, padding: 10, backgroundColor: brand.amber100, borderRadius: radius.sm },
});

const live = {   // read when drawn, so they follow the role in use
  get badge(): ViewStyle { return { width: 46, height: 46, borderRadius: 15, backgroundColor: brand.teal100, alignItems: 'center', justifyContent: 'center' }; },
  get rowIcon(): ViewStyle { return { width: 32, height: 32, borderRadius: radius.sm, backgroundColor: brand.teal50, alignItems: 'center', justifyContent: 'center' }; },
  get total(): ViewStyle { return { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, padding: 14, backgroundColor: brand.teal50, borderRadius: radius.md }; },
};
